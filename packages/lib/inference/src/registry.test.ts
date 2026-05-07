import {describe, expect, it} from "vitest"
import {TaskRegistry} from "./registry"

describe("TaskRegistry", () => {
    it("contains stem-separation", () => {
        expect(TaskRegistry["stem-separation"]).toBeDefined()
        expect(TaskRegistry["stem-separation"].key).toBe("stem-separation")
        expect(TaskRegistry["stem-separation"].model.version).toBe("v4")
    })

    it("contains audio-to-midi", () => {
        expect(TaskRegistry["audio-to-midi"]).toBeDefined()
        expect(TaskRegistry["audio-to-midi"].key).toBe("audio-to-midi")
        expect(TaskRegistry["audio-to-midi"].model.version).toBe("v0.4.0")
    })

    it("each task declares at least one execution provider", () => {
        for (const key of Object.keys(TaskRegistry) as Array<keyof typeof TaskRegistry>) {
            expect(TaskRegistry[key].executionProviders.length).toBeGreaterThan(0)
        }
    })

    it("each task's model URL is an absolute commit-pinned upstream URL", () => {
        for (const key of Object.keys(TaskRegistry) as Array<keyof typeof TaskRegistry>) {
            const url = TaskRegistry[key].model.url
            expect(url).toMatch(/^https:\/\//)
            // Hugging Face commit-pinned: /resolve/<40-hex-chars>/
            expect(url).toMatch(/\/resolve\/[0-9a-f]{40}\//)
        }
    })

    it("each task declares a non-zero byte length and a 64-char SHA-256", () => {
        for (const key of Object.keys(TaskRegistry) as Array<keyof typeof TaskRegistry>) {
            const model = TaskRegistry[key].model
            expect(model.bytes).toBeGreaterThan(0)
            expect(model.sha256).toMatch(/^[0-9a-f]{64}$/)
        }
    })
})
