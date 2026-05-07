import {Procedure, Terminable, unitValue} from "@opendaw/lib-std"
import {ExecutionProvider} from "./Task"
import {TaskInput, TaskKey, TaskOutput} from "./registry"

export interface RunOptions {
    readonly progress?: Procedure<unitValue>
    readonly signal?: AbortSignal
    readonly executionProvider?: ExecutionProvider | "auto"
}

export interface TaskHandle<K extends TaskKey> extends Terminable {
    run(input: TaskInput<K>, options?: RunOptions): Promise<TaskOutput<K>>
}

export namespace Inference {
    export const run = <K extends TaskKey>(
        _task: K,
        _input: TaskInput<K>,
        _options?: RunOptions
    ): Promise<TaskOutput<K>> => {
        throw new Error("Inference.run not implemented yet")
    }

    export const acquire = <K extends TaskKey>(_task: K): Promise<TaskHandle<K>> => {
        throw new Error("Inference.acquire not implemented yet")
    }
}
