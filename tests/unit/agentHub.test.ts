import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { AgentRunRequest } from '@/services/agents/types'

const mocks = vi.hoisted(() => ({
  projects: [{ id: 'project', name: 'Project', archivedAt: undefined }],
  principal: vi.fn(),
  workspace: vi.fn(),
  policy: vi.fn(),
  context: vi.fn(),
  run: vi.fn(),
  sessions: vi.fn(),
  defaultModel: vi.fn(),
  catalog: vi.fn(),
}))
vi.mock('@/services/agents/defaultModel', () => ({ resolveAgentDefaultModel: mocks.defaultModel }))
vi.mock('@/state/store', () => ({ state: { projects: mocks.projects } }))
vi.mock('@/state/hud', async () => ({ hud: (await import('vue')).reactive({ killSwitch: false }) }))
vi.mock('@/services/projectWorkspace', () => ({
  getProjectWorkspace: mocks.workspace,
  resolveWorkspacePrincipalId: mocks.principal,
}))
vi.mock('@/services/repositoryGraph', () => ({ getRepositoryExternalPolicy: mocks.policy }))
vi.mock('@/services/prompt/projectStartContext', () => ({ buildProjectStartContext: mocks.context }))
vi.mock('@/services/agents/codexAgent', () => ({
  createCodexAgentAdapter: () => ({ id: 'codex', permissions: ['read-only', 'workspace-write'], run: mocks.run }),
  listCodexSessions: mocks.sessions,
  getCodexModelCapabilities: mocks.catalog,
}))
vi.mock('@/services/agents/modelAgent', () => ({
  createModelAgentAdapter: ({ id }: { id: string }) => ({ id, permissions: ['read-only'], run: mocks.run }),
}))

import { agentHub, configureAgentHub, prepareAgentJob } from '@/services/agents/hub'
import { hud } from '@/state/hud'
import type { LuczorMode } from '@/services/inference/types'

let cleanup: (() => void) | undefined

beforeEach(() => {
  vi.clearAllMocks()
  hud.killSwitch = false
  mocks.principal.mockResolvedValue('principal')
  mocks.workspace.mockResolvedValue({ rootPath: 'E:\\project', updatedAt: 1, status: 'ready' })
  mocks.policy.mockResolvedValue('ask')
  mocks.context.mockResolvedValue({ providerText: 'Reviewed project summary and goals' })
  mocks.run.mockResolvedValue({ output: 'Done' })
  mocks.sessions.mockResolvedValue([])
  mocks.defaultModel.mockResolvedValue({ model: 'configured-model', revision: 'a'.repeat(64), source: 'codex-config' })
  mocks.catalog.mockResolvedValue({
    revision: 'catalog',
    source: 'codex-cache',
    validForSeconds: 300,
    models: [{ model: 'configured-model', supportedEfforts: ['low', 'medium', 'high'] }],
  })
})

afterEach(async () => {
  cleanup?.()
  cleanup = undefined
  agentHub.clearPrincipal('principal')
  await Promise.resolve()
  vi.unstubAllGlobals()
})

const input = {
  projectId: 'project',
  adapterId: 'local' as const,
  permission: 'read-only' as const,
  role: 'assistant' as const,
  prompt: 'Inspect this plan.',
}

describe('agent hub boundaries', () => {
  it('pins the confirmed project default before effort selection and approval, retaining its revision at dispatch', async () => {
    const job = await prepareAgentJob({ ...input, adapterId: 'codex', thinkingTier: 'thorough' })
    expect(mocks.defaultModel).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        principalId: 'principal',
        projectId: 'project',
        rootPath: 'E:\\project',
        workspaceUpdatedAt: 1,
      })
    )
    expect(job).toMatchObject({
      model: 'configured-model',
      defaultModelRevision: 'a'.repeat(64),
      defaultModelSource: 'codex-config',
      effortSelection: { model: 'configured-model', requestedEffort: 'high' },
    })
    expect(mocks.run).not.toHaveBeenCalled()
    agentHub.approve(job.id)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce())
    expect(mocks.run.mock.calls[0]![0]).toMatchObject({
      model: 'configured-model',
      defaultModelRevision: 'a'.repeat(64),
    })
  })

  it('resolves Claude defaults against its actual documented effort contract, not a hardcoded chosen model', async () => {
    mocks.defaultModel.mockResolvedValue({
      model: 'claude-opus-4-7',
      revision: 'b'.repeat(64),
      source: 'claude-context',
    })
    const job = await prepareAgentJob({ ...input, adapterId: 'claude', thinkingTier: 'max' })
    expect(job).toMatchObject({
      model: 'claude-opus-4-7',
      defaultModelRevision: 'b'.repeat(64),
      effortSelection: { requestedEffort: 'xhigh' },
    })
    expect(job.status).toBe('awaiting_approval')
  })

  it('preserves explicit models and does not consult or attach a default configuration', async () => {
    const job = await prepareAgentJob({ ...input, adapterId: 'codex', model: 'explicit-model', thinkingTier: 'fast' })
    expect(job.model).toBe('explicit-model')
    expect(job.defaultModelRevision).toBeUndefined()
    expect(mocks.defaultModel).not.toHaveBeenCalled()
  })

  it.each(['unconfirmed', 'changed_scope', 'cancelled', 'unknown_effort'])(
    'does not stage a job after default resolution is %s',
    async reason => {
      let cancelled = false
      mocks.defaultModel.mockImplementation(async () => {
        if (reason === 'unconfirmed') throw new Error('agent_default_model_unconfirmed')
        if (reason === 'changed_scope')
          mocks.workspace.mockResolvedValue({ rootPath: 'E:\\other', updatedAt: 2, status: 'ready' })
        if (reason === 'cancelled') cancelled = true
        return {
          model: reason === 'unknown_effort' ? 'unknown-model' : 'configured-model',
          revision: 'a'.repeat(64),
          source: 'codex-config',
        }
      })
      const enqueue = vi.spyOn(agentHub, 'enqueue')
      try {
        await expect(
          prepareAgentJob({
            ...input,
            adapterId: 'codex',
            thinkingTier: 'thorough',
            assertExecution: () => {
              if (cancelled) throw new DOMException('Cancelled', 'AbortError')
            },
          })
        ).rejects.toThrow()
        expect(enqueue).not.toHaveBeenCalled()
      } finally {
        enqueue.mockRestore()
      }
    }
  )

  it('assembles opted-in context before approval and does not dispatch an unapproved job', async () => {
    const job = await prepareAgentJob({ ...input, includeMemory: true })
    expect(mocks.context).toHaveBeenCalledWith(expect.objectContaining({ includeMemory: true }))
    expect(agentHub.getPrompt(job.id)).toContain('Reviewed project summary and goals')
    expect(agentHub.getPrompt(job.id)).toContain(input.prompt)
    expect(job.status).toBe('awaiting_approval')
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('does not enqueue when cancellation arrives during the final asynchronous scope check', async () => {
    const controller = new AbortController()
    mocks.catalog.mockImplementation(async () => {
      mocks.workspace.mockImplementation(async () => {
        controller.abort()
        return { rootPath: 'E:\\project', updatedAt: 1, status: 'ready' }
      })
      return {
        revision: 'catalog',
        models: [{ model: 'configured-model', supportedEfforts: ['low', 'medium', 'high'] }],
      }
    })
    const enqueue = vi.spyOn(agentHub, 'enqueue')
    try {
      await expect(
        prepareAgentJob({
          ...input,
          adapterId: 'codex',
          thinkingTier: 'thorough',
          assertExecution: () => controller.signal.throwIfAborted(),
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(enqueue).not.toHaveBeenCalled()
      expect(mocks.run).not.toHaveBeenCalled()
    } finally {
      enqueue.mockRestore()
    }
  })

  it('rejects empty user tasks before context or account access', async () => {
    await expect(prepareAgentJob({ ...input, prompt: '   ' })).rejects.toThrow('Arbeitsauftrag')
    expect(mocks.principal).not.toHaveBeenCalled()
    expect(mocks.context).not.toHaveBeenCalled()
  })

  it('revalidates bindings after context assembly', async () => {
    mocks.context.mockImplementation(async () => {
      mocks.workspace.mockResolvedValue({ rootPath: 'E:\\project', updatedAt: 2, status: 'ready' })
      return { providerText: 'Context' }
    })
    await expect(prepareAgentJob(input)).rejects.toThrow('Zuordnung')
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('resumes only a session returned by the native project/session authority', async () => {
    mocks.sessions.mockResolvedValue([
      { threadId: '00000000-0000-4000-8000-000000000001', updatedAt: 10 },
      { threadId: '00000000-0000-4000-8000-000000000002', updatedAt: 9 },
    ])
    const job = await prepareAgentJob({
      ...input,
      adapterId: 'codex',
      resume: true,
      externalThreadId: '00000000-0000-4000-8000-000000000002',
    })
    agentHub.approve(job.id)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
    expect((mocks.run.mock.calls[0]![0] as AgentRunRequest).externalThreadId).toBe(
      '00000000-0000-4000-8000-000000000002'
    )
  })

  it('rejects a stale renderer-selected session that native session_list no longer returns', async () => {
    mocks.sessions.mockResolvedValue([{ threadId: 'native-current', updatedAt: 10 }])
    await expect(
      prepareAgentJob({ ...input, adapterId: 'codex', resume: true, externalThreadId: 'stale-store-link' })
    ).rejects.toThrow('native Codex-Sitzung')
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('rechecks observe mode after asynchronous workspace access', async () => {
    const mode = ref<LuczorMode>('act')
    cleanup = configureAgentHub(() => mode.value)
    mocks.workspace.mockImplementation(async () => {
      mode.value = 'observe'
      return { rootPath: 'E:\\project', updatedAt: 1, status: 'ready' }
    })
    await expect(prepareAgentJob({ ...input, adapterId: 'codex', permission: 'workspace-write' })).rejects.toThrow(
      'Handeln'
    )
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('cancels queued work synchronously when Not-Aus becomes active', async () => {
    cleanup = configureAgentHub(() => 'act')
    const job = await prepareAgentJob(input)
    hud.killSwitch = true
    expect(agentHub.getJob(job.id)?.status).toBe('cancelled')
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('immediately drops private prompts and jobs on the API identity boundary event', async () => {
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    cleanup = configureAgentHub(() => 'act')
    const job = await prepareAgentJob(input)
    events.dispatchEvent(new Event('luczor:api-identity-changing'))
    expect(agentHub.getPrompt(job.id)).toBe('')
    expect(agentHub.getJob(job.id)).toBeUndefined()
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('aborts a writing worker immediately on a mode downgrade', async () => {
    const mode = ref<LuczorMode>('act')
    cleanup = configureAgentHub(() => mode.value)
    let finish!: (result: { output: string }) => void
    mocks.run.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const job = await prepareAgentJob({ ...input, adapterId: 'codex', permission: 'workspace-write' })
    agentHub.approve(job.id)
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1))
    mode.value = 'observe'
    expect(agentHub.getJob(job.id)?.status).toBe('cancelled')
    expect((mocks.run.mock.calls[0]![0] as AgentRunRequest).signal.aborted).toBe(true)
    finish({ output: 'Late result' })
    await Promise.resolve()
  })
})
