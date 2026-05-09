import {asDefined, clampUnit, panic} from "@opendaw/lib-std"
import {FFT, ResamplerMono} from "@opendaw/lib-dsp"
import {defineTask, TaskEnvironment} from "../Task"
import {tensor, TensorMap} from "../Tensor"

export interface TempoDetectionInput {
    /** Mono PCM. Sample rate must be a 1/2/4/8 multiple of 11025. */
    readonly audio: Float32Array
    readonly sampleRate: number
}

export interface TempoCandidate {
    readonly bpm: number
    readonly probability: number
}

export interface TempoDetectionOutput {
    readonly bpm: number
    /** Mass on the winning bin after averaging softmax across windows. */
    readonly confidence: number
    /** Top-N candidates by averaged softmax mass, sorted descending. Useful
     *  for diagnosing octave errors: if `bpm/2` or `bpm*2` shows up here
     *  with non-trivial probability, the model is doing its job and the
     *  pick is just the dominant octave. */
    readonly topCandidates: ReadonlyArray<TempoCandidate>
}

const TARGET_SR = 11025
const N_FFT = 1024
const HOP = 512
const N_MELS = 40
const FMIN_HZ = 20
const FMAX_HZ = 5000
const FRAMES_PER_WINDOW = 256
// Stride between successive 256-frame inference windows (frames). Matches
// `hop_length=128` in `tempocnn/feature.py:read_features`, i.e. 50 % overlap.
// More windows = smoother softmax averaging.
const WINDOW_STRIDE_FRAMES = 128
const BPM_OFFSET = 30
const BPM_BINS = 256

const RESAMPLE_CHUNK_OUT = 128

export const TempoDetectionTask = defineTask<TempoDetectionInput, TempoDetectionOutput>({
    key: "tempo-detection",
    model: {
        // TempoCNN cnn.h5 (Schreiber & Müller, default global-tempo classifier,
        // AGPL-3.0). Upstream is Keras .h5; this ONNX is produced by tf2onnx
        // (see scripts/download-inference-models.sh `convert_tempo_cnn`).
        // Input  [N, 40, 256, 1]  — 40 mel bands × 256 frames × 1 channel
        // Output [N, 256]          — softmax over BPM bins 30..285 (1 BPM step)
        url: "https://assets.opendaw.studio/models/tempo-cnn/v0/model.onnx",
        sha256: "38b4915b35c46f72e072a7c93ab4b7e280404133e2ca94f9cbcf5ace15c7a321",
        bytes: 11_705_795,
        version: "v0-cnn"
    },
    executionProviders: ["wasm"],
    async run(input: TempoDetectionInput, env: TaskEnvironment): Promise<TempoDetectionOutput> {
        env.signal.match({none: () => {}, some: signal => signal.throwIfAborted()})
        const audio = downsampleTo11025(input.audio, input.sampleRate)
        const numFrames = Math.max(0, Math.floor((audio.length - N_FFT) / HOP) + 1)
        if (numFrames === 0) {
            return panic(`Audio too short for tempo detection (need ≥${N_FFT / TARGET_SR}s at 11025 Hz, got ${audio.length} samples)`)
        }
        const mel = computeMelSpectrogram(audio, numFrames)
        const inputName = asDefined(env.inputNames[0], "tempo-cnn: missing input name")
        const outputName = asDefined(env.outputNames[0], "tempo-cnn: missing output name")
        const accumulated = new Float64Array(BPM_BINS)
        const numWindows = numFrames < FRAMES_PER_WINDOW
            ? 1
            : Math.floor((numFrames - FRAMES_PER_WINDOW) / WINDOW_STRIDE_FRAMES) + 1
        for (let windowIndex = 0; windowIndex < numWindows; windowIndex++) {
            env.signal.match({none: () => {}, some: signal => signal.throwIfAborted()})
            const startFrame = windowIndex * WINDOW_STRIDE_FRAMES
            const tile = packWindow(mel, startFrame, numFrames)
            const feeds: TensorMap = {
                [inputName]: tensor("float32", tile, [1, N_MELS, FRAMES_PER_WINDOW, 1])
            }
            const output = await env.session(feeds)
            const probs = asDefined(output[outputName], `tempo-cnn: missing output '${outputName}'`).data as Float32Array
            for (let bin = 0; bin < BPM_BINS; bin++) accumulated[bin] += probs[bin]
            env.progress(clampUnit((windowIndex + 1) / numWindows))
        }
        const averaged = new Float32Array(BPM_BINS)
        for (let bin = 0; bin < BPM_BINS; bin++) averaged[bin] = accumulated[bin] / numWindows
        const topCandidates = topN(averaged, 3)
        const winner = topCandidates[0]
        return {
            bpm: winner.bpm,
            confidence: clampUnit(winner.probability),
            topCandidates
        }
    }
})

const topN = (probs: Float32Array, n: number): ReadonlyArray<TempoCandidate> => {
    const indices = Array.from({length: probs.length}, (_, index) => index)
    indices.sort((leftIndex, rightIndex) => probs[rightIndex] - probs[leftIndex])
    return indices.slice(0, n).map((index): TempoCandidate => ({
        bpm: BPM_OFFSET + index,
        probability: probs[index]
    }))
}

// 4× / 2× / 1× polyphase decimation to 11025 Hz. Other sample rates are
// rejected to keep the model's mel filterbank aligned with what it was
// trained against (40 bands across 0..5512.5 Hz).
const downsampleTo11025 = (audio: Float32Array, sampleRate: number): Float32Array => {
    if (sampleRate === TARGET_SR) {return audio}
    const ratio = sampleRate / TARGET_SR
    if (ratio !== 2 && ratio !== 4 && ratio !== 8) {
        return panic(`tempo-cnn requires sampleRate to be 11025, 22050, 44100, or 88200 Hz — got ${sampleRate}`)
    }
    const factor = ratio as 2 | 4 | 8
    const resampler = new ResamplerMono(factor)
    const outputLength = Math.floor(audio.length / factor)
    const out = new Float32Array(outputLength)
    let written = 0
    while (written < outputLength) {
        const chunkOut = Math.min(RESAMPLE_CHUNK_OUT, outputLength - written)
        resampler.downsample(audio.subarray(written * factor, (written + chunkOut) * factor),
            out, written, written + chunkOut)
        written += chunkOut
    }
    return out
}

// Mirrors `librosa.feature.melspectrogram(power=1, n_fft=1024, hop_length=512,
// n_mels=40, fmin=20, fmax=5000)` from `tempocnn/feature.py:read_features`.
// CRITICAL: TempoCNN feeds the linear *magnitude* mel-spectrogram to the
// model — no `power_to_db`, no log, no normalization. Adding any of those
// catastrophically corrupts the input distribution and the model produces
// garbage (verified empirically: drums-stem reported 49 BPM on a 155-BPM
// track when log-dB normalization was applied).
const computeMelSpectrogram = (audio: Float32Array, numFrames: number): Float32Array => {
    const fft = new FFT(N_FFT)
    const window = hannWindow(N_FFT)
    const real = new Float32Array(N_FFT)
    const imag = new Float32Array(N_FFT)
    const numBins = N_FFT / 2 + 1
    const melWeights = melFilterbank(TARGET_SR, N_FFT, N_MELS, FMIN_HZ, FMAX_HZ)
    const mel = new Float32Array(numFrames * N_MELS)
    for (let frame = 0; frame < numFrames; frame++) {
        const start = frame * HOP
        for (let i = 0; i < N_FFT; i++) {
            real[i] = audio[start + i] * window[i]
            imag[i] = 0
        }
        fft.process(real, imag)
        for (let melIndex = 0; melIndex < N_MELS; melIndex++) {
            let sum = 0
            const weightOffset = melIndex * numBins
            for (let bin = 0; bin < numBins; bin++) {
                const magnitude = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin])
                sum += magnitude * melWeights[weightOffset + bin]
            }
            mel[frame * N_MELS + melIndex] = sum
        }
    }
    return mel
}

// Build a [40, 256, 1] Float32Array for one inference window in NHWC layout
// (TF/Keras convention preserved by tf2onnx). For audio shorter than
// FRAMES_PER_WINDOW we zero-pad the right edge — silence in mel-magnitude
// space is exactly zero, which is what `_ensure_length` does upstream.
const packWindow = (mel: Float32Array, startFrame: number, numFrames: number): Float32Array => {
    const tile = new Float32Array(N_MELS * FRAMES_PER_WINDOW)
    const usableFrames = Math.min(FRAMES_PER_WINDOW, numFrames - startFrame)
    for (let melIndex = 0; melIndex < N_MELS; melIndex++) {
        const tileRowOffset = melIndex * FRAMES_PER_WINDOW
        for (let f = 0; f < usableFrames; f++) {
            tile[tileRowOffset + f] = mel[(startFrame + f) * N_MELS + melIndex]
        }
    }
    return tile
}

const hannWindow = (n: number): Float32Array => {
    // Periodic Hann (`scipy.signal.get_window('hann', N, fftbins=True)`),
    // which is what librosa.stft uses by default. The symmetric variant
    // (divisor n-1) would shift the window energy slightly and mismatch
    // the model's training-time spectrogram.
    const window = new Float32Array(n)
    for (let i = 0; i < n; i++) {
        window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n))
    }
    return window
}

// Slaney mel scale (librosa default). Returns a [N_MELS × numBins]
// row-major matrix of triangular filter weights, area-normalized to
// 2 / (right_hz - left_hz) — librosa's "slaney" filterbank norm.
const melFilterbank = (sampleRate: number, nFft: number, nMels: number,
                       fmin: number, fmax: number): Float32Array => {
    const numBins = nFft / 2 + 1
    const fSp = 200 / 3
    const minLogHz = 1000
    const minLogMel = minLogHz / fSp
    const stepLog = Math.log(6.4) / 27
    const hzToMel = (hz: number) =>
        hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / stepLog
    const melToHz = (mel: number) =>
        mel < minLogMel ? mel * fSp : minLogHz * Math.exp(stepLog * (mel - minLogMel))
    const melMin = hzToMel(fmin)
    const melMax = hzToMel(fmax)
    const hzPoints = new Float64Array(nMels + 2)
    const binPoints = new Float64Array(nMels + 2)
    for (let i = 0; i < nMels + 2; i++) {
        const m = melMin + (melMax - melMin) * i / (nMels + 1)
        hzPoints[i] = melToHz(m)
        binPoints[i] = hzPoints[i] * nFft / sampleRate
    }
    const weights = new Float32Array(nMels * numBins)
    for (let melIndex = 0; melIndex < nMels; melIndex++) {
        const left = binPoints[melIndex]
        const peak = binPoints[melIndex + 1]
        const right = binPoints[melIndex + 2]
        const enorm = 2 / (hzPoints[melIndex + 2] - hzPoints[melIndex])
        const offset = melIndex * numBins
        for (let bin = 0; bin < numBins; bin++) {
            let weight = 0
            if (bin > left && bin < peak) {
                weight = (bin - left) / (peak - left)
            } else if (bin >= peak && bin < right) {
                weight = (right - bin) / (right - peak)
            }
            weights[offset + bin] = weight * enorm
        }
    }
    return weights
}
