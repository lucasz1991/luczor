import { reactive, readonly, watch } from 'vue'
import { publicAnswerText } from '@/services/publicAnswerStream'
import { readReportedTokenUsage } from '@/services/tokenUsage'
import type { InferenceRequest, InferenceResult } from './types'
import { readContextBudget } from './contextBudget'
import { readLocalFailureDiagnostic, describeLocalFailureDiagnostic, type LocalFailureDiagnostic } from './localFailure'

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
  budget?: InferenceRequest['contextBudget']
  runtime: RuntimeDiagnostics
  failure?: LocalFailureDiagnostic
  events: { at: number; label: string }[]
  remote?: boolean
}

export const LOCAL_FAILURE_STAGE_LABELS: Record<LocalFailureDiagnostic['stage'], string> = {
  preparation: 'Vorbereitung',
  tokenization: 'Tokenisierung',
  generation: 'Generierung',
  unknown: 'Nicht ermittelt',
}

/** Only a fixed diagnostic projection is copied; never the observation's output, roles, events or raw data. */
export function localModelDiagnosticCopy(
  observation: Readonly<Pick<ModelObservation, 'model' | 'state' | 'failure' | 'budget'>>
): string {
  const failure = observation.state === 'error' ? readLocalFailureDiagnostic(observation.failure) : null
  const value = (field: string | number | undefined) => field ?? 'nicht ermittelt'
  const budget = readContextBudget(observation.budget)
  return [
    'Luczor – lokale Modelldiagnose',
    `Modell: ${observation.model.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160)}`,
    `Status: ${observation.state === 'error' ? 'Fehlgeschlagen' : observation.state === 'cancelled' ? 'Abgebrochen' : 'Kein Modellfehler erfasst'}`,
    `Phase: ${failure ? LOCAL_FAILURE_STAGE_LABELS[failure.stage] : 'nicht ermittelt'}`,
    `HTTP: ${value(failure?.httpStatus)}`,
    `Fehlercode: ${value(failure?.code)}`,
    `Parameter: ${value(failure?.parameter)}`,
    `Grund: ${value(failure?.reason)}`,
    `Eingabetokens (erfasst): ${value(failure?.inputTokens)}`,
    `Kontextfenster (erfasst): ${value(failure?.contextTokens)}`,
    `Ausgabelimit (Tokens, erfasst): ${value(failure?.outputTokens)}`,
    ...(failure ? [`Einordnung: ${describeLocalFailureDiagnostic(failure)}`] : []),
    ...(budget
      ? [
          `Kontextplanung (geschätzt): ${budget.estimatedInputTokens} · Ziel: ${budget.targetTokens}`,
          `Anteile (geschätzt): Regeln ${budget.categories.rules} · Profil ${budget.categories.profile} · Wissen ${budget.categories.knowledge} · Verlauf ${budget.categories.history} · Werkzeuge ${budget.categories.tools}`,
          `Historische Nachrichten als Auszüge: ${budget.summarizedMessages} · Werkzeugergebnisse gekürzt: ${budget.shortenedToolResults}`,
        ]
      : []),
  ].join('\n')
}

/** Bounded, renderer-local observation of public answers. Never persists prompts or tool payloads. */
export function createLocalModelDiagnostics(now = Date.now) {
  const state = reactive<{ runs: ModelObservation[] }>({ runs: [] })
  let ownsObservations = false
  let sequence = 0
  const clear = () => {
    state.runs.splice(0)
  }
  function begin(model: string, messages: InferenceRequest['messages'], budget?: InferenceRequest['contextBudget']) {
    ownsObservations = true
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
      budget: readContextBudget(budget),
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
        const hasPublicResult = run.toolCount > 0 || run.output.trim().length > 0
        run.state = hasPublicResult ? 'done' : 'error'
        run.endedAt = now()
        run.events.push({
          at: now(),
          label: run.toolCount
            ? `${run.toolCount} Werkzeugaufrufe vom Modell angefordert`
            : !hasPublicResult
              ? run.finishReason === 'length'
                ? 'Ausgabelimit ohne öffentliche Antwort erreicht'
                : 'Keine öffentliche Antwort vom Modell erhalten'
              : run.finishReason === 'length'
                ? 'Ausgabelimit erreicht · Antwort unvollständig'
                : 'Antwort abgeschlossen',
        })
      },
      fail(cancelled: boolean, diagnostic?: unknown) {
        if (!current()) return
        run.state = cancelled ? 'cancelled' : 'error'
        run.failure = cancelled ? undefined : (readLocalFailureDiagnostic(diagnostic) ?? undefined)
        run.endedAt = now()
        run.events.push({ at: now(), label: cancelled ? 'Anfrage abgebrochen' : 'Anfrage fehlgeschlagen' })
      },
    }
  }
  // Window sharing deliberately excludes output, message roles, events,
  // failure reasons and request/tool data. Receivers rebuild a fixed projection.
  function numericSnapshot() {
    return state.runs
      .filter(run => !run.remote)
      .map(run => ({
        id: run.id,
        model: run.model,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        state: run.state,
        toolCount: run.toolCount,
        finishReason: run.finishReason,
        usage: run.usage ? { ...run.usage } : undefined,
        context: run.context ? { ...run.context } : undefined,
        budget: readContextBudget(run.budget),
        runtime: { ...run.runtime },
      }))
  }
  function acceptNumericSnapshot(snapshot: unknown) {
    if (!Array.isArray(snapshot)) return
    const numeric = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    const integer = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
    const records: ModelObservation[] = []
    for (const value of snapshot.slice(0, 12)) {
      if (!value || typeof value !== 'object') continue
      const item = value as Record<string, unknown>
      const id = integer(item.id)
      const startedAt = integer(item.startedAt)
      if (
        id === null ||
        startedAt === null ||
        typeof item.model !== 'string' ||
        !['preparing', 'responding', 'done', 'cancelled', 'error'].includes(String(item.state))
      )
        continue
      const runtime = item.runtime && typeof item.runtime === 'object' ? (item.runtime as Record<string, unknown>) : {}
      const context = item.context && typeof item.context === 'object' ? (item.context as Record<string, unknown>) : {}
      const contextNumbers = [
        context.inputTokens,
        context.contextTokens,
        context.outputTokens,
        context.omittedMessages,
        context.shortenedToolResults,
      ].map(integer)
      records.push({
        id,
        model: item.model.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160),
        startedAt,
        endedAt: item.endedAt === null ? null : integer(item.endedAt),
        state: item.state as ModelObservation['state'],
        remote: true,
        toolCount: integer(item.toolCount) ?? 0,
        finishReason: ['stop', 'length', 'tool_calls', 'content_filter'].includes(String(item.finishReason))
          ? String(item.finishReason)
          : 'other',
        output: '',
        outputTruncated: false,
        roles: [],
        events: [],
        usage: readReportedTokenUsage(item.usage),
        budget: readContextBudget(item.budget),
        context: contextNumbers.every(value => value !== null)
          ? {
              inputTokens: contextNumbers.at(0)!,
              contextTokens: contextNumbers.at(1)!,
              outputTokens: contextNumbers.at(2)!,
              omittedMessages: contextNumbers.at(3)!,
              shortenedToolResults: contextNumbers.at(4)!,
            }
          : undefined,
        runtime: {
          cachedTokens: numeric(runtime.cachedTokens),
          reasoningTokens: numeric(runtime.reasoningTokens),
          promptMs: numeric(runtime.promptMs),
          predictedMs: numeric(runtime.predictedMs),
          promptTokensPerSecond: numeric(runtime.promptTokensPerSecond),
          outputTokensPerSecond: numeric(runtime.outputTokensPerSecond),
        },
      })
    }
    const local = state.runs.filter(run => !run.remote)
    const merged = [...local, ...records].sort((left, right) => right.startedAt - left.startedAt).slice(0, 12)
    state.runs.splice(0, state.runs.length, ...merged)
  }
  return {
    state: readonly(state),
    begin,
    clear,
    numericSnapshot,
    acceptNumericSnapshot,
    ownsObservations: () => ownsObservations,
  }
}

export const localModelDiagnostics = createLocalModelDiagnostics()

// Same-origin device windows only. No persistence or server transmission.
if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && typeof BroadcastChannel !== 'undefined') {
  const channel = new BroadcastChannel('luczor-local-model-numeric-status-v1')
  let revision = 0
  const source = crypto.randomUUID()
  const snapshots = new Map<string, { at: number; runs: unknown[] }>()
  const ids = new Map<string, number>()
  let nextId = 1_000_000
  const receive = () => {
    const combined: unknown[] = []
    for (const [sender, snapshot] of snapshots) {
      if (Date.now() - snapshot.at > 30_000) {
        snapshots.delete(sender)
        continue
      }
      for (const value of snapshot.runs.slice(0, 12)) {
        if (!value || typeof value !== 'object') continue
        const item = value as Record<string, unknown>
        if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id < 0) continue
        const key = `${sender}:${item.id}`
        if (!ids.has(key)) ids.set(key, ++nextId)
        combined.push({ ...item, id: ids.get(key) })
      }
    }
    combined.sort(
      (left, right) =>
        Number((right as Record<string, unknown>).startedAt) - Number((left as Record<string, unknown>).startedAt)
    )
    localModelDiagnostics.acceptNumericSnapshot(combined.slice(0, 12))
    if (ids.size > 1024) ids.clear()
  }
  const publish = () => {
    if (localModelDiagnostics.ownsObservations())
      channel.postMessage({
        kind: 'snapshot',
        source,
        at: Date.now(),
        revision: ++revision,
        runs: localModelDiagnostics.numericSnapshot(),
      })
  }
  channel.onmessage = event => {
    const data = event.data
    if (data?.kind === 'request') publish()
    else if (
      data?.kind === 'snapshot' &&
      typeof data.at === 'number' &&
      Number.isFinite(data.at) &&
      Math.abs(Date.now() - data.at) < 30_000 &&
      typeof data.source === 'string' &&
      data.source.length <= 80 &&
      data.source !== source &&
      Array.isArray(data.runs)
    ) {
      const previous = snapshots.get(data.source)
      if (!previous || data.at >= previous.at) {
        if (snapshots.size >= 8 && !snapshots.has(data.source)) return
        snapshots.set(data.source, { at: data.at, runs: data.runs.slice(0, 12) })
        receive()
      }
    }
  }
  const stop = watch(() => JSON.stringify(localModelDiagnostics.numericSnapshot()), publish, { flush: 'post' })
  const timer = setInterval(() => {
    if (localModelDiagnostics.ownsObservations()) publish()
    else channel.postMessage({ kind: 'request' })
    receive()
  }, 1000)
  channel.postMessage({ kind: 'request' })
  window.addEventListener(
    'beforeunload',
    () => {
      stop()
      clearInterval(timer)
      channel.close()
    },
    { once: true }
  )
}
