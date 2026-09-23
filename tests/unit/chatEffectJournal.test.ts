import { describe, expect, it, vi } from 'vitest'
import { createChatEffectJournal, type EffectRecord } from '@/services/chatEffectJournal'

const owner = { principalId: 'person', projectId: 'project', conversationId: 'chat', runId: 'parent' }
const call = { id: 'call-id', name: 'fs_write', arguments: { path: 'private-path', content: 'private-content' } }

describe('durable tool effect boundary', () => {
  it('keeps a logical operation identity across fresh run and provider call IDs', async () => {
    const ids: string[] = []
    const store = {
      read: vi.fn(async (_owner: string, id: string) => {
        ids.push(id)
        return null
      }),
      write: vi.fn(async (record: EffectRecord, revision: number) => ({ ...record, revision: revision + 1 })),
    }
    await createChatEffectJournal(owner, store).before({ ...call, operationId: 'logical-operation' })
    await createChatEffectJournal({ ...owner, runId: 'restarted' }, store).before({
      ...call,
      id: 'fresh-call',
      operationId: 'logical-operation',
    })
    await createChatEffectJournal({ ...owner, conversationId: 'other-chat' }, store).before({
      ...call,
      operationId: 'logical-operation',
    })
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })
  it('commits safe metadata before effects and records completion without payloads', async () => {
    const writes: unknown[] = []
    const store = {
      read: vi.fn(async () => null),
      write: vi.fn(async (record: EffectRecord, revision: number) => {
        writes.push(record)
        return { ...record, revision: revision + 1 }
      }),
    }
    const journal = createChatEffectJournal(owner, store)
    const receipt = await journal.before(call)
    expect(writes[0]).toMatchObject({ state: 'started', checkpoint: { messageId: 'parent', summary: 'fs_write' } })
    await receipt.finish(true)
    expect(writes[1]).toMatchObject({ state: 'completed', revision: 1 })
    expect(JSON.stringify(writes)).not.toMatch(/private-path|private-content/)
    expect(store.write.mock.calls[0]?.[0].payloadHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('rejects an uncertain or already completed invocation before a repeat can execute', async () => {
    for (const status of ['started', 'completed', 'outcome_unknown'] as const) {
      const previous: EffectRecord = {
        ...owner,
        kind: 'device',
        state: status,
        payloadHash: 'a'.repeat(64),
        checkpoint: { messageId: owner.runId, summary: call.name },
      }
      const store = { read: vi.fn(async () => previous), write: vi.fn() }
      await expect(createChatEffectJournal(owner, store).before(call)).rejects.toThrow('nicht blind wiederholen')
      expect(store.write).not.toHaveBeenCalled()
    }
  })
  it('uses the same durable key after an uncertain write response and marks unsuccessful effects unknown', async () => {
    const keys: string[] = []
    const store = {
      read: vi.fn(async (_owner: string, runId: string) => {
        keys.push(runId)
        return null
      }),
      write: vi.fn(async (record: EffectRecord, revision: number) => ({ ...record, revision: revision + 1 })),
    }
    const first = await createChatEffectJournal(owner, store).before(call)
    await first.finish(false)
    await createChatEffectJournal(owner, store).before(call)
    expect(keys[0]).toBe(keys[1])
    expect(store.write.mock.calls[1]?.[0].state).toBe('outcome_unknown')
  })
  it('never admits the effect when reading or committing the journal fails', async () => {
    const store = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        throw new Error('disk full')
      }),
    }
    await expect(createChatEffectJournal(owner, store).before(call)).rejects.toThrow('Laufjournal')
  })
})
