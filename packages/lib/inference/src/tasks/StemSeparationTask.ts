import {clampUnit, panic, unitValue} from "@opendaw/lib-std"
import {defineTask} from "../Task"
import {tensor, TensorMap} from "../Tensor"

export interface StemSeparationInput {
    readonly audio: Float32Array              // mono or interleaved stereo, fixed at 44100 Hz
    readonly channels: 1 | 2
    readonly sampleRate: number               // expected: 44100
}

export interface StemSeparationOutput {
    readonly drums: Float32Array
    readonly bass: Float32Array
    readonly other: Float32Array
    readonly vocals: Float32Array
    readonly sampleRate: number
    readonly channels: 1 | 2
}

const HTDEMUCS_SAMPLE_RATE = 44100
const HTDEMUCS_SEGMENT_SECONDS = 7.8
const HTDEMUCS_OVERLAP_SECONDS = 0.25
const HTDEMUCS_INPUT_NAME = "mix"
const HTDEMUCS_OUTPUT_NAMES = ["drums", "bass", "other", "vocals"] as const

const segmentSamples = (sampleRate: number) => Math.round(HTDEMUCS_SEGMENT_SECONDS * sampleRate)
const overlapSamples = (sampleRate: number) => Math.round(HTDEMUCS_OVERLAP_SECONDS * sampleRate)

/**
 * Split a single channel into overlapping windows of `windowSize` samples
 * with `overlap` samples shared between consecutive windows. The last
 * window is right-padded with zeros if the input length does not divide
 * evenly. Returns the list of window starts and the padded length so the
 * combiner can trim the result back to the original length.
 */
export const planChunks = (length: number,
                           windowSize: number,
                           overlap: number): {starts: ReadonlyArray<number>, padded: number} => {
    if (windowSize <= overlap) {return panic("windowSize must exceed overlap")}
    const stride = windowSize - overlap
    if (length === 0) {return {starts: [], padded: 0}}
    const starts: Array<number> = []
    let position = 0
    while (position + windowSize <= length) {
        starts.push(position)
        position += stride
    }
    if (starts.length === 0 || starts[starts.length - 1] + windowSize < length) {
        starts.push(Math.max(0, length - windowSize))
    }
    const padded = starts[starts.length - 1] + windowSize
    return {starts, padded: Math.max(padded, length)}
}

/**
 * Apply a triangular fade over the overlap region when stitching window N's
 * tail with window N+1's head. Returns a per-sample weight in 0..1 for
 * window N's samples in the overlap region.
 */
export const overlapFade = (overlap: number, indexInOverlap: number): unitValue =>
    overlap === 0 ? 1.0 : clampUnit(1.0 - indexInOverlap / overlap)

/**
 * Combine per-window stem outputs back into one continuous stream using
 * triangular cross-fade in the overlap regions. Each boundary's overlap
 * size is derived from the actual window starts (not assumed uniform),
 * so a shifted last window with a wider partial overlap is handled
 * correctly.
 */
export const combineWindows = (
    windows: ReadonlyArray<Float32Array>,
    starts: ReadonlyArray<number>,
    _hint: number,
    totalLength: number
): Float32Array => {
    const out = new Float32Array(totalLength)
    if (windows.length === 0) {return out}
    const last = windows.length - 1
    const leftOverlapOf = (windowIndex: number, length: number): number => {
        if (windowIndex === 0) {return 0}
        const prevStart = starts[windowIndex - 1]
        const prevEnd = prevStart + windows[windowIndex - 1].length
        return Math.max(0, Math.min(length, prevEnd - starts[windowIndex]))
    }
    const rightOverlapOf = (windowIndex: number, length: number): number => {
        if (windowIndex === last) {return 0}
        const currEnd = starts[windowIndex] + length
        const nextStart = starts[windowIndex + 1]
        return Math.max(0, Math.min(length, currEnd - nextStart))
    }
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
        const window = windows[windowIndex]
        const start = starts[windowIndex]
        const leftOverlap = leftOverlapOf(windowIndex, window.length)
        const rightOverlap = rightOverlapOf(windowIndex, window.length)
        for (let i = 0; i < window.length; i++) {
            const target = start + i
            if (target < 0 || target >= totalLength) {continue}
            const inLeftOverlap = leftOverlap > 0 && i < leftOverlap
            const inRightOverlap = rightOverlap > 0 && i >= window.length - rightOverlap
            if (inLeftOverlap) {
                const weight = 1 - overlapFade(leftOverlap, i)
                out[target] += window[i] * weight
            } else if (inRightOverlap) {
                const offset = i - (window.length - rightOverlap)
                const weight = overlapFade(rightOverlap, offset)
                out[target] += window[i] * weight
            } else {
                out[target] = window[i]
            }
        }
    }
    return out
}

export const StemSeparationTask = defineTask<StemSeparationInput, StemSeparationOutput>({
    key: "stem-separation",
    model: {
        // Pinned by commit SHA so the file is immutable even if the upstream
        // repo is updated. Replace by re-running scripts/download-inference-models.sh
        // with HTDEMUCS_URL pointing at a fresh commit if the upstream changes.
        url: "https://huggingface.co/ModernMube/HTDemucs_onnx/resolve/edd8347a8191d6b73635675688d01e125d3ae336/htdemucs.onnx",
        sha256: "ac056d976fbcf300dbc9e5ae6c1e7c8e7eb9a0ee9000e0449d993e3edef797d6",
        bytes: 174_490_597,
        version: "v4"
    },
    executionProviders: ["webgpu", "wasm"],
    async run(input, env) {
        if (input.sampleRate !== HTDEMUCS_SAMPLE_RATE) {
            return panic(`htdemucs requires ${HTDEMUCS_SAMPLE_RATE} Hz; got ${input.sampleRate}`)
        }
        const channels = input.channels
        const samplesPerChannel = input.audio.length / channels
        const window = segmentSamples(input.sampleRate)
        const overlap = overlapSamples(input.sampleRate)
        const plan = planChunks(samplesPerChannel, window, overlap)

        // Per-stem accumulators, one Float32Array per stem, channel-interleaved.
        const stemWindows: Record<string, Array<Float32Array>> = {
            drums: [], bass: [], other: [], vocals: []
        }

        for (let chunkIndex = 0; chunkIndex < plan.starts.length; chunkIndex++) {
            env.signal.match({
                none: () => {},
                some: (signal: AbortSignal) => {
                    if (signal.aborted) {return panic("Cancelled")}
                }
            })
            const start = plan.starts[chunkIndex]
            const chunk = new Float32Array(channels * window)
            for (let i = 0; i < window; i++) {
                const sourceIndex = start + i
                for (let channel = 0; channel < channels; channel++) {
                    const value = sourceIndex < samplesPerChannel
                        ? input.audio[sourceIndex * channels + channel]
                        : 0
                    chunk[channel * window + i] = value
                }
            }
            const feeds: TensorMap = {
                [HTDEMUCS_INPUT_NAME]: tensor("float32", chunk, [1, channels, window])
            }
            const output = await env.session(feeds)
            for (const stem of HTDEMUCS_OUTPUT_NAMES) {
                const stemTensor = output[stem]
                if (stemTensor === undefined) {return panic(`Missing output: ${stem}`)}
                const stemData = stemTensor.data as Float32Array
                stemWindows[stem].push(stemData)
            }
            env.progress(clampUnit((chunkIndex + 1) / plan.starts.length))
        }

        const totalLength = samplesPerChannel * channels
        const stems: Record<string, Float32Array> = {}
        for (const stem of HTDEMUCS_OUTPUT_NAMES) {
            stems[stem] = combineWindows(stemWindows[stem], plan.starts.map(s => s * channels), overlap * channels, totalLength)
        }

        return {
            drums: stems.drums,
            bass: stems.bass,
            other: stems.other,
            vocals: stems.vocals,
            sampleRate: input.sampleRate,
            channels
        }
    }
})
