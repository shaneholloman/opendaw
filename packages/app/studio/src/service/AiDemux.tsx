import {createElement} from "@opendaw/lib-jsx"
import {
    Bytes,
    DefaultObservableValue,
    Errors,
    isAbsent,
    isDefined,
    isNull,
    Nullable,
    Option,
    RuntimeNotifier,
    UUID
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Files} from "@opendaw/lib-dom"
import {WavFile} from "@opendaw/lib-dsp"
// `@opendaw/lib-inference` is dynamically imported below — keep this as a
// type-only import, so Vite emits it as a separate chunk that loads on the
// first menu click instead of being pulled into the studio's boot bundle.
import type {Inference as InferenceNamespace, TaskKey} from "@opendaw/lib-inference"
import {AudioContentFactory, Project, ProjectMeta, ProjectProfile, Workers} from "@opendaw/studio-core"
import {InstrumentFactories, Sample} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"

type InferenceModule = typeof import("@opendaw/lib-inference")
let inferenceLib: Nullable<InferenceModule> = null

/**
 * Lazy-load `@opendaw/lib-inference` and install it (once) on first use.
 * Subsequent calls return the cached module reference. This keeps the
 * 30 KB-ish lib-inference chunk out of the studio's boot bundle.
 */
const ensureLib = async (): Promise<typeof InferenceNamespace> => {
    if (isNull(inferenceLib)) {
        inferenceLib = await import("@opendaw/lib-inference")
        inferenceLib.Inference.install({opfs: Workers.Opfs})
    }
    return inferenceLib.Inference
}

// AiDemux only ever picks a 4-stem separation model. Restrict the key type
// here so `Inference.run(model.key, ...)` infers `StemSeparationInput`/
// `StemSeparationOutput` instead of widening to the union of every
// registered task (which would include `audio-to-midi`).
type StemSeparationKey = Extract<TaskKey, `stem-separation${string}`>

interface ModelOption {
    readonly key: StemSeparationKey
    readonly label: string
    readonly description: string
}

const MODELS: ReadonlyArray<ModelOption> = [
    {
        key: "stem-separation",
        label: "htdemucs v4 (smank, MIT)",
        description: "Hybrid Transformer Demucs v4 — drums / bass / other / vocals.\nONNX export: smank/htdemucs-onnx. License: MIT."
    },
    {
        key: "stem-separation-alt",
        label: "htdemucs v4 (jackjiangxinfa, Apache-2.0)",
        description: "Same Demucs v4 architecture, alternate ONNX export.\nUseful for A/B comparing separation quality. License: Apache-2.0."
    }
]

const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const
type StemName = typeof STEM_NAMES[number]

const decodeAudioFile = async (file: File, sampleRate: number):
    Promise<{ audio: Float32Array, channels: 1 | 2, frames: number }> => {
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

const pickModel = async (Inference: typeof InferenceNamespace,
                         defaultKey: StemSeparationKey): Promise<Option<ModelOption>> => {
    const renderDescription = (model: ModelOption): string => {
        const size = Bytes.toString(Inference.modelDescriptor(model.key).bytes)
        return `${model.description}\n${size} one-time download.`
    }
    const select: HTMLSelectElement = (
        <select style={{font: "inherit", padding: "4px 8px", width: "100%"}}>
            {MODELS.map(model =>
                <option value={model.key} selected={model.key === defaultKey}>{model.label}</option>)}
        </select>
    ) as HTMLSelectElement
    const initial = MODELS.find(model => model.key === defaultKey)
    const descriptionEl: HTMLParagraphElement = (
        <p style={{margin: "8px 0 0", opacity: "0.7", fontSize: "12px", whiteSpace: "pre-line"}}>
            {isDefined(initial) ? renderDescription(initial) : ""}
        </p>
    ) as HTMLParagraphElement
    select.addEventListener("change", () => {
        const found = MODELS.find(model => model.key === select.value)
        descriptionEl.textContent = isDefined(found) ? renderDescription(found) : ""
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

        // 2. Lazy-load lib-inference so the model-selection dialog can show
        //    each model's actual size. The dialog is the first user-facing
        //    moment that needs the lib; loading here keeps the boot bundle
        //    free of lib-inference while still letting descriptions reflect
        //    `Inference.modelDescriptor(key).bytes`.
        const Inference = await ensureLib()

        // 3. Pick a model.
        const modelOption = await pickModel(Inference, "stem-separation")
        if (modelOption.isEmpty()) {return}
        const model = modelOption.unwrap()

        // 3. Ensure a project profile exists (mirrors importStems).
        if (!service.hasProfile) {
            service.projectProfileService.setValue(Option.wrap(
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
            const sizeLabel = Bytes.toString(Inference.modelDescriptor(model.key).bytes)
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
        }, {
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
        const stems = inferenceResult.value
        const importDialog = RuntimeNotifier.progress({
            headline: "AI Demux",
            message: "Importing stems..."
        })
        const project = service.project
        const sampleService = service.sampleService
        const importResults: Array<{ name: StemName, sample: Sample }> = []
        for (const stemName of STEM_NAMES) {
            const planar = stems[stemName].subarray(0, channels * frames)
            const arrayBuffer = WavFile.encodeInts16({
                sampleRate: 44100,
                length: frames,
                numberOfChannels: channels,
                getChannelData: (c: number) => planar.subarray(c * frames, (c + 1) * frames)
            })
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
    }
}