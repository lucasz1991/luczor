import { reactive } from 'vue'
import type { AgentToolSession, RunAgentOptions, RunAgentResult } from '@/services/agent'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { LuczorMode, WireMessage } from '@/services/inference/types'
import { createChatActivity, finishChatActivity, updateChatActivity } from '@/services/chatActivity'
import { presentEnvelopeStream } from '@/services/envelope'
import { completedCommentary } from '@/services/chatCommentary'
import { compactHistory, normalizeConversationHistory, previewToolArguments } from '@/services/chatPresentation'
import { executionGate } from '@/services/executionGate'
import { isThinkingTier } from '@/services/inference/thinking'
import { captureThinking, thinkingSettings } from '@/services/inference/thinkingSettings'
import { controlLocalReasoning } from '@/services/inference/tauriLocalRuntime'
import { emptyMiniSnapshot, type MiniAction, type MiniDecision, type MiniMessage } from './types'

type Context = {
  project: { id: string; name: string } | null
  mode: LuczorMode
  mainBusy: boolean
  workspaceBindingId?: string
}
type Dependencies = {
  followProject?: boolean
  context: () => Context
  setMode: (mode: 'observe' | 'act') => void
  preamble: (mode: LuczorMode, name: string) => string
  run: (
    options: RunAgentOptions
  ) => Promise<
    Pick<RunAgentResult, 'finalText'> & Partial<Pick<RunAgentResult, 'tokenUsage' | 'continuation' | 'interrupted'>>
  >
}

/** Conversation and tool journal are never passed to persistence, sync or memory. */
export function createMiniChatController(deps: Dependencies) {
  const state = reactive(emptyMiniSnapshot())
  state.sessionId = crypto.randomUUID()
  state.thinkingTier = thinkingSettings.value.defaultTier
  let abort: AbortController | null = null
  let decisionResolve: ((approved: boolean) => void) | null = null
  let continuation: AgentCheckpoint | undefined

  function touch() {
    state.revision++
  }
  function refresh() {
    const context = deps.context()
    state.mode = context.mode
    state.mainBusy = context.mainBusy
    if (!state.busy && (deps.followProject || !state.messages.length)) {
      if (
        continuation &&
        (continuation.projectId !== context.project?.id ||
          (continuation.workspaceBindingId !== undefined &&
            continuation.workspaceBindingId !== (context.workspaceBindingId ?? '')))
      )
        continuation = undefined
      state.project = context.project ? { ...context.project } : null
    }
    touch()
  }
  function decide(id: string, approved: boolean) {
    if (!state.decision || state.decision.id !== id || !decisionResolve) return
    const resolve = decisionResolve
    decisionResolve = null
    state.decision = null
    touch()
    resolve(approved)
  }
  function stop() {
    continuation = undefined
    abort?.abort()
    if (state.decision) decide(state.decision.id, false)
    touch()
  }
  function reset() {
    stop()
    state.thinkingTier = thinkingSettings.value.defaultTier
    state.thinkingBudget = null
    state.sessionId = crypto.randomUUID()
    continuation = undefined
    state.messages = []
    state.tools = []
    state.busy = !!abort
    state.notice = abort ? 'Der vorherige Auftrag wird noch beendet.' : ''
    state.project = deps.context().project
    refresh()
  }
  function boundHistory() {
    while (
      state.messages.length > 2 &&
      state.messages.reduce(
        (sum, message) =>
          sum +
          message.content.length +
          (message.question?.length ?? 0) +
          message.choices.join('').length +
          (message.commentary ?? []).reduce((length, entry) => length + entry.content.length, 0),
        0
      ) > 80_000
    )
      state.messages.splice(0, 2)
  }
  function ask(decision: MiniDecision, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    return new Promise(resolve => {
      const cancel = () => {
        if (state.decision?.id === decision.id) decide(decision.id, false)
      }
      decisionResolve = approved => {
        signal.removeEventListener('abort', cancel)
        resolve(approved && !signal.aborted)
      }
      state.decision = decision
      signal.addEventListener('abort', cancel, { once: true })
      touch()
    })
  }
  async function send(raw: string) {
    const text = raw.trim()
    refresh()
    if (!text || text.length > 12_000 || state.busy) return
    if (!state.project) {
      state.notice = 'Öffne zuerst ein Projekt in Luczor.'
      touch()
      return
    }
    const project = { ...state.project }
    const turnThinking = captureThinking(state.thinkingTier ?? 'balanced')
    const sessionId = state.sessionId
    const current = new AbortController()
    const runId = crypto.randomUUID()
    const conversationId = `workspace:${sessionId}`
    const workspaceBindingId = deps.context().workspaceBindingId ?? ''
    const turnExecution = executionGate.capture(current.signal, {
      projectId: project.id,
      conversationId,
      runId,
      ...(workspaceBindingId ? { workspaceBindingId } : {}),
    })
    abort = current
    const valid = () => {
      if (state.sessionId !== sessionId || abort !== current || turnExecution.signal.aborted) return false
      try {
        executionGate.assert(turnExecution)
        return true
      } catch {
        return false
      }
    }
    state.busy = true
    state.notice = ''
    state.tools = []
    const user: MiniMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      contextLabel: deps.followProject ? project.name : undefined,
      choices: [],
      createdAt: Date.now(),
      status: 'done',
    }
    const assistant: MiniMessage = reactive({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      choices: [],
      createdAt: Date.now(),
      status: 'running',
      activity: createChatActivity(),
      commentary: [],
    })
    state.messages.push(user, assistant)
    if (state.messages.length > 40) state.messages.splice(0, state.messages.length - 40)
    boundHistory()
    touch()
    const toolSession: AgentToolSession = {
      queue(call) {
        if (!valid()) return
        state.tools.push({
          id: call.id,
          name: call.name,
          detail: previewToolArguments(call.args, 6000),
          status: call.status,
        })
        state.tools = state.tools.slice(-12)
        touch()
      },
      update(id, status) {
        if (!valid()) return
        const tool = state.tools.find(item => item.id === id)
        if (tool) tool.status = status
        touch()
      },
      approve(id, approvalSignal) {
        const tool = state.tools.find(item => item.id === id)
        if (!valid() || !tool) return Promise.resolve(false)
        return ask(
          {
            id: crypto.randomUUID(),
            kind: 'tool',
            title: `${tool.name} ausführen?`,
            description: `Einmalige Freigabe für ${project.name}.`,
            detail: tool.detail,
          },
          approvalSignal ?? turnExecution.signal
        )
      },
    }
    let latestCheckpoint = continuation
    try {
      const transcript: WireMessage[] = state.messages
        .filter(message => message.id !== assistant.id && message.status === 'done')
        .map(message => ({
          role: message.role,
          content: [
            message.contextLabel ? `[Arbeitsprojekt dieser Nachricht: ${message.contextLabel}]` : '',
            message.content,
            message.question,
            ...message.choices,
          ]
            .filter(Boolean)
            .join('\n'),
        }))
      const baseMessages: WireMessage[] = [
        {
          role: 'system',
          content:
            deps.preamble(state.mode, project.name) +
            '\nTemporärer Mini-Chat: keine Unterhaltung automatisch als Memory oder Projektzusammenfassung speichern. Antworte kurz. Bei einer Rückfrage kannst du ein JSON-Objekt mit summary, question und maximal vier kurzen Antwortoptionen in bullets ausgeben. Eine Antwortoption ist keine Tool-Freigabe.',
        },
        ...compactHistory(normalizeConversationHistory(transcript), 2400),
      ]
      executionGate.assert(turnExecution)
      const continuationForTurn = continuation
        ? {
            ...structuredClone(continuation),
            objective: [
              continuation.objective,
              /^\s*(weiter|fortsetzen|mach(?:e)? weiter)[.!?\s]*$/iu.test(text)
                ? ''
                : `Aktuelle Nutzeranweisung: ${text}`,
            ]
              .filter(Boolean)
              .join('\n\n')
              .slice(0, 12_000),
            messages: [...structuredClone(continuation.messages), { role: 'user' as const, content: text }],
          }
        : undefined
      const result = await deps.run({
        ...turnThinking,
        execution: turnExecution,
        conversationId,
        runId,
        workspaceBindingId,
        onBudget(progress) {
          if (valid()) {
            state.thinkingBudget = progress
            touch()
          }
        },
        projectId: project.id,
        mode: state.mode,
        getMode: () => deps.context().mode,
        baseMessages,
        contextEgress: 'local_only',
        routingSettings: { preference: 'local_only' },
        signal: turnExecution.signal,
        continuation: continuationForTurn,
        toolSession,
        onCheckpoint(checkpoint) {
          if (!valid()) return
          latestCheckpoint = checkpoint
        },
        onProgress(event) {
          if (valid() && assistant.activity) {
            updateChatActivity(assistant.activity, event)
            touch()
          }
        },
        onToken(content) {
          if (valid()) {
            const presented = presentEnvelopeStream(content)
            assistant.content = presented.content.slice(0, 16_000)
            assistant.question = presented.question.slice(0, 1000)
            assistant.choices = presented.bullets.slice(0, 4).map(choice => choice.slice(0, 300))
            touch()
          }
        },
        onRoundComplete(round) {
          if (valid() && round.kind === 'commentary') {
            const entry = completedCommentary(round)
            if (!entry || assistant.commentary?.some(item => item.id === entry.id)) return
            assistant.commentary = [
              ...(assistant.commentary ?? []),
              { ...entry, content: entry.content.slice(0, 16_000) },
            ]
            assistant.content = ''
            assistant.question = ''
            assistant.choices = []
            touch()
          }
        },
        onUsage(usage) {
          if (valid()) {
            assistant.tokenUsage = usage
            touch()
          }
        },
      })
      executionGate.assert(turnExecution)
      if (!valid()) return
      continuation = result.continuation ?? (result.interrupted ? latestCheckpoint : undefined)
      state.notice = continuation
        ? 'Der Arbeitsstand ist gesichert. Die nächste Nachricht setzt ihn fort; mit Zurücksetzen verwirfst du ihn.'
        : ''
      assistant.tokenUsage = result.tokenUsage ?? assistant.tokenUsage
      const presented = presentEnvelopeStream(result.finalText, true)
      assistant.content = presented.content.slice(0, 16_000)
      assistant.question = presented.question.slice(0, 1000)
      assistant.choices = presented.bullets.slice(0, 4).map(choice => choice.slice(0, 300))
      assistant.status = 'done'
      boundHistory()
      if (assistant.activity) finishChatActivity(assistant.activity, 'done')
    } catch (error) {
      if (state.sessionId !== sessionId || abort !== current) return
      // Explicit Stop/Reset discards the transient continuation. A mode or
      // kill-switch invalidation keeps already checkpointed mutation keys;
      // identity reset and workspace rebinding clear it through reset/refresh.
      if (!current.signal.aborted && latestCheckpoint) continuation = latestCheckpoint
      assistant.status = turnExecution.signal.aborted ? 'canceled' : 'failed'
      assistant.content = turnExecution.signal.aborted
        ? assistant.content || 'Abgebrochen.'
        : [
            assistant.content,
            `Die Anfrage konnte nicht abgeschlossen werden. ${error instanceof Error ? error.message : 'Bitte erneut versuchen.'}`.slice(
              0,
              1800
            ),
          ]
            .filter(Boolean)
            .join('\n\n')
      if (assistant.activity) finishChatActivity(assistant.activity, assistant.status)
    } finally {
      if (abort === current) {
        if (turnExecution.signal.aborted && state.sessionId === sessionId) {
          assistant.status = 'canceled'
          assistant.content ||= 'Abgebrochen.'
          if (assistant.activity) finishChatActivity(assistant.activity, 'canceled')
          state.tools.forEach(tool => {
            if (['proposed', 'approved', 'executing'].includes(tool.status)) tool.status = 'canceled'
          })
        }
        state.busy = false
        state.thinkingBudget = null
        state.decision = null
        if (state.sessionId !== sessionId) state.notice = ''
        abort = null
        touch()
      }
    }
  }
  function dispatch(action: MiniAction) {
    if (action.type === 'ready') {
      refresh()
      return
    }
    if (action.type === 'mode') {
      deps.setMode(action.mode)
      refresh()
      return
    }
    if (
      action.type === 'main_decide' ||
      action.type === 'kill_switch' ||
      action.type === 'view' ||
      action.type === 'select_project' ||
      action.type === 'workflow_open' ||
      action.type === 'workflow_improve' ||
      action.type === 'workflow_action' ||
      action.type === 'workspace_open'
    )
      return
    if (action.sessionId !== state.sessionId) return
    switch (action.type) {
      case 'thinking_tier':
        if (isThinkingTier(action.tier)) {
          state.thinkingTier = action.tier
          touch()
        }
        break
      case 'thinking_control':
        if (state.busy && state.thinkingBudget?.requestId === action.requestId) {
          return controlLocalReasoning(action.requestId, action.action, action.sequence).then(progress => {
            if (state.thinkingBudget?.requestId === action.requestId) {
              if (progress.controlOutcome === 'stale')
                state.notice = 'Budgetstand aktualisiert. Bitte die gewünschte Aktion erneut wählen.'
              touch()
            }
            return progress
          })
        }
        break
      case 'send':
        return send(action.text)
      case 'stop':
        stop()
        break
      case 'reset':
        reset()
        break
      case 'decide':
        decide(action.id, action.approved)
        break
    }
  }
  refresh()
  return { state, refresh, dispatch, reset, stop }
}
