import { reactive } from 'vue'
import type { AgentToolSession, RunAgentOptions } from '@/services/agent'
import type { LuczorMode, WireMessage } from '@/services/inference/types'
import { createChatActivity, finishChatActivity, updateChatActivity } from '@/services/chatActivity'
import { parseEnvelope } from '@/services/envelope'
import { compactHistory, normalizeConversationHistory, previewToolArguments } from '@/services/chatPresentation'
import { executionGate } from '@/services/executionGate'
import { emptyMiniSnapshot, type MiniAction, type MiniDecision, type MiniMessage } from './types'

type Context = { project: { id: string; name: string } | null; mode: LuczorMode; mainBusy: boolean }
type Dependencies = {
  context: () => Context
  setMode: (mode: 'observe' | 'act') => void
  preamble: (mode: LuczorMode, name: string) => string
  run: (options: RunAgentOptions) => Promise<{ finalText: string }>
}

/** Conversation and tool journal are never passed to persistence, sync or memory. */
export function createMiniChatController(deps: Dependencies) {
  const state = reactive(emptyMiniSnapshot())
  state.sessionId = crypto.randomUUID()
  let abort: AbortController | null = null
  let decisionResolve: ((approved: boolean) => void) | null = null

  function touch() {
    state.revision++
  }
  function refresh() {
    const context = deps.context()
    state.mode = context.mode
    state.mainBusy = context.mainBusy
    if (!state.messages.length && !state.busy) state.project = context.project ? { ...context.project } : null
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
    abort?.abort()
    if (state.decision) decide(state.decision.id, false)
    touch()
  }
  function reset() {
    stop()
    state.sessionId = crypto.randomUUID()
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
          sum + message.content.length + (message.question?.length ?? 0) + message.choices.join('').length,
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
    if (state.mainBusy) {
      state.notice = 'Der große Chat arbeitet noch. Bitte warte kurz.'
      touch()
      return
    }
    if (!state.project) {
      state.notice = 'Öffne zuerst ein Projekt in Luczor.'
      touch()
      return
    }
    const project = { ...state.project }
    const sessionId = state.sessionId
    const current = new AbortController()
    const turnExecution = executionGate.capture(current.signal)
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
      approve(id) {
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
          turnExecution.signal
        )
      },
    }
    try {
      const transcript: WireMessage[] = state.messages
        .filter(message => message.id !== assistant.id && message.status === 'done')
        .map(message => ({
          role: message.role,
          content: [message.content, message.question, ...message.choices].filter(Boolean).join('\n'),
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
      const result = await deps.run({
        projectId: project.id,
        mode: state.mode,
        getMode: () => deps.context().mode,
        baseMessages,
        contextEgress: 'local_only',
        routingSettings: { preference: 'local_only' },
        signal: turnExecution.signal,
        toolSession,
        onProgress(event) {
          if (valid() && assistant.activity) {
            updateChatActivity(assistant.activity, event)
            touch()
          }
        },
        onToken(content) {
          if (valid()) {
            const parsed = parseEnvelope(content)
            assistant.content = (parsed?.summary || content).slice(0, 16_000)
            touch()
          }
        },
      })
      executionGate.assert(turnExecution)
      if (!valid()) return
      const parsed = parseEnvelope(result.finalText)
      assistant.content = (parsed?.summary || result.finalText).slice(0, 16_000)
      assistant.question = parsed?.question?.slice(0, 1000)
      assistant.choices = (parsed?.bullets ?? []).slice(0, 4).map(choice => choice.slice(0, 300))
      assistant.status = 'done'
      boundHistory()
      if (assistant.activity) finishChatActivity(assistant.activity, 'done')
    } catch (error) {
      if (state.sessionId !== sessionId || abort !== current) return
      assistant.status = turnExecution.signal.aborted ? 'canceled' : 'failed'
      assistant.content = turnExecution.signal.aborted
        ? 'Abgebrochen.'
        : `Die Anfrage konnte nicht abgeschlossen werden. ${error instanceof Error ? error.message : 'Bitte erneut versuchen.'}`.slice(
            0,
            1800
          )
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
    if (action.type === 'main_decide' || action.type === 'kill_switch') return
    if (action.sessionId !== state.sessionId) return
    switch (action.type) {
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
