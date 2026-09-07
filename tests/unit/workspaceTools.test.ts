import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Project } from '@/state/types'
import type { AgentJob } from '@/services/agents/types'
import type { ToolContext } from '@/services/tools/types'

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  project: vi.fn(),
  prepare: vi.fn(),
  jobs: vi.fn(),
  job: vi.fn(),
  output: vi.fn(),
  cancel: vi.fn(),
  policy: vi.fn(),
  invoke: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/projectWorkspace', () => ({ resolveWorkspacePrincipalId: mocks.principal }))
vi.mock('@/services/agents/hub', () => ({
  agentHub: { listJobs: mocks.jobs, getJob: mocks.job, getOutput: mocks.output, cancel: mocks.cancel },
  agentProjectSnapshot: mocks.project,
  prepareAgentJob: mocks.prepare,
}))
vi.mock('@/services/repositoryGraph', () => ({ getRepositoryExternalPolicy: mocks.policy }))

import { state } from '@/state/store'
import { DEFAULT_STATE } from '@/state/defaults'
import { executionGate, updateExecutionControls } from '@/services/executionGate'
import { workspaceTools } from '@/services/tools/workspace'

const principalId = 'device:v1:workspace-tests'
let generation = 0

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { ...structuredClone(DEFAULT_STATE.projects[0]!), id, name: `Projekt ${id}`, ...overrides }
}
function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    projectId: 'target',
    role: 'assistant',
    content: `Antwort ${id}`,
    ts: 1,
    createdAt: 1,
    visibility: 'visible',
    parsed: null,
    meta: {},
    ...overrides,
  }
}
function job(id: string, overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id,
    projectId: 'target',
    principalId,
    adapterId: 'codex',
    role: 'implementer',
    permission: 'workspace-write',
    status: 'awaiting_approval',
    createdAt: 1,
    project: {
      principalId,
      projectId: 'target',
      projectName: 'Projekt target',
      rootPath: 'E:\\secret\\project',
      workspaceUpdatedAt: 1,
    },
    ...overrides,
  }
}
function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectId: 'selected',
    inferenceTarget: 'local',
    execution: executionGate.capture(),
    workspaceScope: { principalId, projectIds: ['selected', 'target'] },
    ...overrides,
  }
}
function tool(name: string) {
  const definition = workspaceTools.find(item => item.name === name)
  if (!definition) throw new Error(`Missing test tool ${name}`)
  return definition
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.invoke.mockResolvedValue(undefined)
  mocks.principal.mockResolvedValue(principalId)
  mocks.jobs.mockReturnValue([])
  mocks.job.mockReturnValue(job('job-1'))
  mocks.project.mockImplementation(async (projectId: string) => ({ ...job('job-1').project, projectId }))
  mocks.prepare.mockResolvedValue(job('job-1'))
  mocks.policy.mockResolvedValue('ask')
  mocks.output.mockReturnValue('Geprüftes Ergebnis.')
  mocks.cancel.mockReturnValue(true)
  state.projects = [project('selected'), project('target')]
  state.messages = []
  state.global.ui = { lastProjectId: 'selected' }
  updateExecutionControls({ mode: 'act', killSwitch: false, scope: `workspace-tests-${++generation}` })
})

describe('local workspace tools', () => {
  it.each([
    ['ordinary chat', { workspaceScope: undefined }],
    ['external inference', { inferenceTarget: 'external' as const }],
    ['unclassified inference', { inferenceTarget: undefined }],
    ['missing execution ticket', { execution: undefined }],
  ])('denies %s before reading account or workspace data', async (_label, overrides) => {
    await expect(tool('workspace_overview').execute({}, context(overrides))).rejects.toThrow('Arbeitsbereichsmodus')
    expect(mocks.principal).not.toHaveBeenCalled()
    expect(mocks.jobs).not.toHaveBeenCalled()
  })

  it('fails closed on account change without mutating another project', async () => {
    mocks.principal.mockResolvedValue('another-account')
    await expect(
      tool('workspace_project_update').execute({ project_id: 'target', name: 'Changed' }, context())
    ).rejects.toThrow('Kontositzung')
    expect(state.projects.find(item => item.id === 'target')?.name).toBe('Projekt target')
  })

  it.each(['unknown', 'archived', 'outside'])(
    'rejects a %s target even if model supplies a plausible project ID',
    async target => {
      state.projects.push(project('archived', { archivedAt: 1 }), project('outside'))
      const ctx = context({ workspaceScope: { principalId, projectIds: ['target', 'archived', 'unknown'] } })
      await expect(tool('workspace_chat_read').execute({ project_id: target }, ctx)).rejects.toThrow('Zielprojekt')
    }
  )

  it('keeps a captured allowlist unchanged while account verification is pending', async () => {
    let finish!: (value: string) => void
    mocks.principal.mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finish = resolve
        })
    )
    const projectIds = ['selected']
    const pending = tool('workspace_overview').execute({}, context({ workspaceScope: { principalId, projectIds } }))
    projectIds.push('target')
    finish(principalId)
    expect(await pending).toMatchObject({ project_count: 1, projects: [{ project_id: 'selected' }] })
  })

  it('aborts a mutation when execution controls change during asynchronous identity verification', async () => {
    mocks.principal.mockImplementationOnce(async () => {
      updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'changed' })
      return principalId
    })
    await expect(
      tool('workspace_project_update').execute({ project_id: 'target', name: 'Changed' }, context())
    ).rejects.toThrow('Ausführung verworfen')
    expect(state.projects.find(item => item.id === 'target')?.name).toBe('Projekt target')
  })

  it('enforces observe and Not-Aus even when a tool is invoked directly', async () => {
    updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'observe' })
    await expect(
      tool('workspace_project_update').execute({ project_id: 'target', summary: 'Changed' }, context())
    ).rejects.toThrow('Beobachten')
    updateExecutionControls({ mode: 'act', killSwitch: true, scope: 'stopped' })
    await expect(tool('workspace_overview').execute({}, context())).rejects.toThrow('Not-Aus')
  })

  it('returns bounded metadata without chat content, private job fields, foreign jobs or archived projects', async () => {
    state.projects.push(project('archived', { archivedAt: 1 }), project('foreign'))
    state.messages = [message('public'), message('hidden', { visibility: 'hidden', content: 'HIDDEN CHAT SECRET' })]
    mocks.jobs.mockReturnValue([
      ...Array.from({ length: 45 }, (_, index) => job(`job-${index}`)),
      job('foreign-account', { principalId: 'another-account' }),
      job('foreign-project', { projectId: 'foreign' }),
      job('archived-project', { projectId: 'archived' }),
    ])
    const result = await tool('workspace_overview').execute({ limit: 1 }, context())
    expect(result).toMatchObject({ project_count: 2, projects_truncated: true, jobs_truncated: true })
    expect((result as { projects: unknown[] }).projects).toHaveLength(1)
    expect((result as { jobs: unknown[] }).jobs).toHaveLength(40)
    const encoded = JSON.stringify(result)
    for (const excluded of [
      'HIDDEN CHAT SECRET',
      'Antwort public',
      'rootPath',
      'secret',
      'foreign-account',
      'foreign-project',
      'archived-project',
    ])
      expect(encoded).not.toContain(excluded)
    expect(mocks.jobs).toHaveBeenCalledWith(principalId)
    expect(mocks.output).not.toHaveBeenCalled()
  })

  it('updates only explicit project fields without switching the active chat or replacing goals', async () => {
    const target = state.projects.find(item => item.id === 'target')!
    const goals = target.goals
    await tool('workspace_project_update').execute(
      { project_id: 'target', name: '  Renamed  ', summary: '  Reviewed state  ' },
      context()
    )
    expect(target).toMatchObject({ name: 'Renamed', summary: 'Reviewed state' })
    expect(target.goals).toBe(goals)
    expect(state.global.ui?.lastProjectId).toBe('selected')
    expect(state.projects.find(item => item.id === 'selected')?.name).toBe('Projekt selected')
  })

  it.each([
    { project_id: 'target' },
    { project_id: 'target', name: '   ' },
    { project_id: 'target', name: 'invalid\nname' },
    { project_id: 'target', name: 'A'.repeat(161) },
    { project_id: 'target', summary: 'A'.repeat(6001) },
    { project_id: 'target', summary: 'invalid\u0000summary' },
    { project_id: 'target', name: 'Valid', archivedAt: 1 },
  ])('rejects invalid project updates without partial mutation: %j', async args => {
    const before = JSON.stringify(state.projects)
    await expect(tool('workspace_project_update').execute(args, context())).rejects.toThrow()
    expect(JSON.stringify(state.projects)).toBe(before)
  })

  it('reads only selected completed public messages with content bounds and no raw/private payloads', async () => {
    state.messages = [
      message('early', { ts: 0 }),
      message('public', {
        ts: 1,
        content: 'Public answer',
        raw: 'RAW SECRET',
        parsed: { secret: 'PARSED SECRET' },
        meta: { question: 'Continue?', bullets: ['Option A'] },
      }),
      message('private', { ts: 2, content: 'PRIVATE SECRET', meta: { dataHandling: 'ephemeral' } }),
      message('private-speech', { ts: 3, content: 'CLASSIFIED SECRET', meta: { serverSpeechAllowed: false } }),
      message('hidden', { ts: 4, content: 'HIDDEN SECRET', visibility: 'hidden' }),
      message('tool', { ts: 5, role: 'tool', content: 'TOOL SECRET' }),
      message('live', { ts: 6, content: 'LIVE SECRET', meta: { isLoading: true } }),
      message('foreign', { ts: 7, projectId: 'selected', content: 'FOREIGN SECRET' }),
      message('last', { ts: 8, content: 'X'.repeat(9000) }),
    ]
    const result = await tool('workspace_chat_read').execute({ project_id: 'target', limit: 2 }, context())
    expect(result).toMatchObject({
      project_id: 'target',
      truncated: true,
      data_trust: 'untrusted_chat_text',
      messages: [
        { id: 'public', content: 'Public answer\n\nContinue?\n\n- Option A' },
        { id: 'last', content: 'X'.repeat(3000) },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('caps aggregate chat output and does not expose another account result after an asynchronous recheck', async () => {
    state.messages = Array.from({ length: 20 }, (_, index) =>
      message(String(index), { ts: index, content: 'X'.repeat(4000) })
    )
    const result = (await tool('workspace_chat_read').execute({ project_id: 'target', limit: 20 }, context())) as {
      messages: Array<{ content: string }>
      truncated: boolean
    }
    expect(result.messages.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(12000)
    expect(result.truncated).toBe(true)
    mocks.principal.mockResolvedValueOnce(principalId).mockResolvedValueOnce('other-account')
    await expect(tool('workspace_chat_read').execute({ project_id: 'target' }, context())).rejects.toThrow(
      'Kontositzung'
    )
  })

  it('stages an explicitly targeted agent using existing validated options without starting it', async () => {
    const result = await tool('workspace_agent_prepare').execute(
      {
        project_id: 'target',
        agent: 'codex',
        prompt: 'Review this project.',
        permission: 'read-only',
      },
      context()
    )
    expect(result).toMatchObject({ job_id: 'job-1', status: 'awaiting_approval' })
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'target',
        adapterId: 'codex',
        prompt: 'Review this project.',
        permission: 'read-only',
      })
    )
    expect(state.global.ui?.lastProjectId).toBe('selected')
    expect(mocks.cancel).not.toHaveBeenCalled()
  })

  it('cancels only the newly staged job when the originating turn is revoked while preparation awaits', async () => {
    mocks.prepare.mockImplementationOnce(async () => {
      executionGate.invalidate()
      return job('staged-then-revoked')
    })
    await expect(
      tool('workspace_agent_prepare').execute({ project_id: 'target', agent: 'codex', prompt: 'Review.' }, context())
    ).rejects.toThrow('Ausführung verworfen')
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('staged-then-revoked')
  })

  it('delegates job result reads to existing repository egress and target-binding checks', async () => {
    mocks.policy.mockResolvedValue('deny')
    await expect(
      tool('workspace_agent_status').execute({ project_id: 'target', job_id: 'job-1', include_output: true }, context())
    ).rejects.toThrow('Repository-Richtlinie')
    expect(mocks.output).not.toHaveBeenCalled()
    mocks.policy.mockResolvedValue('ask')
    mocks.job.mockReturnValue(job('wrong-project', { projectId: 'selected' }))
    await expect(
      tool('workspace_agent_status').execute({ project_id: 'target', job_id: 'wrong-project' }, context())
    ).rejects.toThrow('Projektzuordnung')
  })

  it('delegates targeted cancellation and refuses foreign account jobs', async () => {
    const result = await tool('workspace_agent_cancel').execute({ project_id: 'target', job_id: 'job-1' }, context())
    expect(result).toMatchObject({ ok: true, cancelled: true })
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('job-1')
    mocks.job.mockReturnValue(job('foreign', { principalId: 'foreign-account' }))
    await expect(
      tool('workspace_agent_cancel').execute({ project_id: 'target', job_id: 'foreign' }, context())
    ).rejects.toThrow('aktuellen Projekt')
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
  })
})
