import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { appendFileSync } from 'node:fs'
import { planContext } from '@/services/contextPlanner'
import type { PromptFragment } from '@/services/prompt/promptContextAssembler'

describe('context selection reference load', () => {
  for (const count of [1000, 5000, 20000])
    it(`selects bounded source records from ${count} memories`, async () => {
      const fragments: PromptFragment[] = Array.from({ length: count }, (_, index) => ({
        id: `memory-${index}`,
        source: 'memory',
        scope: 'project',
        trust: 'untrusted_data',
        egress: 'local_only',
        priority: 50,
        provenance: { recordId: String(index), revision: '1' },
        content: `Projektwissen ${index}: ${index === count - 1 ? 'SQLite Wiederaufnahme Zielarchiv' : 'UI Farbe Reihenfolge'}; Beleg und Quelle bleiben erhalten.`,
      }))
      const heapBefore = process.memoryUsage().heapUsed
      const started = performance.now()
      const plan = await planContext({
        scopeKey: {
          principalId: 'synthetic',
          serverInstance: 'device-local',
          projectId: 'load',
          sessionId: 'test',
          taskType: 'code',
        },
        query: 'SQLite Wiederaufnahme Zielarchiv',
        fragments,
        local: { windowTokens: 32768 },
      })
      const elapsedMs = performance.now() - started
      const measurement = {
        count,
        elapsedMs: Math.round(elapsedMs),
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
        selected: plan.local.selected.length,
        packetBytes: plan.local.charCount,
        writes: 0,
      }
      if (process.env.LUCZOR_CONTEXT_LOAD_REPORT) {
        // Only an explicit local benchmark invocation supplies this output artifact path.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        appendFileSync(process.env.LUCZOR_CONTEXT_LOAD_REPORT, `${JSON.stringify(measurement)}\n`)
      }
      expect(plan.local.selected[0]?.id).toBe(`memory-${count - 1}`)
      expect(plan.diagnostics.local.found).toBe(count)
      expect(plan.local.charCount).toBeLessThanOrEqual(plan.local.budget.maxChars)
      expect(plan.external.text).toBe('')
    }, 30_000)
})
