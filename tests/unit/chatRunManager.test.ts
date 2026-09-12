import { describe, expect, it, vi } from 'vitest'
import { createChatRunJournal, createChatRunManager, type ChatRunJournal } from '@/services/chatRunManager'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const input = (conversationId: string) => ({ principalId: 'person', projectId: 'project', conversationId })

describe('persistent chat run owner', () => {
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
