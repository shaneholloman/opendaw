export interface ModelDescriptor {
    readonly url: string
    readonly sha256: string
    readonly bytes: number
    readonly version: string
}

export type ExecutionProvider = "webgpu" | "wasm"

export interface TaskDefinition<I, O> {
    readonly key: string
    readonly model: ModelDescriptor
    readonly executionProviders: ReadonlyArray<ExecutionProvider>
    readonly preprocess: (input: I) => unknown
    readonly postprocess: (raw: unknown) => O
}

export const defineTask = <I, O>(definition: TaskDefinition<I, O>): TaskDefinition<I, O> => definition
