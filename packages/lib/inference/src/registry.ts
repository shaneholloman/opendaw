import {TaskDefinition} from "./Task"
import {StemSeparationAltTask, StemSeparationTask} from "./tasks/StemSeparationTask"
import {BasicPitchTask} from "./tasks/BasicPitchTask"

export const TaskRegistry = {
    "stem-separation":     StemSeparationTask,
    "stem-separation-alt": StemSeparationAltTask,
    "audio-to-midi":       BasicPitchTask
} as const

export type TaskKey = keyof typeof TaskRegistry

export type TaskInput<K extends TaskKey> =
    typeof TaskRegistry[K] extends TaskDefinition<infer I, unknown> ? I : never

export type TaskOutput<K extends TaskKey> =
    typeof TaskRegistry[K] extends TaskDefinition<unknown, infer O> ? O : never
