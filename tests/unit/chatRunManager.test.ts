import { describe, expect, it, vi } from 'vitest'
import {
  createChatRunJournal,
  createChatRunManager,
  reconcileRecoveredChatRuns,
  type ChatRunJournal,
} from '@/services/chatRunManager'
import { DEFAULT_STATE } from '@/state/defaults'
import { createChatActivity } from '@/services/chatActivity'
import { createGoalRunState } from '@/services/goals/autonomousGoal'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const input = (conversationId: string) => ({ principalId: 'person', projectId: 'project', conversationId })

describe('persistent chat run owner', () => {
  it('bounds a stuck worker stop and ignores late completion after native-confirmed recovery', async () => {
    vi.useFakeTimers()
    try {
      const manager = createChatRunManager(createChatRunJournal(false))
      const oldWork = deferred()
      let signal!: AbortSignal
      const old = manager.submit({ ...input('one'), runId: 'old' }, async handle => {
        signal = handle.signal
        await oldWork.promise
      })
      await vi.waitFor(() => expect(signal).toBeDefined())
      const generation = manager.requestStopAll()
      expect(signal.aborted).toBe(true)
      const wait = manager.waitForStop(20)
      await vi.advanceTimersByTimeAsync(20)
      expect(await wait).toEqual({ settled: false, pendingIds: ['old'] })
      expect(manager.resumeAfterStop()).toBe(false)
      expect(manager.recoverStopped({ generation: generation - 1, nativeStopped: true })).toBe(0)
      expect(manager.recoverStopped({ generation, nativeStopped: true })).toBe(1)
      await old
      expect(manager.resumeAfterStop()).toBe(true)
      const freshWork = deferred()
      const start = vi.fn(async () => freshWork.promise)
      const fresh = manager.submit({ ...input('one'), runId: 'fresh' }, start)
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
      oldWork.resolve()
      await vi.advanceTimersByTimeAsync(1)
      expect(manager.records.value.find(run => run.runId === 'old')?.state).toBe('cancelled')
      expect(manager.records.value.find(run => run.runId === 'fresh')?.state).toBe('running')
      freshWork.resolve()
      await fresh
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops and recovers admission stuck before its first durable commit without later executing it', async () => {
    vi.useFakeTimers()
    try {
      const preview = createChatRunJournal(false)
      const commit = deferred()
      const manager = createChatRunManager({
        ...preview,
        write: async (record, revision) => {
          if (!revision) await commit.promise
          return preview.write(record, revision)
        },
      })
      const start = vi.fn(async () => undefined)
      const submission = manager.submit({ ...input('one'), runId: 'admitting' }, start)
      const generation = manager.requestStopAll()
      await expect(manager.submit(input('two'), start)).rejects.toThrow('gestoppt')
      const wait = manager.waitForStop(10)
      await vi.advanceTimersByTimeAsync(10)
      expect(await wait).toEqual({ settled: false, pendingIds: ['admitting'] })
      expect(manager.recoverStopped({ generation, nativeStopped: true })).toBe(1)
      await submission
      commit.resolve()
      await vi.advanceTimersByTimeAsync(1)
      expect(start).not.toHaveBeenCalled()
      expect((await preview.list('person'))[0]?.state).toBe('cancelled')
      expect(await manager.waitForStop()).toEqual({ settled: true, pendingIds: [] })
    } finally {
      vi.useRealTimers()
    }
  })
  it('preserves submission order even when the second initial disk commit returns first', async () => {
    const preview = createChatRunJournal(false)
    const firstCommit = deferred()
    const journal: ChatRunJournal = {
      ...preview,
      write: async (record, revision) => {
        if (record.runId === 'first' && revision === 0) await firstCommit.promise
        return preview.write(record, revision)
      },
    }
    const manager = createChatRunManager(journal)
    const order: string[] = []
    const first = manager.submit({ ...input('one'), runId: 'first' }, async () => {
      order.push('first')
    })
    const second = manager.submit({ ...input('one'), runId: 'second' }, async () => {
      order.push('second')
    })
    await vi.waitFor(() => expect(manager.records.value.some(run => run.runId === 'second')).toBe(true))
    expect(order).toEqual([])
    firstCommit.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })
  it('keeps one conversation serial while another conversation runs independently', async () => {
    const manager = createChatRunManager(createChatRunJournal(false))
    const first = deferred()
    const order: string[] = []
    const one = manager.submit(input('one'), async () => {
      order.push('one')
      await first.promise
    })
    const same = manager.submit(input('one'), async () => {
      order.push('same')
    })
    const other = manager.submit(input('two'), async () => {
      order.push('other')
    })
    await vi.waitFor(() => expect(order).toEqual(['one', 'other']))
    await other
    expect(manager.hasLive('one')).toBe(true)
    first.resolve()
    await Promise.all([one, same])
    expect(order).toEqual(['one', 'other', 'same'])
    expect(manager.records.value.every(run => run.state === 'completed')).toBe(true)
  })

  it('stops exactly one run and drains its old callback before admitting the next same-chat run', async () => {
    const manager = createChatRunManager(createChatRunJournal(false))
    const finishing = deferred()
    let oldSignal!: AbortSignal
    let otherSignal!: AbortSignal
    const old = manager.submit({ ...input('one'), runId: 'old' }, async handle => {
      oldSignal = handle.signal
      await finishing.promise
    })
    const nextStart = vi.fn(async () => undefined)
    const next = manager.submit(input('one'), nextStart)
    const otherEnd = deferred()
    const other = manager.submit(input('two'), async handle => {
      otherSignal = handle.signal
      await otherEnd.promise
    })
    await vi.waitFor(() => expect(otherSignal).toBeDefined())
    let stopSettled = false
    const stopping = manager.stop('old').then(() => {
      stopSettled = true
    })
    expect(oldSignal.aborted).toBe(true)
    expect(otherSignal.aborted).toBe(false)
    await Promise.resolve()
    expect(stopSettled).toBe(false)
    expect(nextStart).not.toHaveBeenCalled()
    finishing.resolve()
    await Promise.all([old, next, stopping])
    expect(nextStart).toHaveBeenCalledOnce()
    otherEnd.resolve()
    await other
  })

  it('fails closed when initial or running journal commit fails', async () => {
    for (const rejectAt of [1, 2]) {
      const preview = createChatRunJournal(false)
      let writes = 0
      const journal: ChatRunJournal = {
        ...preview,
        write: async (...args) => {
          if (++writes === rejectAt) throw new Error('disk unavailable')
          return preview.write(...args)
        },
      }
      const start = vi.fn(async () => undefined)
      await expect(createChatRunManager(journal).submit(input('one'), start)).rejects.toThrow('disk unavailable')
      expect(start).not.toHaveBeenCalled()
    }
  })

  it('restores an interrupted run without replaying its effects or resurrecting approvals', async () => {
    const journal = createChatRunJournal(false)
    await journal.write(
      {
        ...input('one'),
        runId: 'previous',
        kind: 'chat',
        state: 'waiting_approval',
        revision: 0,
        createdAt: 1,
        updatedAt: 1,
        checkpoint: { messageId: 'partial-answer' },
      },
      0
    )
    const manager = createChatRunManager(journal)
    await manager.recover('person')
    expect(manager.records.value[0]).toMatchObject({
      state: 'interrupted',
      revision: 2,
      checkpoint: { messageId: 'partial-answer' },
    })
    expect(manager.hasLive()).toBe(false)
    const state = structuredClone(DEFAULT_STATE)
    const project = { ...state.projects[0]!, id: 'project' }
    state.projects = [project, { ...project, id: 'unrelated' }]
    const chat = { projectId: 'project', title: 'Chat', createdAt: 1, updatedAt: 1, archivedAt: null }
    state.conversations = [
      {
        ...chat,
        id: 'one',
        autonomousGoal: {
          ...createGoalRunState('Finish the saved task', true, 1),
          progress: 'Previously saved progress',
          lastMessageId: 'partial-answer',
        },
      },
      { ...chat, id: 'two', projectId: 'unrelated', autonomousGoal: createGoalRunState('Other task', true, 1) },
    ]
    state.pending.toolCallsByProject.project = [
      {
        id: 'old-approval',
        projectId: 'project',
        runId: 'previous',
        conversationId: 'one',
        name: 'fs_write',
        args: {},
        status: 'executing',
        requiresApproval: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    state.messages = [
      {
        id: 'partial-answer',
        projectId: 'project',
        conversationId: 'one',
        role: 'assistant',
        content: 'Preserved partial answer',
        ts: 1,
        createdAt: 1,
        parsed: null,
        visibility: 'visible',
        meta: { runId: 'previous', isLoading: true, activity: createChatActivity(1) },
      },
    ]
    expect(reconcileRecoveredChatRuns(state, manager.records.value)).toBe(3)
    expect(state.conversations[0]?.autonomousGoal).toMatchObject({
      active: false,
      status: 'waiting',
      revision: 2,
      progress: 'Previously saved progress',
      lastMessageId: 'partial-answer',
    })
    expect(state.conversations[1]?.autonomousGoal?.active).toBe(true)
    expect(state.pending.toolCallsByProject.project[0]?.status).toBe('canceled')
    expect(state.messages[0]).toMatchObject({
      content: 'Preserved partial answer',
      meta: { isLoading: false, activity: { status: 'canceled' } },
    })
    expect(reconcileRecoveredChatRuns(state, manager.records.value)).toBe(0)
    await manager.recover('someone-else')
    expect(manager.records.value).toHaveLength(1)
  })

  it('persists message identity and a continuation instead of falsely marking an incomplete answer complete', async () => {
    const journal = createChatRunJournal(false)
    const manager = createChatRunManager(journal)
    await manager.submit(input('one'), async handle => {
      await handle.setMessage('answer')
      await handle.setWaiting('resource')
      expect(manager.records.value[0]?.state).toBe('waiting_resource')
      await handle.setWaiting(null)
      await handle.interrupt('More work required')
    })
    expect((await journal.list('person'))[0]).toMatchObject({
      state: 'interrupted',
      checkpoint: { messageId: 'answer', summary: 'More work required' },
    })
  })
})
