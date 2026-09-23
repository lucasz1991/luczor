import { describe, expect, it, vi } from 'vitest'
import { createResearchStore, type SavedResearch } from '@/services/research/store'
import { createMemoryRunArchiveStore, createRunArchive } from '@/services/runs/runArchive'

function fixture(): SavedResearch {
  return {
    run: {
      id: 'r',
      principalId: 'account',
      projectId: 'project',
      conversationId: 'chat',
      workspaceBindingId: 'workspace',
      topic: 'Öffentliche Quellen',
      depth: 'deep',
      stage: 'collecting',
      status: 'paused',
      revision: 4,
      createdAt: 1,
      updatedAt: 2,
      asOf: '2026-09-23',
      outputDir: 'C:/Research/Quellen',
      questions: [],
      sources: [],
      claims: [],
      artifacts: [],
      blockers: [],
    },
    binding: {
      principalId: 'account',
      projectId: 'project',
      chatId: 'chat',
      runId: 'r',
      rootPath: 'C:/Research/Quellen',
      revision: 1,
      workflowScope: {
        principalId: 'account',
        projectId: 'project',
        runId: 'r',
        researchId: 'r',
        expectedRootPath: 'C:/Research/Quellen',
        expectedWorkspaceUpdatedAt: 1,
      },
    },
    prepare: {
      principalId: 'account',
      projectId: 'project',
      chatId: 'chat',
      runId: 'r',
      target: 'central',
      centralRoot: 'C:/Research',
      slug: 'quellen',
      title: 'Öffentliche Quellen',
    },
    queries: ['official sources'],
    checkpoint: {
      projectId: 'project',
      principalScopeId: 'account',
      conversationId: 'chat',
      workspaceBindingId: 'workspace',
      sessionId: 'session',
      generation: 1,
      objective: 'private objective',
      messages: [{ role: 'user', content: 'Private local context ü🙂' }],
      completedMutations: [['mutation', { ok: true, output: 'receipt' }]],
      operationIds: [['payload', 'operation']],
      dataPolicy: 'local_only',
      ephemeralDataUsed: true,
    },
  }
}
const key = async () => 'ab'.repeat(32)
function pendingTerminal(value: SavedResearch): void {
  value.checkpoint!.messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'pending-terminal',
        type: 'function',
        function: { name: 'project_terminal_run', arguments: '{"command":"PRIVATE_ARGS"}' },
      },
    ],
  })
}
function resolveTerminal(value: SavedResearch): void {
  value.checkpoint!.messages.push({
    role: 'tool',
    name: 'project_terminal_run',
    tool_call_id: 'pending-terminal',
    content: '{"ok":true}',
  })
}
describe('research archive persistence', () => {
  it('clears a temporary redaction marker after the original in-memory checkpoint records the terminal receipt', async () => {
    const storage = createMemoryRunArchiveStore()
    const store = createResearchStore(createRunArchive({ store: storage, key }))
    const value = fixture()
    value.checkpoint!.dataPolicy = 'ephemeral'
    pendingTerminal(value)
    await store.save(value)
    expect((await store.list('account'))[0]?.recoveryNeedsReview).toBe(true)
    resolveTerminal(value)
    await store.save(value)
    const restored = (await createResearchStore(createRunArchive({ store: storage, key })).list('account'))[0]!
    expect(restored.recoveryNeedsReview).toBeUndefined()
    expect(restored.checkpoint).toBeUndefined()
  })

  it.each(['ephemeral', 'local_only'] as const)(
    'preserves uncertainty when a %s raw checkpoint is explicitly discarded',
    async policy => {
      const storage = createMemoryRunArchiveStore()
      const store = createResearchStore(createRunArchive({ store: storage, key }))
      const value = fixture()
      value.checkpoint!.dataPolicy = policy
      pendingTerminal(value)
      await store.save(value)
      await store.save({ ...value, checkpoint: undefined })
      const restored = (await createResearchStore(createRunArchive({ store: storage, key })).list('account'))[0]!
      expect(restored.recoveryNeedsReview).toBe(true)
      expect(restored.checkpoint).toBeUndefined()
    }
  )

  it('retains local-only in-flight context without freezing a marker and accepts its subsequent receipt', async () => {
    const storage = createMemoryRunArchiveStore()
    const store = createResearchStore(createRunArchive({ store: storage, key }))
    const value = fixture()
    pendingTerminal(value)
    await store.save(value)
    const pending = (await store.list('account'))[0]!
    expect(pending.recoveryNeedsReview).toBeUndefined()
    expect(pending.checkpoint).toEqual(value.checkpoint)
    resolveTerminal(value)
    await store.save(value)
    expect((await store.list('account'))[0]?.recoveryNeedsReview).toBeUndefined()
  })

  it('does not clear an explicit marker recovered after its raw checkpoint was discarded', async () => {
    const storage = createMemoryRunArchiveStore()
    const first = createResearchStore(createRunArchive({ store: storage, key }))
    const value = fixture()
    value.checkpoint!.dataPolicy = 'ephemeral'
    pendingTerminal(value)
    await first.save(value)
    const second = createResearchStore(createRunArchive({ store: storage, key }))
    const restored = (await second.list('account'))[0]!
    await second.save({ ...restored, checkpoint: fixture().checkpoint })
    expect((await second.list('account'))[0]?.recoveryNeedsReview).toBe(true)
  })

  it('roundtrips exact local-only state and working context after a new service instance', async () => {
    const storage = createMemoryRunArchiveStore()
    const write = vi.spyOn(storage, 'write')
    const first = createResearchStore(createRunArchive({ store: storage, key }))
    const value = fixture()
    await first.save(value)
    const reloaded = await createResearchStore(createRunArchive({ store: storage, key })).list('account')
    expect(reloaded).toEqual([value])
    expect(JSON.stringify(write.mock.calls)).not.toContain('Private local context')
    expect(JSON.stringify(write.mock.calls)).not.toContain('Öffentliche Quellen')
    expect(await first.list('other-account')).toEqual([])
  })

  it.each(['ephemeral', undefined] as const)(
    'never promotes an ephemeral working transcript to local persistence (%s)',
    async policy => {
      const storage = createMemoryRunArchiveStore()
      const archive = createRunArchive({ store: storage, key })
      const store = createResearchStore(archive)
      const value = fixture()
      value.checkpoint!.dataPolicy = policy
      value.checkpoint!.ephemeralDataUsed = true
      await store.save(value)
      const restored = (await createResearchStore(createRunArchive({ store: storage, key })).list('account'))[0]!
      expect(restored.checkpoint).toBeUndefined()
      expect(restored.run).toEqual(value.run)
      const loaded = await archive.load({
        principalId: 'account',
        projectId: 'project',
        conversationId: 'chat',
        runId: 'r',
      })
      expect(JSON.stringify(loaded?.checkpoint)).not.toContain('private objective')
      expect(JSON.stringify(loaded?.checkpoint)).not.toContain('Private local context')
      expect(JSON.stringify(loaded?.checkpoint)).not.toContain('payload')
      expect(loaded?.checkpoint?.dataPolicy).toBe('local_only')
    }
  )

  it('keeps completed/cancelled research in the local inventory for report opening', async () => {
    const storage = createMemoryRunArchiveStore()
    const store = createResearchStore(createRunArchive({ store: storage, key }))
    for (const status of ['completed', 'cancelled'] as const) {
      const value = fixture()
      value.run.status = status
      await store.save(value)
      expect((await store.list('account'))[0]?.run.status).toBe(status)
    }
  })

  it('retains a payload-free recovery blocker for unknown terminal effects in a discarded ephemeral checkpoint', async () => {
    const storage = createMemoryRunArchiveStore()
    const archive = createRunArchive({ store: storage, key })
    const store = createResearchStore(archive)
    const value = fixture()
    value.checkpoint!.dataPolicy = 'ephemeral'
    value.checkpoint!.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'terminal-call',
          type: 'function',
          function: { name: 'project_terminal_run', arguments: '{"command":"PRIVATE_TERMINAL_COMMAND"}' },
        },
      ],
    })
    value.checkpoint!.uncertainMutations = ['PRIVATE_UNCERTAIN_PAYLOAD']
    await store.save(value)
    const restored = (await createResearchStore(createRunArchive({ store: storage, key })).list('account'))[0]!
    expect(restored.checkpoint).toBeUndefined()
    expect(restored.recoveryNeedsReview).toBe(true)
    const loaded = await archive.load({
      principalId: 'account',
      projectId: 'project',
      conversationId: 'chat',
      runId: 'r',
    })
    const serialized = JSON.stringify(loaded?.checkpoint)
    expect(serialized).not.toContain('PRIVATE_TERMINAL_COMMAND')
    expect(serialized).not.toContain('PRIVATE_UNCERTAIN_PAYLOAD')
    expect(serialized).not.toContain('Private local context')
    await store.save(restored)
    expect((await store.list('account'))[0]?.recoveryNeedsReview).toBe(true)
  })

  it('retains an unresolved-call blocker even when an ephemeral checkpoint has no mutation marker', async () => {
    const storage = createMemoryRunArchiveStore()
    const store = createResearchStore(createRunArchive({ store: storage, key }))
    const value = fixture()
    value.checkpoint!.dataPolicy = 'ephemeral'
    value.checkpoint!.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'pending',
          type: 'function',
          function: { name: 'project_terminal_run', arguments: '{"command":"SENSITIVE_ARGS"}' },
        },
      ],
    })
    await store.save(value)
    expect((await store.list('account'))[0]?.recoveryNeedsReview).toBe(true)
  })

  it('can discard uncertainty of the four verified research adapters without discarding mixed generic effects', async () => {
    const storage = createMemoryRunArchiveStore()
    const store = createResearchStore(createRunArchive({ store: storage, key }))
    const value = fixture()
    value.checkpoint!.dataPolicy = 'ephemeral'
    value.checkpoint!.uncertainMutations = [JSON.stringify(['research_read', { observation_id: 'safe-ref' }])]
    value.checkpoint!.messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'pending',
          type: 'function',
          function: { name: 'research_read', arguments: '{"observation_id":"safe-ref"}' },
        },
      ],
    })
    await store.save(value)
    expect((await store.list('account'))[0]?.recoveryNeedsReview).toBeUndefined()
    value.checkpoint!.uncertainMutations.push(
      JSON.stringify(['project_terminal_run', { command: 'UNKNOWN_SIDE_EFFECT' }])
    )
    await store.save(value)
    expect((await store.list('account'))[0]?.recoveryNeedsReview).toBe(true)
  })

  it('rejects any run/binding/prepare identity or folder mismatch before writing', async () => {
    const storage = createMemoryRunArchiveStore()
    const write = vi.spyOn(storage, 'write')
    const store = createResearchStore(createRunArchive({ store: storage, key }))
    for (const mutate of [
      (value: SavedResearch) => {
        value.binding = { ...value.binding, chatId: 'other-chat' }
      },
      (value: SavedResearch) => {
        value.prepare.projectId = 'other-project'
      },
      (value: SavedResearch) => {
        value.binding = { ...value.binding, workflowScope: { ...value.binding.workflowScope, researchId: 'other-run' } }
      },
      (value: SavedResearch) => {
        value.run.outputDir = 'C:/Different'
      },
    ]) {
      const value = fixture()
      mutate(value)
      await expect(store.save(value)).rejects.toThrow('scope_mismatch')
    }
    expect(write).not.toHaveBeenCalled()
  })

  it('does not load an archive with valid encryption but a mismatched internal binding', async () => {
    const storage = createMemoryRunArchiveStore()
    const archive = createRunArchive({ store: storage, key })
    const value = fixture()
    value.binding = { ...value.binding, chatId: 'different-chat' }
    await archive.capture({
      principalId: 'account',
      projectId: 'project',
      conversationId: 'chat',
      runId: 'r',
      messageId: 'research:r',
      checkpoint: {
        ...value.checkpoint!,
        researchState: { run: value.run, binding: value.binding, prepare: value.prepare, queries: value.queries },
      } as typeof value.checkpoint & object,
    })
    expect(await createResearchStore(archive).list('account')).toEqual([])
  })
})
