import {TaskDefinition} from "./Task"

export const TaskRegistry = {} as const satisfies Record<string, TaskDefinition<unknown, unknown>>

export type TaskKey = keyof typeof TaskRegistry

export type TaskInput<K extends TaskKey> =
    typeof TaskRegistry[K] extends TaskDefinition<infer I, unknown> ? I : never

export type TaskOutput<K extends TaskKey> =
    typeof TaskRegistry[K] extends TaskDefinition<unknown, infer O> ? O : never
