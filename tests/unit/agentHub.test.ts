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
}))
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
  it('assembles opted-in context before approval and does not dispatch an unapproved job', async () => {
    const job = await prepareAgentJob({ ...input, includeMemory: true })
    expect(mocks.context).toHaveBeenCalledWith(expect.objectContaining({ includeMemory: true }))
    expect(agentHub.getPrompt(job.id)).toContain('Reviewed project summary and goals')
    expect(agentHub.getPrompt(job.id)).toContain(input.prompt)
    expect(job.status).toBe('awaiting_approval')
    expect(mocks.run).not.toHaveBeenCalled()
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
