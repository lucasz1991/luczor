import { describe, expect, it, vi } from 'vitest'
import { createMiniChatController } from '@/services/miniChat/controller'
import { miniStatus } from '@/services/miniChat/presentation'
import { emptyMiniSnapshot } from '@/services/miniChat/types'
import type { RunAgentOptions } from '@/services/agent'
import { executionGate } from '@/services/executionGate'
import { LocalInferenceError } from '@/services/inference/localModelManager'
import { pendingPayloadApproval } from '@/services/payloadApproval'

function setup(
  run = vi
    .fn<(options: RunAgentOptions) => Promise<{ finalText: string }>>()
    .mockResolvedValue({ finalText: 'Eine kurze Antwort.' })
) {
  const context = { project: { id: 'project-a', name: 'Projekt A' }, mode: 'act' as 'act' | 'observe', mainBusy: false }
  const controller = createMiniChatController({
    context: () => context,
    run,
    preamble: () => 'System',
    setMode: mode => {
      context.mode = mode
    },
  })
  const send = (text = 'Hallo') => controller.dispatch({ type: 'send', sessionId: controller.state.sessionId, text })
  return { controller, context, run, send }
}

describe('temporary mini chat session', () => {
  it('retains completed commentary during the next round, final answer and subsequent turn', async () => {
    let options!: RunAgentOptions
    let release!: (value: { finalText: string }) => void
    const { controller, send } = setup(
      vi.fn(value => {
        options = value
        return new Promise(resolve => {
          release = resolve
        })
      })
    )
    const pending = send()
    options.onToken?.('{"summary":"Ich prüfe gerade')
    expect(controller.state.messages[1]?.content).toBe('Ich prüfe gerade')
    options.onRoundComplete?.({
      round: 1,
      kind: 'commentary',
      content: '{"summary":"Ich prüfe die Datei."}',
      serverSpeechAllowed: true,
    })
    options.onToken?.('{"answer":"Das erste Ergeb')
    expect(controller.state.messages[1]?.commentary?.[0]?.content).toBe('Ich prüfe die Datei.')
    expect(controller.state.messages[1]?.content).toBe('Das erste Ergeb')
    release({ finalText: '{"answer":"Die Prüfung ist fertig."}' })
    await pending
    expect(controller.state.messages[1]?.commentary).toHaveLength(1)
    expect(controller.state.messages[1]?.content).toBe('Die Prüfung ist fertig.')
    const next = send('Weiter')
    expect(controller.state.messages[1]?.commentary?.[0]?.content).toBe('Ich prüfe die Datei.')
    release({ finalText: 'Nächster Schritt.' })
    await next
    expect(controller.state.messages[1]?.commentary).toHaveLength(1)
  })

  it('shows live counts and text, hides partial envelope syntax and ignores callbacks after cancellation', async () => {
    let options!: RunAgentOptions
    let release!: (value: { finalText: string }) => void
    const { controller, send } = setup(
      vi.fn(value => {
        options = value
        return new Promise(resolve => {
          release = resolve
        })
      })
    )
    const pending = send()
    const usage = { inputTokens: 12, outputTokens: 2, totalTokens: 14, source: 'estimated' as const, rounds: 1 }
    options.onUsage?.(usage)
    options.onToken?.('{"sum')
    expect(controller.state.messages[1]).toMatchObject({ content: '', tokenUsage: usage })
    options.onToken?.('{"summary":"Hallo')
    expect(controller.state.messages[1]?.content).toBe('Hallo')
    controller.stop()
    options.onToken?.('Später Text')
    options.onUsage?.({ ...usage, totalTokens: 999 })
    expect(controller.state.messages[1]).toMatchObject({ content: 'Hallo', tokenUsage: usage })
    release({ finalText: 'Spätes Ende' })
    await pending
    expect(controller.state.messages[1]?.status).toBe('canceled')
  })

  it('keeps its own transcript and returns structured answer choices', async () => {
    const { controller, send, run } = setup(
      vi.fn().mockResolvedValue({
        finalText: '{"summary":"Zwei Wege.","question":"Was passt?","bullets":["Kurz","Ausführlich"]}',
      })
    )
    await send()
    expect(controller.state.messages).toHaveLength(2)
    expect(controller.state.messages[1]).toMatchObject({
      content: 'Zwei Wege.',
      question: 'Was passt?',
      choices: ['Kurz', 'Ausführlich'],
      status: 'done',
    })
    expect(run.mock.calls[0]![0].toolSession).toBeDefined()
    expect(controller.state.busy).toBe(false)
  })
  it('keeps the captured project across active-project changes until reset', async () => {
    const { controller, context, send, run } = setup()
    await send()
    context.project = { id: 'project-b', name: 'Projekt B' }
    await send('Weiter')
    expect(run.mock.calls[1]![0].projectId).toBe('project-a')
    controller.reset()
    expect(controller.state.project?.id).toBe('project-b')
    expect(controller.state.messages).toEqual([])
  })
  it('does not start a competing inference while the project chat is running', async () => {
    const { controller, context, send, run } = setup()
    context.mainBusy = true
    await send()
    expect(run).not.toHaveBeenCalled()
    expect(controller.state.notice).toContain('große Chat')
  })
  it('validates input and ignores stale session commands', async () => {
    const { controller, send, run } = setup()
    await send('x'.repeat(12001))
    const old = controller.state.sessionId
    controller.reset()
    await controller.dispatch({ type: 'send', sessionId: old, text: 'Veraltet' })
    expect(run).not.toHaveBeenCalled()
  })
  it('resolves an actual tool approval once and does not accept a stale decision', async () => {
    let result: boolean | undefined
    const { controller, send } = setup(
      vi.fn(async options => {
        options.toolSession!.queue({
          id: 'tool-a',
          name: 'file_write',
          args: { path: 'notes.md' },
          category: 'project',
          requiresApproval: true,
          status: 'proposed',
        })
        result = await options.toolSession!.approve('tool-a')
        return { finalText: result ? 'Freigegeben' : 'Abgelehnt' }
      })
    )
    const pending = send()
    const id = controller.state.decision!.id
    controller.dispatch({ type: 'decide', sessionId: controller.state.sessionId, id: 'wrong', approved: true })
    expect(controller.state.decision?.id).toBe(id)
    controller.dispatch({ type: 'decide', sessionId: controller.state.sessionId, id, approved: false })
    controller.dispatch({ type: 'decide', sessionId: controller.state.sessionId, id, approved: true })
    await pending
    expect(result).toBe(false)
    expect(controller.state.decision).toBeNull()
  })
  it('cancellation settles a pending approval without leaving a spinner', async () => {
    let approved: boolean | undefined
    const { controller, send } = setup(
      vi.fn(async options => {
        options.toolSession!.queue({
          id: 'tool-a',
          name: 'file_write',
          args: {},
          category: 'project',
          requiresApproval: true,
          status: 'proposed',
        })
        approved = await options.toolSession!.approve('tool-a')
        return { finalText: 'Late result' }
      })
    )
    const pending = send()
    controller.stop()
    await pending
    expect(approved).toBe(false)
    expect(controller.state.busy).toBe(false)
    expect(controller.state.messages[1]?.status).toBe('canceled')
    expect(controller.state.tools[0]?.status).toBe('canceled')
  })
  it('keeps Mini requests local and never provides an external packet or approval callback', async () => {
    const { send, run } = setup()
    await send('Prüfe C:\\Users\\Example\\notes.txt')
    const options = run.mock.calls[0]![0]
    expect(options).toMatchObject({ contextEgress: 'local_only', routingSettings: { preference: 'local_only' } })
    expect(options.externalBaseMessages).toBeUndefined()
    expect(options.externalPackage).toBeUndefined()
    expect(options.requestExternalApproval).toBeUndefined()
    expect(options.baseMessages.at(-1)?.content).toContain('C:\\Users\\Example\\notes.txt')
    expect(pendingPayloadApproval.value).toBeNull()
  })
  it('shows local readiness failures without opening an external fallback approval', async () => {
    const { controller, send } = setup(
      vi
        .fn()
        .mockRejectedValue(
          new LocalInferenceError(
            'Die lokale Modellruntime ist in dieser App noch nicht eingerichtet.',
            'local_only_blocked',
            false,
            false
          )
        )
    )
    await send()
    expect(controller.state.messages.at(-1)).toMatchObject({
      status: 'failed',
      content: expect.stringContaining('Modellruntime ist in dieser App noch nicht eingerichtet'),
    })
    expect(controller.state.busy).toBe(false)
    expect(controller.state.decision).toBeNull()
    expect(pendingPayloadApproval.value).toBeNull()
  })
  it('cancels a stale result when the shared execution identity changes', async () => {
    let release!: (value: { finalText: string }) => void
    let signal: AbortSignal | undefined
    const { controller, send } = setup(
      vi.fn(async options => {
        signal = options.signal
        return new Promise(resolve => {
          release = resolve
        })
      })
    )

    const pending = send()
    executionGate.invalidate()
    release({ finalText: 'Veraltetes Ergebnis' })
    await pending

    expect(signal?.aborted).toBe(true)
    expect(controller.state.messages[1]).toMatchObject({ status: 'canceled', content: 'Abgebrochen.' })
    expect(controller.state.busy).toBe(false)
  })
  it('clear hides old text immediately but keeps inference locked until the old run settles', async () => {
    let release!: (value: { finalText: string }) => void
    let options!: RunAgentOptions
    const { controller, send, run } = setup(
      vi.fn(async value => {
        options = value
        return new Promise(resolve => {
          release = resolve
        })
      })
    )
    const pending = send()
    controller.reset()
    expect(controller.state.messages).toEqual([])
    expect(controller.state.busy).toBe(true)
    await send('Darf noch nicht starten')
    options.onToken?.('Spätes Ergebnis')
    options.onProgress?.({ phase: 'receiving', characters: 900 })
    release({ finalText: 'Nicht wiederherstellen' })
    await pending
    expect(run).toHaveBeenCalledTimes(1)
    expect(controller.state.messages).toEqual([])
    expect(controller.state.busy).toBe(false)
  })
  it('bounds output retained by the overlay', async () => {
    const { controller, send } = setup(vi.fn().mockResolvedValue({ finalText: 'x'.repeat(100000) }))
    for (let i = 0; i < 8; i++) await send()
    expect(controller.state.messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(
      80000
    )
    expect(controller.state.messages.every(message => message.content.length <= 16000)).toBe(true)
  })
})

describe('meaningful circular status', () => {
  it('prioritizes decisions and emergency stop above animation states', () => {
    const state = emptyMiniSnapshot()
    state.busy = true
    expect(miniStatus(state).phase).toBe('thinking')
    state.decision = { id: 'd', kind: 'tool', title: 'Speichern?', description: '', detail: '' }
    expect(miniStatus(state)).toMatchObject({ phase: 'waiting', label: 'Deine Entscheidung' })
    state.hud.killSwitch = true
    expect(miniStatus(state).phase).toBe('stopped')
  })
  it('shows listening only for real microphone status and execution only for actual tools', () => {
    const state = emptyMiniSnapshot()
    expect(miniStatus(state).phase).toBe('idle')
    state.hud.status = 'listening'
    expect(miniStatus(state).phase).toBe('listening')
    state.busy = true
    state.tools.push({ id: 'a', name: 'file_read', detail: '', status: 'executing' })
    expect(miniStatus(state).phase).toBe('executing')
  })
})
