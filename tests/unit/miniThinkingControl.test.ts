import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ThinkingBudgetControl from '@/components/ai/ThinkingBudgetControl.vue'
import { createMiniThinkingControl } from '@/services/miniChat/thinkingControl'
import { emptyMiniSnapshot, type MiniAction } from '@/services/miniChat/types'
import type { ThinkingBudgetProgress } from '@/services/inference/thinking'

const budget = (): ThinkingBudgetProgress => ({
  requestId: 'generation-1',
  tier: 'fast',
  phase: 'thinking',
  generatedTokens: 410,
  softTargetTokens: 512,
  thinkingLimitTokens: 4096,
  requestedThinkingLimitTokens: 4096,
  outputLimitTokens: 30000,
  responseReserveTokens: 4096,
  warning: true,
  canExtend: true,
  canAnswer: true,
  answerRequested: false,
  elapsedMs: 1000,
  sequence: 10,
})
function setup() {
  const snapshot = ref({ ...emptyMiniSnapshot(), sessionId: 'session-1', busy: true, thinkingBudget: budget() })
  const send = vi.fn<(value: MiniAction) => void>()
  const error = ref('')
  const controller = createMiniThinkingControl(
    () => snapshot.value,
    send,
    () => error.value
  )
  const start = () => controller.control('generation-1', 'answer', 10)
  const ack = (overrides: Partial<ThinkingBudgetProgress> = {}) => {
    const action = send.mock.calls.at(-1)?.[0]
    if (action?.type !== 'thinking_control') throw new Error('Missing control')
    return {
      controlId: action.controlId,
      requestId: action.requestId,
      progress: { ...budget(), sequence: 11, answerRequested: true, controlOutcome: 'applied' as const, ...overrides },
    }
  }
  return { snapshot, send, controller, start, ack, error }
}
afterEach(() => vi.useRealTimers())

describe('mini thinking control acknowledgement', () => {
  it('waits for a correlated runtime acknowledgement, not emit or ordinary progress', async () => {
    const { snapshot, send, start, ack, controller } = setup()
    let settled = false
    const pending = start().then(value => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(start()).rejects.toThrow('wartet')
    expect(send).toHaveBeenCalledTimes(1)
    snapshot.value.thinkingBudget = { ...budget(), sequence: 11 }
    snapshot.value.thinkingControlAck = { ...ack(), controlId: 'wrong-control' }
    await Promise.resolve()
    expect(settled).toBe(false)
    snapshot.value.thinkingControlAck = ack()
    expect(await pending).toMatchObject({ phase: 'thinking', answerRequested: true, controlOutcome: 'applied' })
    controller.dispose()
  })
  it.each(['stale', 'unavailable'] as const)('returns the actual %s outcome without replay', async outcome => {
    const { snapshot, send, start, ack, controller } = setup()
    const pending = start()
    snapshot.value.thinkingControlAck = ack({ controlOutcome: outcome })
    expect((await pending).controlOutcome).toBe(outcome)
    expect(send).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
  it.each(['session', 'request', 'connection', 'dispose'] as const)(
    'rejects an outstanding control after %s invalidation',
    async cause => {
      const { snapshot, start, error, controller } = setup()
      const pending = start()
      if (cause === 'session') snapshot.value.sessionId = 'session-2'
      else if (cause === 'request') snapshot.value.thinkingBudget = { ...budget(), requestId: 'generation-2' }
      else if (cause === 'connection') error.value = 'Verbindung unterbrochen'
      else controller.dispose()
      await expect(pending).rejects.toThrow()
      controller.dispose()
    }
  )
  it('times out an unacknowledged delivery without repeating the command', async () => {
    vi.useFakeTimers()
    const { start, send, controller } = setup()
    const pending = start().then(
      () => null,
      error => error as Error
    )
    await vi.advanceTimersByTimeAsync(10000)
    expect((await pending)?.message).toContain('keine Aktion automatisch wiederholt')
    expect(send).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
  it('renders automatic failed control explicitly and never treats ACK as public output', async () => {
    const render = (progress: ThinkingBudgetProgress) =>
      renderToString(
        createSSRApp({
          render: () => h(ThinkingBudgetControl, { progress }),
        })
      )
    const requested = { ...budget(), answerRequested: true }
    expect(await render(requested)).toContain('Antwort angefordert')
    expect(await render(requested)).not.toContain('Antwort wird geschrieben')
    const failed = await render({ ...requested, controlOutcome: 'unavailable', canAnswer: false, canExtend: false })
    expect(failed).toContain('Denksteuerung unterbrochen')
    expect(failed).toContain('Der Denkabschluss wurde nicht bestätigt')
    expect(failed).not.toContain('Antwort wird geschrieben')
  })
})
