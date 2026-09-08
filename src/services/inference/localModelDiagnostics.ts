import { reactive, readonly } from 'vue'
import { publicAnswerText } from '@/services/publicAnswerStream'
import { readReportedTokenUsage } from '@/services/tokenUsage'
import type { InferenceRequest, InferenceResult } from './types'

export type RuntimeDiagnostics = {
  cachedTokens?: number | null
  reasoningTokens?: number | null
  promptMs?: number | null
  predictedMs?: number | null
  promptTokensPerSecond?: number | null
  outputTokensPerSecond?: number | null
}
export type ModelObservation = {
  id: number
  model: string
  startedAt: number
  endedAt: number | null
  state: 'preparing' | 'responding' | 'done' | 'cancelled' | 'error'
  output: string
  outputTruncated: boolean
  roles: { role: string; messages: number; characters: number }[]
  toolCount: number
  finishReason: string
  usage?: InferenceResult['usage']
  context?: InferenceResult['contextUsage']
  runtime: RuntimeDiagnostics
  events: { at: number; label: string }[]
}

/** Bounded, renderer-local observation of public answers. Never persists prompts or tool payloads. */
export function createLocalModelDiagnostics(now = Date.now) {
  const state = reactive<{ runs: ModelObservation[] }>({ runs: [] })
  let sequence = 0
  const clear = () => {
    state.runs.splice(0)
  }
  function begin(model: string, messages: InferenceRequest['messages']) {
    const run = reactive<ModelObservation>({
      id: ++sequence,
      model: model.slice(0, 160),
      startedAt: now(),
      endedAt: null,
      state: 'preparing',
      output: '',
      outputTruncated: false,
      toolCount: 0,
      finishReason: '',
      runtime: {},
      roles: ['system', 'user', 'assistant', 'tool'].map(role => {
        const selected = messages.filter(message => message.role === role)
        return {
          role,
          messages: selected.length,
          characters: selected.reduce((sum, message) => sum + message.content.length, 0),
        }
      }),
      events: [{ at: now(), label: 'Anfrage an lokale Runtime übergeben' }],
    })
    state.runs.unshift(run)
    state.runs.splice(12)
    const current = () => state.runs.includes(run) && run.endedAt === null
    function output(raw: string, complete = false) {
      const text = publicAnswerText(raw, complete)
      run.output = text.slice(0, 24_000)
      run.outputTruncated = text.length > 24_000
    }
    return {
      delta(raw: string) {
        if (!current()) return
        if (run.state !== 'responding' && publicAnswerText(raw)) {
          run.state = 'responding'
          run.events.push({ at: now(), label: 'Öffentliche Antwort wird empfangen' })
        }
        output(raw)
      },
      finish(
        result: Pick<InferenceResult, 'content' | 'usage' | 'contextUsage' | 'rawToolCalls' | 'finishReason'>,
        runtime?: RuntimeDiagnostics
      ) {
        if (!current()) return
        output(result.content, true)
        run.usage = readReportedTokenUsage(result.usage)
        const context = result.contextUsage
        if (context && Object.values(context).every(value => Number.isSafeInteger(value) && value >= 0))
          run.context = { ...context }
        const metric = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
        run.runtime = {
          cachedTokens: metric(runtime?.cachedTokens),
          reasoningTokens: metric(runtime?.reasoningTokens),
          promptMs: metric(runtime?.promptMs),
          predictedMs: metric(runtime?.predictedMs),
          promptTokensPerSecond: metric(runtime?.promptTokensPerSecond),
          outputTokensPerSecond: metric(runtime?.outputTokensPerSecond),
        }
        run.toolCount = result.rawToolCalls.length
        run.finishReason = ['stop', 'length', 'tool_calls', 'content_filter'].includes(result.finishReason)
          ? result.finishReason
          : 'other'
        run.state = 'done'
        run.endedAt = now()
        run.events.push({
          at: now(),
          label: run.toolCount ? `${run.toolCount} Werkzeugaufrufe vom Modell angefordert` : 'Antwort abgeschlossen',
        })
      },
      fail(cancelled: boolean) {
        if (!current()) return
        run.state = cancelled ? 'cancelled' : 'error'
        run.endedAt = now()
        run.events.push({ at: now(), label: cancelled ? 'Anfrage abgebrochen' : 'Anfrage fehlgeschlagen' })
      },
    }
  }
  return { state: readonly(state), begin, clear }
}

export const localModelDiagnostics = createLocalModelDiagnostics()
