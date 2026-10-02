import { describe, expect, it, vi } from 'vitest'
import { createRunCoordinator } from '@/services/runs/runCoordinator'
import { createMemoryRunArchiveStore, createRunArchive } from '@/services/runs/runArchive'
import { focusedTools } from '@/services/inference/focusedTools'
import { checkpointMessageRetention } from '@/services/runs/checkpointMessageRetention'
import { stateForPersistence } from '@/services/persistence'
import { DEFAULT_STATE } from '@/state/defaults'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { WireMessage } from '@/services/inference/types'

const scope = { principalId: 'account', projectId: 'project', conversationId: 'chat', runId: 'current' }
const key = async () => 'ab'.repeat(32)
const source: WireMessage[] = [
  { role: 'system', content: 'PRIVATE INSTRUCTION' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'read-1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"original.ts"}' } },
    ],
  },
  { role: 'tool', name: 'fs_read', tool_call_id: 'read-1', content: 'EXACT_SOURCE\n' + '😀'.repeat(6000) },
]
const checkpoint = (messages = source): AgentCheckpoint => ({
  principalScopeId: scope.principalId,
  projectId: scope.projectId,
  conversationId: scope.conversationId,
  sessionId: 'prior',
  generation: 1,
  objective: 'completed prior work',
  messages,
  completedMutations: [],
  ephemeralDataUsed: true,
  dataPolicy: 'local_only',
})

describe('completed archive history', () => {
  it('reads one completed same-chat archive after restart, preserving originals and ignoring unfinished or foreign archives', async () => {
    const store = createMemoryRunArchiveStore()
    const first = createRunArchive({ store, key })
    for (const [runId, overrides, state] of [
      ['prior', {}, 'completed'],
      ['working', {}, 'working'],
      ['cancelled', {}, 'cancelled'],
      ['other-chat', { conversationId: 'other' }, 'completed'],
      ['other-project', { projectId: 'other' }, 'completed'],
      ['other-account', { principalId: 'other' }, 'completed'],
      ['current', {}, 'completed'],
    ] as const) {
      const target = { ...scope, runId, ...overrides }
      await first.capture({
        ...target,
        state,
        messageId: `answer-${runId}`,
        checkpoint: {
          ...checkpoint(),
          principalScopeId: target.principalId,
          projectId: target.projectId,
          conversationId: target.conversationId,
        },
      })
    }
    const restarted = createRunArchive({ store, key })
    const load = vi.spyOn(restarted, 'load')
    const list = vi.spyOn(restarted, 'list')
    const assertCurrent = vi.fn()
    const history = createRunCoordinator(restarted).historySource(scope, assertCurrent)
    expect(await history.list()).toEqual([expect.objectContaining({ runId: 'prior', available: true })])
    expect(load).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledExactlyOnceWith(scope.principalId, {
      projectId: scope.projectId,
      conversationId: scope.conversationId,
    })
    for (const id of ['working', 'cancelled', 'other-chat', 'other-project', 'other-account', 'current', 'guessed'])
      await expect(history.messages(id)).rejects.toThrow('archive_not_available')
    expect(load).not.toHaveBeenCalled()
    expect(await history.messages('prior')).toEqual(source)
    expect(await history.messages('prior')).toEqual(source)
    expect(load).toHaveBeenCalledExactlyOnceWith({ ...scope, runId: 'prior' })
    expect(assertCurrent).toHaveBeenCalled()
  })

  it('checks authority after an asynchronous load and does not expose data after revocation', async () => {
    const archive = createRunArchive({ key })
    await archive.capture({
      ...scope,
      runId: 'prior',
      messageId: 'answer',
      checkpoint: checkpoint(),
      state: 'completed',
    })
    let allowed = true
    const history = createRunCoordinator(archive).historySource(scope, () => {
      if (!allowed) throw new Error('revoked')
    })
    await history.list()
    const load = archive.load.bind(archive)
    vi.spyOn(archive, 'load').mockImplementation(async input => {
      const result = await load(input)
      allowed = false
      return result
    })
    await expect(history.messages('prior')).rejects.toThrow('revoked')
    await expect(history.list()).rejects.toThrow('revoked')
  })

  it('reports an old omitted archive without claiming its original data can be recovered', async () => {
    const archive = createRunArchive({ key })
    await archive.capture({
      ...scope,
      runId: 'old',
      messageId: 'answer',
      checkpoint: { ...checkpoint(), dataPolicy: 'ephemeral' },
      state: 'completed',
    })
    const history = createRunCoordinator(archive).historySource(scope, () => undefined)
    expect(await history.list()).toEqual([expect.objectContaining({ runId: 'old', available: false })])
    await expect(history.messages('old')).rejects.toThrow('archive_content_not_retained')
  })

  it('bounds archive metadata and original-message pages, without injecting archives into current history', async () => {
    const messages = vi.fn(async () => source)
    const list = vi.fn(async () =>
      Array.from({ length: 10 }, (_, i) => ({
        runId: `prior-${i}`,
        updatedAt: i,
        messageId: `answer-${i}`,
        available: true,
      }))
    )
    const focus = focusedTools('Continue using earlier sources', () => [{ role: 'user', content: 'current' }], [], {
      list,
      messages,
    })
    expect(focus.reader).toMatchObject({ dataHandling: 'ephemeral', retentionPolicy: 'local_only' })
    expect(focus.reader.description).toMatch(/completed.*archives/)
    expect(await focus.reader.execute({}, { projectId: 'project' })).toMatchObject({ matches: [{ index: 0 }] })
    expect(await focus.reader.execute({ archives: false }, { projectId: 'project' })).toMatchObject({
      matches: [{ index: 0 }],
    })
    expect(list).not.toHaveBeenCalled()
    const first = await focus.reader.execute({ archives: true }, { projectId: 'project' })
    expect(first).toMatchObject({ nextOffset: 8 })
    expect((first as { archives: unknown[] }).archives).toHaveLength(8)
    expect(await focus.reader.execute({ archives: true, offset: 8 }, { projectId: 'project' })).toMatchObject({
      nextOffset: null,
    })
    expect(messages).not.toHaveBeenCalled()
    expect(
      await focus.reader.execute({ run_id: 'prior-0', query: 'EXACT_SOURCE' }, { projectId: 'project' })
    ).toMatchObject({ runId: 'prior-0', historical: true, matches: [{ index: 2 }] })
    let reconstructed = '',
      offset = 0
    do {
      const page = (await focus.reader.execute(
        { run_id: 'prior-0', index: 2, offset, limit: 128 },
        { projectId: 'project' }
      )) as { text: string; nextOffset: number | null; historical: boolean }
      expect(page.text.length).toBeLessThanOrEqual(128)
      expect(page.historical).toBe(true)
      reconstructed += page.text
      if (page.nextOffset === null) break
      offset = page.nextOffset
    } while (true)
    expect(reconstructed).toBe(source[2]!.content)
    await expect(focus.reader.execute({ run_id: 'prior-0', index: 0 }, { projectId: 'project' })).rejects.toThrow(
      'gültige Indizes'
    )
    await expect(focus.reader.execute({ archives: true, run_id: 'prior-0' }, { projectId: 'project' })).rejects.toThrow(
      'Archiv'
    )
    await expect(focus.reader.execute({ archives: true, query: 'source' }, { projectId: 'project' })).rejects.toThrow(
      'Archiv'
    )
    await expect(
      focusedTools('none', () => []).reader.execute({ run_id: 'prior-0' }, { projectId: 'project' })
    ).rejects.toThrow('Archiv')
  })

  it('keeps a persisted checkpoint answer and commentary locally without allowing egress or changing activity', () => {
    const state = structuredClone(DEFAULT_STATE)
    const meta = {
      isLoading: true,
      retentionPolicy: 'ephemeral' as const,
      dataHandling: 'ephemeral' as const,
      serverSpeechAllowed: false,
      activity: { startedAt: 1, status: 'running' as const, steps: [] },
      commentary: [
        { id: 'round-1', round: 1, createdAt: 1, content: 'Earlier source explanation', serverSpeechAllowed: false },
      ],
    }
    state.messages = [
      {
        id: 'answer',
        projectId: 'default',
        role: 'assistant',
        content: 'Retained answer',
        raw: 'Retained raw',
        parsed: null,
        visibility: 'visible',
        ts: 1,
        createdAt: 1,
        meta,
      },
    ]
    state.messages[0]!.meta = { ...meta, ...checkpointMessageRetention({ dataPolicy: 'local_only', gaps: [] }) }
    const saved = stateForPersistence(state).messages[0]!
    expect(saved.content).toBe('Retained answer')
    expect(saved.raw).toBe('Retained raw')
    expect(saved.meta).toEqual({ ...meta, retentionPolicy: 'local_only' })
    expect(
      checkpointMessageRetention({ dataPolicy: 'ephemeral', gaps: [{ reason: 'ephemeral_data', messageCount: 1 }] })
    ).toMatchObject({ retentionPolicy: 'ephemeral' })
  })
})
