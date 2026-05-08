import {createElement} from "@opendaw/lib-jsx"
import {DefaultObservableValue, EmptyExec, isAbsent, isDefined, Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {Inference, TaskKey} from "@opendaw/lib-inference"
import {Errors} from "@opendaw/lib-std"
import {AudioContentFactory} from "@opendaw/studio-core"
import {InstrumentFactories, Sample} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {ProjectMeta} from "@opendaw/studio-core"
import {Project} from "@opendaw/studio-core"
import {ProjectProfile} from "@opendaw/studio-core"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"

interface ModelOption {
    readonly key: TaskKey
    readonly label: string
    readonly description: string
}

const MODELS: ReadonlyArray<ModelOption> = [
    {
        key: "stem-separation",
        label: "htdemucs v4 (smank, MIT)",
        description: "Hybrid Transformer Demucs v4 — drums / bass / other / vocals.\nONNX export: smank/htdemucs-onnx. License: MIT.\n~300 MB one-time download."
    },
    {
        key: "stem-separation-alt",
        label: "htdemucs v4 (jackjiangxinfa, Apache-2.0)",
        description: "Same Demucs v4 architecture, alternate ONNX export.\nUseful for A/B comparing separation quality.\nLicense: Apache-2.0. ~300 MB one-time download."
    }
]

const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const
type StemName = typeof STEM_NAMES[number]

// SI decimal units (MB = 1,000,000 bytes), matching the convention used by
// macOS / Hugging Face / most CDNs when reporting "file size".
const formatBytes = (bytes: number): string => {
    if (bytes < 1_000) {return `${bytes} B`}
    if (bytes < 1_000_000) {return `${Math.round(bytes / 1_000)} KB`}
    if (bytes < 1_000_000_000) {return `${Math.round(bytes / 1_000_000)} MB`}
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

const encodeWav16 = (planar: Float32Array, channels: number, sampleRate: number): ArrayBuffer => {
    const numFrames = Math.floor(planar.length / channels)
    const dataSize = numFrames * channels * 2
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)
    let offset = 0
    const writeStr = (str: string) => {
        for (let i = 0; i < str.length; i++) {view.setUint8(offset + i, str.charCodeAt(i))}
        offset += str.length
    }
    writeStr("RIFF")
    view.setUint32(offset, 36 + dataSize, true); offset += 4
    writeStr("WAVE")
    writeStr("fmt ")
    view.setUint32(offset, 16, true); offset += 4
    view.setUint16(offset, 1, true); offset += 2
    view.setUint16(offset, channels, true); offset += 2
    view.setUint32(offset, sampleRate, true); offset += 4
    view.setUint32(offset, sampleRate * channels * 2, true); offset += 4
    view.setUint16(offset, channels * 2, true); offset += 2
    view.setUint16(offset, 16, true); offset += 2
    writeStr("data")
    view.setUint32(offset, dataSize, true); offset += 4
    for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < channels; c++) {
            const value = planar[c * numFrames + i]
            const clamped = Math.max(-1, Math.min(1, value))
            view.setInt16(offset, Math.round(clamped * 0x7fff), true)
            offset += 2
        }
    }
    return buffer
}

const decodeAudioFile = async (file: File, sampleRate: number):
    Promise<{audio: Float32Array, channels: 1 | 2, frames: number}> => {
    const arrayBuffer = await file.arrayBuffer()
    const ctx = new AudioContext({sampleRate})
    const decoded = await ctx.decodeAudioData(arrayBuffer)
    await ctx.close()
    const channels: 1 | 2 = decoded.numberOfChannels >= 2 ? 2 : 1
    const frames = decoded.length
    const planar = new Float32Array(channels * frames)
    for (let c = 0; c < channels; c++) {
        const sourceChannel = decoded.numberOfChannels >= 2 ? decoded.getChannelData(c) : decoded.getChannelData(0)
        planar.set(sourceChannel, c * frames)
    }
    return {audio: planar, channels, frames}
}

const interleavedToPlanar = (planar: Float32Array, channels: number, frames: number): Float32Array =>
    planar.subarray(0, channels * frames)

const pickModel = async (defaultKey: TaskKey): Promise<Option<ModelOption>> => {
    const select: HTMLSelectElement = (
        <select style={{font: "inherit", padding: "4px 8px", width: "100%"}}>
            {MODELS.map(model =>
                <option value={model.key} selected={model.key === defaultKey}>{model.label}</option>)}
        </select>
    ) as HTMLSelectElement
    const descriptionEl: HTMLParagraphElement = (
        <p style={{margin: "8px 0 0", opacity: "0.7", fontSize: "12px", whiteSpace: "pre-line"}}>
            {MODELS.find(model => model.key === defaultKey)?.description ?? ""}
        </p>
    ) as HTMLParagraphElement
    select.addEventListener("change", () => {
        const found = MODELS.find(model => model.key === select.value)
        descriptionEl.textContent = found?.description ?? ""
    })
    // Dialogs.show only resolves via its built-in primary button; rely on
    // okText to render "Separate" and read the select value once the
    // promise resolves. (Custom buttons close the dialog but don't trigger
    // the resolve closure.)
    const result = await Promises.tryCatch(Dialogs.show({
        headline: "AI Demux",
        content: (
            <div style={{display: "flex", flexDirection: "column", gap: "8px", minWidth: "360px"}}>
                <label>Model</label>
                {select}
                {descriptionEl}
            </div>
        ),
        okText: "Separate",
        cancelable: true
    }))
    if (result.status === "rejected") {return Option.None}
    const found = MODELS.find(model => model.key === select.value)
    return isDefined(found) ? Option.wrap(found) : Option.None
}

export namespace AiDemux {
    export const run = async (service: StudioService): Promise<void> => {
        // 1. Pick the audio file first. Accept any format the browser can decode.
        const fileResult = await Promises.tryCatch(Files.open({
            types: [{
                description: "audio",
                accept: {"audio/*": [".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"]}
            }]
        }))
        if (fileResult.status === "rejected") {return}
        const file = fileResult.value.at(0)
        if (isAbsent(file)) {return}

        // 2. Pick a model.
        const modelOption = await pickModel("stem-separation")
        if (modelOption.isEmpty()) {return}
        const model = modelOption.unwrap()

        // 3. Ensure a project profile exists (mirrors importStems).
        if (!service.hasProfile) {
            (service as unknown as {projectProfileService: {setValue(v: Option<ProjectProfile>): void}})
                .projectProfileService.setValue(Option.wrap(
                    new ProjectProfile(UUID.generate(), Project.new(service), ProjectMeta.init("Untitled"), Option.None)))
        }

        // 4. Decode the audio file at 44.1 kHz.
        const decoded = await Promises.tryCatch(decodeAudioFile(file, 44100))
        if (decoded.status === "rejected") {
            await RuntimeNotifier.info({headline: "AI Demux", message: `Could not decode audio: ${decoded.error}`})
            return
        }
        const {audio, channels, frames} = decoded.value

        // 5a. Download dialog (only if the model is not already cached).
        const cached = await Inference.isCached(model.key)
        if (!cached) {
            const dlProgress = new DefaultObservableValue<number>(0)
            const dlController = new AbortController()
            const sizeLabel = formatBytes(Inference.modelDescriptor(model.key).bytes)
            const dlDialog = RuntimeNotifier.progress({
                headline: "Downloading model",
                message: `${sizeLabel}, one-time`,
                progress: dlProgress,
                cancel: () => dlController.abort(Errors.AbortError)
            })
            const preloadResult = await Promises.tryCatch(Inference.preload(model.key, {
                progress: value => dlProgress.setValue(value),
                signal: dlController.signal
            }))
            dlDialog.terminate()
            if (preloadResult.status === "rejected") {
                const isAbort = preloadResult.error === Errors.AbortError
                    || (preloadResult.error instanceof Error && preloadResult.error.name === "AbortError")
                if (!isAbort) {
                    await RuntimeNotifier.info({
                        headline: "Model download failed",
                        message: String(preloadResult.error)
                    })
                }
                return
            }
        } else {
            // Cached: download is instant, but worker session creation takes
            // several seconds for a 300 MB model (shader compile + GPU memory
            // setup). Show an indeterminate-progress dialog so the user has
            // visual feedback during the wait.
            //
            // Cancel here can't actually interrupt InferenceSession.create
            // (ORT doesn't accept an AbortSignal at session-create time), but
            // we race the user's abort against the preload promise so cancel
            // immediately returns control to the user. The worker may keep
            // loading in the background; the next preload call will then
            // resolve instantly because the session is already in the cache.
            const loadController = new AbortController()
            const loadDialog = RuntimeNotifier.progress({
                headline: "Loading model",
                cancel: () => loadController.abort(Errors.AbortError)
            })
            const sessionResult = await Promises.tryCatch(Promise.race([
                Inference.preload(model.key, {signal: loadController.signal}),
                new Promise<never>((_, reject) => loadController.signal.addEventListener(
                    "abort", () => reject(Errors.AbortError), {once: true}))
            ]))
            loadDialog.terminate()
            if (sessionResult.status === "rejected") {
                const isAbort = sessionResult.error === Errors.AbortError
                    || (sessionResult.error instanceof Error && sessionResult.error.name === "AbortError")
                if (!isAbort) {
                    await RuntimeNotifier.info({
                        headline: "AI Demux failed",
                        message: `Could not load model session: ${sessionResult.error}`
                    })
                }
                return
            }
        }

        // 5b. Separate dialog. Session is loaded, so downloadShare=0 maps the
        // dialog's 0..1 directly to inference progress.
        const sepProgress = new DefaultObservableValue<number>(0)
        const sepController = new AbortController()
        const sepDialog = RuntimeNotifier.progress({
            headline: "Separating stems",
            progress: sepProgress,
            cancel: () => sepController.abort(Errors.AbortError)
        })
        const inferenceResult = await Promises.tryCatch(Inference.run(model.key, {
            audio, channels, sampleRate: 44100
        } as never, {
            progress: value => sepProgress.setValue(value),
            signal: sepController.signal,
            downloadShare: 0
        }))
        sepDialog.terminate()

        if (inferenceResult.status === "rejected") {
            const isAbort = inferenceResult.error === Errors.AbortError
                || (inferenceResult.error instanceof Error && inferenceResult.error.name === "AbortError")
            if (!isAbort) {
                await RuntimeNotifier.info({
                    headline: "AI Demux failed",
                    message: String(inferenceResult.error)
                })
            }
            return
        }

        // 6. Import each stem and create a Tape track per stem (mirrors importStems).
        const stems = inferenceResult.value as unknown as Record<StemName, Float32Array> & {
            sampleRate: number, channels: 1 | 2
        }
        const importDialog = RuntimeNotifier.progress({
            headline: "AI Demux",
            message: "Importing stems..."
        })
        const project = service.project
        const sampleService = (service as unknown as {sampleService: typeof service["sampleService"]}).sampleService
        const importResults: Array<{name: StemName, sample: Sample}> = []
        for (const stemName of STEM_NAMES) {
            const planar = interleavedToPlanar(stems[stemName], channels, frames)
            const arrayBuffer = encodeWav16(planar, channels, 44100)
            const importResult = await Promises.tryCatch(sampleService.importFile({
                name: stemName,
                arrayBuffer
            }))
            if (importResult.status === "rejected") {
                console.warn(`Failed to import stem ${stemName}`, importResult.error)
                continue
            }
            const sample = importResult.value
            await Promises.tryCatch(service.sampleManager.getAudioData(UUID.parse(sample.uuid)))
            importResults.push({name: stemName, sample})
        }
        importDialog.terminate()

        // 7. Create the audio units inside one editing transaction.
        const {editing, boxGraph, api} = project
        editing.modify(() => {
            for (const {name, sample} of importResults) {
                const {trackBox, instrumentBox} = api.createInstrument(InstrumentFactories.Tape)
                instrumentBox.label.setValue(name)
                const uuid = UUID.parse(sample.uuid)
                const audioFileBox = boxGraph.findBox<AudioFileBox>(uuid)
                    .unwrapOrElse(() => AudioFileBox.create(boxGraph, uuid, box => {
                        box.fileName.setValue(name)
                        box.startInSeconds.setValue(0)
                        box.endInSeconds.setValue(sample.duration)
                    }))
                AudioContentFactory.createNotStretchedRegion({
                    boxGraph, sample, audioFileBox, position: 0, targetTrack: trackBox
                })
            }
        })

        await RuntimeNotifier.info({
            headline: "AI Demux complete",
            message: `Separated ${importResults.length} stem(s) from "${file.name}".`
        }).catch(EmptyExec)
    }
}
