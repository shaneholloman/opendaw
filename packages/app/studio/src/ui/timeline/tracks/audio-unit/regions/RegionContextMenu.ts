import {Bytes, DefaultObservableValue, EmptyExec, Errors, isInstanceOf, RuntimeNotifier, Selection, Terminable}
    from "@opendaw/lib-std"
import {
    AudioConsolidation,
    AudioContentModifier,
    ContextMenu,
    ElementCapturing,
    MenuItem,
    TimelineRange
} from "@opendaw/studio-core"
import {AnyRegionBoxAdapter, AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {RegionCaptureTarget} from "@/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts"
import {TimelineBox} from "@opendaw/studio-boxes"
import {Surface} from "@/ui/surface/Surface.tsx"
import {RegionTransformer} from "@/ui/timeline/tracks/audio-unit/regions/RegionTransformer.ts"
import {NameValidator} from "@/ui/validator/name.ts"
import {DebugMenus} from "@/ui/menu/debug"
import {NoteMidiExport} from "@opendaw/studio-core"
import {ColorMenu} from "@/ui/timeline/ColorMenu"
import {BPMTools} from "@opendaw/lib-dsp"
import {Browser} from "@opendaw/lib-dom"
import {Dialogs} from "@/ui/components/dialogs.tsx"
import {StudioService} from "@/service/StudioService"
import {Promises} from "@opendaw/lib-runtime"
import {RegionsShortcuts} from "@/ui/shortcuts/RegionsShortcuts"
import {ensureInference} from "@/service/InferenceLoader"

type Construct = {
    element: Element
    service: StudioService
    capturing: ElementCapturing<RegionCaptureTarget>
    selection: Selection<AnyRegionBoxAdapter>
    timelineBox: TimelineBox
    range: TimelineRange
}

export const installRegionContextMenu =
    ({element, service, capturing, selection, timelineBox, range}: Construct): Terminable => {
        const {project} = service
        const {editing, selection: vertexSelection} = project
        const computeSelectionRange = () => selection.selected().reduce((range, region) => {
            range[0] = Math.min(region.position, range[0])
            range[1] = Math.max(region.complete, range[1])
            return range
        }, [Number.MAX_VALUE, -Number.MAX_VALUE])
        return ContextMenu.subscribe(element, ({addItems, client}: ContextMenu.Collector) => {
            const target = capturing.captureEvent(client)
            if (target === null || target.type === "track") {return}
            if (!selection.isSelected(target.region)) {
                selection.deselectAll()
                selection.select(target.region)
            }
            const region = target.region
            addItems(
                MenuItem.default({label: "Delete", shortcut: "⌫"})
                    .setTriggerProcedure(() => editing.modify(() => selection.selected().slice()
                        .forEach(adapter => adapter.box.delete()))),
                MenuItem.default({label: "Duplicate"})
                    .setTriggerProcedure(() => editing.modify(() => {
                        project.api.duplicateRegion(region)
                            .ifSome(duplicate => {
                                selection.deselectAll()
                                selection.select(duplicate)
                            })
                    })),
                MenuItem.default({
                    label: "Mute",
                    checked: region.mute,
                    shortcut: RegionsShortcuts["toggle-mute"].shortcut.format()
                }).setTriggerProcedure(() => editing.modify(() => {
                    const newValue = !region.mute
                    return selection.selected().slice().forEach(adapter => adapter.box.mute.setValue(newValue))
                })),
                ColorMenu.createItem(hue => editing.modify(() =>
                    selection.selected().slice().forEach(adapter => adapter.box.hue.setValue(hue)))),
                MenuItem.default({label: "Rename"})
                    .setTriggerProcedure(() => Surface.get(element).requestFloatingTextInput(client, region.label)
                        .then(value => NameValidator.validate(value, {
                            success: name => editing.modify(() => selection.selected()
                                .forEach(adapter => adapter.box.label.setValue(name)))
                        }), EmptyExec)),
                MenuItem.default({label: "Loop Selection"})
                    .setTriggerProcedure(() => {
                        const [min, max] = computeSelectionRange()
                        editing.modify(() => {
                            timelineBox.loopArea.from.setValue(min)
                            timelineBox.loopArea.to.setValue(max)
                        })
                    }),
                MenuItem.default({label: "Zoom Selection"})
                    .setTriggerProcedure(() => {
                        const [min, max] = computeSelectionRange()
                        range.zoomRange(min, max)
                    }),
                MenuItem.default({
                    label: "Consolidate",
                    selectable: selection.selected().some(x => x.isMirrowed),
                    separatorBefore: true
                }).setTriggerProcedure(() => editing.modify(() => selection.selected().slice()
                    .forEach(adapter => adapter.consolidate()))),
                MenuItem.default({label: "Flatten", selectable: region.canFlatten(selection.selected())})
                    .setTriggerProcedure(() => {
                        if (region instanceof AudioRegionBoxAdapter) {
                            const audioRegions = selection.selected()
                                .filter((adapter): adapter is AudioRegionBoxAdapter =>
                                    isInstanceOf(adapter, AudioRegionBoxAdapter))
                            AudioConsolidation.flatten(project, service.sampleService, audioRegions)
                                .then(EmptyExec, console.warn)
                        } else {
                            editing.modify(() =>
                                region.flatten(selection.selected()).ifSome(box => project.selection.select(box)))
                        }
                    }),
                MenuItem.default({label: "Convert to Clip"})
                    .setTriggerProcedure(() => region.trackBoxAdapter.ifSome(() => editing.modify(() => {
                        service.timeline.clips.visible.setValue(true)
                        const clip = RegionTransformer.toClip(region)
                        vertexSelection.select(clip)
                        project.userEditingManager.timeline.edit(clip)
                    }))),
                MenuItem.default({
                    label: "Export to Midi-File",
                    hidden: region.type !== "note-region"
                }).setTriggerProcedure(() => {
                    if (region.type === "note-region") {
                        const label = region.label
                        NoteMidiExport.toFile(region.optCollection.unwrap(),
                            `${label.length === 0 ? "region" : label}.mid`).then(EmptyExec, EmptyExec)
                    }
                }),
                MenuItem.default({
                    label: "Reset Fades",
                    hidden: region.type !== "audio-region"
                }).setTriggerProcedure(() => {
                    if (isInstanceOf(region, AudioRegionBoxAdapter)) {
                        editing.modify(() => region.fading.reset())
                    }
                }),
                MenuItem.default({
                    label: "Play Mode",
                    hidden: region.type !== "audio-region"
                }).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    MenuItem.default({
                        label: "Pitch",
                        checked: region.type === "audio-region" && region.asPlayModePitchStretch.nonEmpty()
                    }).setTriggerProcedure(async () => {
                        const {status, value: modifier, error} =
                            await Promises.tryCatch(AudioContentModifier.toPitchStretch(selection.selected()
                                .filter((region): region is AudioRegionBoxAdapter => region.type === "audio-region")))
                        if (status === "resolved") {
                            editing.modify(modifier)
                        } else {
                            console.warn(error)
                        }
                    }),
                    MenuItem.default({
                        label: "Timestretch",
                        checked: region.type === "audio-region" && region.asPlayModeTimeStretch.nonEmpty()
                    }).setTriggerProcedure(async () => {
                        const {status, value: modifier, error} =
                            await Promises.tryCatch(AudioContentModifier.toTimeStretch(selection.selected()
                                .filter((region): region is AudioRegionBoxAdapter => region.type === "audio-region")))
                        if (status === "resolved") {
                            editing.modify(modifier)
                        } else {
                            console.warn(error)
                        }
                    }),
                    MenuItem.default({
                        label: "No Warp",
                        checked: region.type === "audio-region" && region.isPlayModeNoStretch
                    }).setTriggerProcedure(async () => {
                            const {status, value: modifier, error} =
                                await Promises.tryCatch(AudioContentModifier.toNotStretched(selection.selected()
                                    .filter((region): region is AudioRegionBoxAdapter => region.type === "audio-region")))
                            if (status === "resolved") {
                                editing.modify(modifier)
                            } else {
                                console.warn(error)
                            }
                        }
                    )
                )),
                MenuItem.default({
                    label: "Calc Bpm",
                    hidden: region.type !== "audio-region" || !Browser.isLocalHost()
                }).setTriggerProcedure(() => {
                    if (region.type === "audio-region") {
                        region.file.data.ifSome(data => {
                            const bpm = BPMTools.detect(data.frames[0], data.sampleRate)
                            Dialogs.info({headline: "BPMTools", message: `${bpm.toFixed(3)} BPM`})
                                .finally()
                        })
                    }
                }),
                MenuItem.default({
                    label: "Detect BPM (AI)...",
                    hidden: region.type !== "audio-region" || !Browser.isLocalHost()
                }).setTriggerProcedure(() => {
                    if (region.type === "audio-region") {
                        region.file.data.ifSome(data => {
                            detectRegionBpm(data.frames[0], data.sampleRate).catch(EmptyExec)
                        })
                    }
                }),
                DebugMenus.debugBox(region.box)
            )
        })
    }

const detectRegionBpm = async (frames: Float32Array, sampleRate: number): Promise<void> => {
    const Inference = await ensureInference()
    // First-time: download with progress (model is ~11 MB, fast on most
    // connections but visible). Cache hit: skip the dialog entirely;
    // session creation for the WASM EP is sub-second so it stays silent.
    const cached = await Inference.isCached("tempo-detection")
    if (!cached) {
        const downloadProgress = new DefaultObservableValue<number>(0)
        const downloadController = new AbortController()
        const sizeLabel = Bytes.toString(Inference.modelDescriptor("tempo-detection").bytes)
        const downloadDialog = RuntimeNotifier.progress({
            headline: "Downloading tempo model",
            message: `${sizeLabel}, one-time`,
            progress: downloadProgress,
            cancel: () => downloadController.abort(Errors.AbortError)
        })
        const preloadResult = await Promises.tryCatch(Inference.preload("tempo-detection", {
            progress: value => downloadProgress.setValue(value),
            signal: downloadController.signal
        }))
        downloadDialog.terminate()
        if (preloadResult.status === "rejected") {
            if (Errors.isAbort(preloadResult.error)) {return}
            await Dialogs.info({headline: "Detect BPM (AI)", message: String(preloadResult.error)})
            return
        }
    }
    const detectProgress = new DefaultObservableValue<number>(0)
    const detectController = new AbortController()
    const detectDialog = RuntimeNotifier.progress({
        headline: "Detecting tempo",
        progress: detectProgress,
        cancel: () => detectController.abort(Errors.AbortError)
    })
    const result = await Promises.tryCatch(Inference.run("tempo-detection",
        {audio: frames, sampleRate}, {
            progress: value => detectProgress.setValue(value),
            signal: detectController.signal,
            downloadShare: 0
        }))
    detectDialog.terminate()
    if (result.status === "rejected") {
        if (Errors.isAbort(result.error)) {return}
        await Dialogs.info({headline: "Detect BPM (AI)", message: String(result.error)})
        return
    }
    const {bpm, confidence, topCandidates} = result.value
    const rawPeak = topCandidates[0].bpm
    // Annotate octave correction so a "raw peak ≠ winner" mismatch reads as
    // intentional rather than as the dialog disagreeing with itself.
    const note = rawPeak === bpm
        ? ""
        : `\n(raw model peak at ${rawPeak} BPM — corrected to ${bpm} BPM via octave clamp)`
    const message = `${bpm} BPM - confidence ${(confidence * 100).toFixed(0)}%${note}`
    await Dialogs.info({headline: "Detect BPM (AI)", message})
}