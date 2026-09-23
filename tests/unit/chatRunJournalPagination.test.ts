import { describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => false }))
import { createChatRunJournal, createChatRunManager, type ChatRunRecord } from '@/services/chatRunManager'

describe('complete native run recovery', () => {
  it('recovers all old live runs even behind more than 500 recent terminal records', async () => {
    const records: ChatRunRecord[] = Array.from({ length: 850 }, (_, i) => ({
      kind: 'chat',
      principalId: 'owner',
      projectId: 'project',
      conversationId: `chat-${i}`,
      runId: `run-${i.toString().padStart(4, '0')}`,
      state: i < 250 ? 'running' : i < 275 ? 'interrupted' : 'completed',
      revision: 1,
      createdAt: i,
      updatedAt: i,
    }))
    native.invoke.mockImplementation(async (command: string, { payload }: { payload: Record<string, unknown> }) => {
      if (command === 'device_run_journal_list') {
        const states = payload.states as string[] | undefined
        const after = payload.after as { updatedAt: number; runId: string } | undefined
        return records
          .filter(
            run =>
              (!states || states.includes(run.state)) &&
              (!after ||
                run.updatedAt < after.updatedAt ||
                (run.updatedAt === after.updatedAt && run.runId > after.runId))
          )
          .sort((left, right) => right.updatedAt - left.updatedAt || left.runId.localeCompare(right.runId))
          .slice(0, 200)
          .map(run => structuredClone(run))
      }
      if (command === 'device_run_journal_transition') {
        const incoming = payload.record as ChatRunRecord
        const record = records.find(run => run.runId === incoming.runId)!
        if (record.revision !== payload.expectedRevision) throw new Error('CAS revision mismatch')
        Object.assign(record, incoming, { revision: record.revision + 1 })
        return structuredClone(record)
      }
      throw new Error(command)
    })
    const manager = createChatRunManager(createChatRunJournal(true))
    await manager.recover('owner')
    expect(records.filter(run => run.state === 'running')).toEqual([])
    expect(records.filter(run => run.state === 'interrupted')).toHaveLength(275)
    expect(manager.records.value.filter(run => run.state === 'interrupted')).toHaveLength(275)
    const lists = native.invoke.mock.calls.filter(([command]) => command === 'device_run_journal_list')
    expect(lists).toHaveLength(3)
    expect(lists[1]![1].payload.after).toBeDefined()
  })
})
