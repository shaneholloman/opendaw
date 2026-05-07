import {Option, panic, Procedure, Provider, Terminable, unitValue} from "@opendaw/lib-std"
import {ExecutionProvider, TaskDefinition} from "./Task"
import {TaskInput, TaskKey, TaskOutput} from "./registry"
import {InferenceConfig, installInferenceConfig, requireInferenceConfig} from "./InferenceConfig"
import {TaskRegistry} from "./registry"
import {EngineHost, runTask} from "./EngineHost"
import {InferenceEngineError} from "./Errors"

export interface RunOptions {
    readonly progress?: Procedure<unitValue>
    readonly signal?: AbortSignal
    readonly executionProvider?: ExecutionProvider | "auto"
}

export interface TaskHandle<K extends TaskKey> extends Terminable {
    run(input: TaskInput<K>, options?: RunOptions): Promise<TaskOutput<K>>
}

export interface InstallOptions extends InferenceConfig {
    readonly workerFactory?: Provider<Worker>
}

let host: Option<EngineHost> = Option.None

const defaultWorkerFactory: Provider<Worker> = () => new Worker(
    new URL("./workers/inference.worker.js", import.meta.url),
    {type: "module", name: "opendaw-inference"}
)

const requireHost = (): EngineHost => host.match({
    none: () => panic("Inference is not installed. Call Inference.install({opfs}) at startup."),
    some: instance => instance
})

const resolveProviders = (
    available: ReadonlyArray<ExecutionProvider>,
    requested: ExecutionProvider | "auto" | undefined
): ReadonlyArray<ExecutionProvider> => {
    if (requested === undefined || requested === "auto") {return available}
    return [requested]
}

const lookupTask = <K extends TaskKey>(key: K): TaskDefinition<TaskInput<K>, TaskOutput<K>> => {
    const task = (TaskRegistry as Readonly<Record<string, TaskDefinition<unknown, unknown>>>)[key as string]
    if (task === undefined) {return panic(`Unknown inference task: ${String(key)}`)}
    return task as TaskDefinition<TaskInput<K>, TaskOutput<K>>
}

const NO_PROGRESS: Procedure<unitValue> = () => {}

export namespace Inference {
    export const install = (config: InstallOptions): void => {
        installInferenceConfig({opfs: config.opfs})
        host.match({
            none: () => {},
            some: existing => {existing.shutdown().catch(() => {})}
        })
        host = Option.wrap(new EngineHost({
            workerFactory: config.workerFactory ?? defaultWorkerFactory
        }))
    }

    export const run = <K extends TaskKey>(
        key: K,
        input: TaskInput<K>,
        options?: RunOptions
    ): Promise<TaskOutput<K>> => {
        requireInferenceConfig()
        const engineHost = requireHost()
        const task = lookupTask(key)
        const progress = options?.progress ?? NO_PROGRESS
        const signal = options?.signal === undefined ? Option.None : Option.wrap(options.signal)
        return engineHost.enqueue(() => runTask<TaskInput<K>, TaskOutput<K>>(engineHost, {
            task,
            input,
            progress,
            signal,
            executionProviders: resolveProviders(task.executionProviders, options?.executionProvider)
        }))
    }

    export const acquire = <K extends TaskKey>(key: K): Promise<TaskHandle<K>> => {
        requireInferenceConfig()
        const engineHost = requireHost()
        const task = lookupTask(key)
        return engineHost
            .ensureLoaded(task.key, task.model, task.executionProviders)
            .then(() => new class implements TaskHandle<K> {
                #released: boolean = false
                run(input: TaskInput<K>, options?: RunOptions): Promise<TaskOutput<K>> {
                    if (this.#released) {
                        return Promise.reject(new InferenceEngineError("TaskHandle has been released"))
                    }
                    const progress = options?.progress ?? NO_PROGRESS
                    const signal = options?.signal === undefined ? Option.None : Option.wrap(options.signal)
                    return engineHost.enqueue(() => runTask<TaskInput<K>, TaskOutput<K>>(engineHost, {
                        task,
                        input,
                        progress,
                        signal,
                        executionProviders: resolveProviders(task.executionProviders, options?.executionProvider)
                    }))
                }

                terminate(): void {
                    if (this.#released) {return}
                    this.#released = true
                    engineHost.releaseTask(task.key).catch(() => {})
                }
            })
    }

    export const shutdown = (): Promise<void> => {
        if (host.isEmpty()) {return Promise.resolve()}
        const engineHost = host.unwrap()
        host = Option.None
        return engineHost.shutdown()
    }
}
