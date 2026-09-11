import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  prepare: vi.fn(),
  snapshot: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  getOutput: vi.fn(),
  cancel: vi.fn(),
  externalPolicy: vi.fn(),
  executionAssert: vi.fn(),
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: () => ({ sessionId: 'session', generation: 1, signal: new AbortController().signal }),
    assert: harness.executionAssert,
  },
}))
vi.mock('@/services/repositoryGraph', () => ({ getRepositoryExternalPolicy: harness.externalPolicy }))
vi.mock('@/services/agents/hub', () => ({
  prepareAgentJob: harness.prepare,
  agentProjectSnapshot: harness.snapshot,
  agentHub: {
    getJob: harness.getJob,
    listJobs: harness.listJobs,
    getOutput: harness.getOutput,
    cancel: harness.cancel,
  },
}))
import { agentJobTools } from '@/services/tools/agentJobs'

const project = { principalId: 'account-a', projectId: 'project-a', rootPath: 'E:\\code', workspaceUpdatedAt: 10 }
const context = { projectId: 'project-a' }
function tool(name: string) {
  const result = agentJobTools.find(item => item.name === name)
  if (!result) throw new Error('Missing tool')
  return result
}

describe('managed agent tools', () => {
  it('discovers only current-binding jobs without exposing prompts or results', async () => {
    const job = harness.getJob()
    harness.listJobs.mockReturnValue([
      job,
      { ...job, project: { ...project, workspaceUpdatedAt: 0 } },
      { ...job, principalId: 'other' },
    ])
    expect(await tool('agent_job_status').execute({}, context)).toEqual({
      ok: true,
      jobs: [{ job_id: 'job-a', agent: 'codex', status: 'completed', error_code: undefined }],
      truncated: false,
    })
    expect(harness.getOutput).not.toHaveBeenCalled()
    await expect(tool('agent_job_status').execute({ include_output: true }, context)).rejects.toThrow('job_id')
    harness.listJobs.mockReturnValue([])
    expect(await tool('agent_job_status').execute({}, context)).toMatchObject({ ok: true, jobs: [] })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    harness.snapshot.mockResolvedValue(project)
    harness.getJob.mockReturnValue({
      id: 'job-a',
      principalId: project.principalId,
      projectId: project.projectId,
      project,
      adapterId: 'codex',
      status: 'completed',
    })
    harness.getOutput.mockReturnValue('result')
    harness.prepare.mockResolvedValue({ id: 'job-new', status: 'awaiting_approval' })
    harness.cancel.mockReturnValue(true)
    harness.externalPolicy.mockResolvedValue('ask')
    harness.executionAssert.mockImplementation(() => undefined)
  })

  it('only prepares a staged task with strict defaults and no execution permission', async () => {
    const result = await tool('agent_job_prepare').execute({ agent: 'local', prompt: 'Review this plan' }, context)
    expect(result).toMatchObject({ ok: true, status: 'awaiting_approval' })
    expect(harness.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-a',
        adapterId: 'local',
        permission: 'read-only',
        includeMemory: false,
        resume: false,
        expectedProject: project,
        assertExecution: expect.any(Function),
      })
    )
  })

  it('stages Claude and typed effort options for the existing job review', async () => {
    await tool('agent_job_prepare').execute(
      {
        agent: 'claude',
        prompt: 'Review',
        model: 'claude-opus-4-7',
        thinking_tier: 'ultra',
        effort: 'high',
        max_turns: 9,
        max_budget_usd: 1,
      },
      context
    )
    expect(harness.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'claude',
        model: 'claude-opus-4-7',
        thinkingTier: 'ultra',
        effort: 'high',
        maxTurns: 9,
        maxBudgetUsd: 1,
        permission: 'read-only',
      })
    )
  })

  it('rejects malformed model, effort and execution budgets before staging', async () => {
    for (const options of [
      { thinking_tier: 'turbo' },
      { effort: 'unlimited' },
      { model: '--flag bad' },
      { max_turns: 201 },
      { max_budget_usd: -1 },
    ]) {
      await expect(
        tool('agent_job_prepare').execute({ agent: 'claude', prompt: 'Review', ...options }, context)
      ).rejects.toThrow()
    }
    expect(harness.prepare).not.toHaveBeenCalled()
  })

  it('does not enqueue a prepared job after its execution generation changed during the snapshot', async () => {
    harness.executionAssert
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Ausführung verworfen')
      })

    await expect(
      tool('agent_job_prepare').execute({ agent: 'local', prompt: 'Review this plan' }, context)
    ).rejects.toThrow('Ausführung verworfen')
    expect(harness.prepare).not.toHaveBeenCalled()
  })

  it('cancels the newly staged job when the execution generation changes before it is returned', async () => {
    harness.executionAssert
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Ausführung verworfen')
      })

    await expect(
      tool('agent_job_prepare').execute({ agent: 'local', prompt: 'Review this plan' }, context)
    ).rejects.toThrow('Ausführung verworfen')
    expect(harness.prepare).toHaveBeenCalledOnce()
    expect(harness.cancel).toHaveBeenCalledExactlyOnceWith('job-new')
  })

  it.each([
    { agent: 'invented' },
    { agent: 'codex', role: 'admin' },
    { agent: 'codex', permission: 'all' },
    { agent: 'codex', include_memory: 'true' },
  ])('rejects malformed agent requests %j', async args => {
    await expect(tool('agent_job_prepare').execute({ prompt: 'task', ...args }, context)).rejects.toThrow()
    expect(harness.prepare).not.toHaveBeenCalled()
  })

  it('omits output by default and bounds explicitly requested output', async () => {
    expect(await tool('agent_job_status').execute({ job_id: 'job-a' }, context)).toMatchObject({ output: undefined })
    expect(harness.getOutput).not.toHaveBeenCalled()
    harness.getOutput.mockReturnValue('x'.repeat(9000))
    expect(await tool('agent_job_status').execute({ job_id: 'job-a', include_output: true }, context)).toMatchObject({
      output: 'x'.repeat(8000),
    })
  })

  it('enforces the current repository egress policy while leaving safe status metadata readable', async () => {
    harness.externalPolicy.mockResolvedValue('deny')
    await expect(tool('agent_job_status').execute({ job_id: 'job-a', include_output: true }, context)).rejects.toThrow(
      'Repository-Richtlinie'
    )
    expect(harness.getOutput).not.toHaveBeenCalled()
    expect(await tool('agent_job_status').execute({ job_id: 'job-a' }, context)).toMatchObject({
      status: 'completed',
      output: undefined,
    })
  })

  it('redacts provider credentials and absolute local paths before sharing final agent output', async () => {
    harness.getOutput.mockReturnValue(
      'Inspect E:\\private\\repo\\file.ts with ghp_abcdefghijklmnopqrstuvwxyz123456 and password=private-value'
    )
    const result = await tool('agent_job_status').execute({ job_id: 'job-a', include_output: true }, context)
    expect(result).toMatchObject({
      output: 'Inspect @project with [REDACTED GITHUB KEY] and password=[REDACTED]',
      output_truncated: false,
    })
  })

  it('rechecks account and workspace identity after awaiting the egress policy', async () => {
    harness.externalPolicy.mockImplementation(async () => {
      harness.snapshot.mockResolvedValue({ ...project, principalId: 'account-b' })
      return 'ask'
    })
    await expect(tool('agent_job_status').execute({ job_id: 'job-a', include_output: true }, context)).rejects.toThrow(
      'Projektzuordnung hat sich'
    )
    expect(harness.getOutput).not.toHaveBeenCalled()
  })

  it.each([
    { principalId: 'account-b' },
    { projectId: 'project-b' },
    { project: { ...project, rootPath: 'E:\\other' } },
    { project: { ...project, workspaceUpdatedAt: 11 } },
  ])('denies results across scope changes %j', async patch => {
    harness.getJob.mockReturnValue({ ...harness.getJob(), ...patch })
    await expect(tool('agent_job_status').execute({ job_id: 'job-a', include_output: true }, context)).rejects.toThrow()
    expect(harness.getOutput).not.toHaveBeenCalled()
  })

  it('never cancels another account job', async () => {
    harness.getJob.mockReturnValue({ ...harness.getJob(), principalId: 'account-b' })
    await expect(tool('agent_job_cancel').execute({ job_id: 'job-a' }, context)).rejects.toThrow()
    expect(harness.cancel).not.toHaveBeenCalled()
  })
})
