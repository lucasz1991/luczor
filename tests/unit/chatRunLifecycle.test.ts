import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { stopCapturedChatRun, type ChatStopSnapshot } from '@/services/chatRunLifecycle'
import { executionAbortReason } from '@/services/inference/interruption'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => (resolve = done))
  return { promise, resolve }
}

function fixture(controller: AbortController | null = new AbortController()) {
  let current: ChatStopSnapshot = {
    generation: 1,
    controller,
    cancel: controller ? vi.fn(async () => controller.abort()) : null,
  }
  const finishCurrent = vi.fn()
  const clearCurrent = vi.fn(() => {
    current.controller = null
    current.cancel = null
  })
  const options = {
    capture: () => ({ ...current }),
    isCurrent: (snapshot: ChatStopSnapshot) =>
      snapshot.generation === current.generation &&
      snapshot.controller === current.controller &&
      snapshot.cancel === current.cancel,
    finishCurrent,
    clearCurrent,
  }
  return {
    options,
    get current() {
      return current
    },
    admit(controller: AbortController | null = new AbortController()) {
      current = { generation: current.generation + 1, controller, cancel: null }
      return controller
    },
  }
}

describe('captured chat cancellation', () => {
  it('the App stop handler captures run IDs before awaiting goal teardown and leaves a newly selected run alive', async () => {
    const app = readFileSync('src/App.vue', 'utf8')
    const start = app.indexOf('async function stopGenerating(')
    const source = app.slice(start, app.indexOf('\nfunction openProject(', start))
    const goal = deferred()
    const records = [{ runId: 'old', conversationId: 'one', projectId: 'project', state: 'running' }]
    const activeConversationId = { value: 'one' }
    const stop = vi.fn(async () => undefined)
    const context = {
      chatRuns: { records: { value: records }, stop },
      chatRunIsLive: (run: { state: string }) => run.state === 'running',
      activeConversationId,
      state: { pending: { toolCallsByProject: {} } },
      getSafeRecordValue: () => [],
      resolveApproval: vi.fn(),
      executionAbortReason,
      autonomousGoal: { running: { value: true }, stop: () => goal.promise },
      stopVoiceOutput: vi.fn(),
    }
    const stopGenerating = runInNewContext(`${source}\nstopGenerating`, context) as () => Promise<void>
    const pending = stopGenerating()
    expect(stop).toHaveBeenCalledExactlyOnceWith('old', expect.anything())
    records.push({ runId: 'new', conversationId: 'two', projectId: 'project', state: 'running' })
    activeConversationId.value = 'two'
    goal.resolve()
    await pending
    expect(stop).toHaveBeenCalledOnce()
    expect(context.stopVoiceOutput).toHaveBeenCalledOnce()
  })

  it('aborts the captured answer immediately and never cancels a new answer after goal teardown', async () => {
    const context = fixture()
    const previous = context.current.controller!
    const goal = deferred()
    const stopping = stopCapturedChatRun({ ...context.options, pauseGoal: () => goal.promise })
    expect(previous.signal.aborted).toBe(true)
    expect(context.options.finishCurrent).toHaveBeenCalledTimes(1)
    const next = context.admit()!
    goal.resolve()
    await stopping
    expect(next.signal.aborted).toBe(false)
    expect(context.options.finishCurrent).toHaveBeenCalledTimes(1)
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
    expect(context.current.controller).toBe(next)
  })

  it('does not clear the new turn while an old cancellation callback settles', async () => {
    const context = fixture()
    const cancellation = deferred()
    context.current.cancel = vi.fn(() => cancellation.promise)
    const oldCancel = context.current.cancel
    const stopping = stopCapturedChatRun(context.options)
    const next = context.admit()!
    cancellation.resolve()
    await stopping
    expect(oldCancel).toHaveBeenCalledTimes(1)
    expect(next.signal.aborted).toBe(false)
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
  })

  it('protects a newly admitted turn even when both old and new controllers are still null', async () => {
    const context = fixture(null)
    const goal = deferred()
    const stopping = stopCapturedChatRun({ ...context.options, pauseGoal: () => goal.promise })
    context.admit(null)
    goal.resolve()
    await stopping
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
    expect(context.options.finishCurrent).toHaveBeenCalledTimes(1)
  })

  it('cleans up the same current turn after all cancellation work settles', async () => {
    const context = fixture()
    const goal = deferred()
    const stopping = stopCapturedChatRun({ ...context.options, pauseGoal: () => goal.promise })
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
    goal.resolve()
    await stopping
    expect(context.options.clearCurrent).toHaveBeenCalledTimes(1)
    expect(context.current.controller).toBeNull()
  })

  it('still aborts the captured controller when auxiliary cleanup throws', async () => {
    const context = fixture()
    const previous = context.current.controller!
    context.current.cancel = () => Promise.reject(new Error('Already stopped'))
    await stopCapturedChatRun({
      ...context.options,
      pauseGoal: () => {
        throw new Error('Persistence unavailable')
      },
    })
    expect(previous.signal.aborted).toBe(true)
    expect(context.options.clearCurrent).toHaveBeenCalledTimes(1)
  })
})
