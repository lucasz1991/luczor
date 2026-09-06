import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTeamRun } from '@/services/agents/teams'

const project = {
  principalId: 'principal',
  projectId: 'project',
  projectName: 'Project',
  rootPath: 'E:\\project',
  workspaceUpdatedAt: 1,
}
const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  prepare: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}))

vi.mock('@/services/agents/hub', () => ({ agentProjectSnapshot: mocks.snapshot }))
vi.mock('@/services/agents/teamHub', () => ({
  prepareAgentTeam: mocks.prepare,
  agentTeams: { getRun: mocks.getRun, cancelRun: mocks.cancelRun },
}))

import { agentTeamTools } from '@/services/tools/agentTeams'

const context = { projectId: 'project' }
const tool = (name: string) => agentTeamTools.find(item => item.name === name)!

function run(): AgentTeamRun {
  return {
    id: 'team-run',
    definitionId: 'template',
    label: 'Team',
    project,
    objective: 'Private objective',
    approvalMode: 'team',
    status: 'running',
    maxParallel: 2,
    maxPromptCharacters: 96_000,
    promptCharactersUsed: 500,
    deadlineAt: 2_000,
    createdAt: 1,
    nodes: [
      {
        id: 'planner',
        label: 'Planner',
        role: 'planner',
        adapterId: 'local',
        permission: 'read-only',
        dependencies: [],
        resources: { workspace: 'read', exclusive: ['local_gpu1'] },
        status: 'completed',
        output: 'private output',
        createdAt: 1,
        finishedAt: 2,
      },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.snapshot.mockResolvedValue(project)
  mocks.prepare.mockImplementation((_definition, input) => ({
    ...run(),
    project: input.project,
    objective: input.objective,
    status: 'awaiting_approval',
  }))
  mocks.getRun.mockReturnValue(run())
  mocks.cancelRun.mockReturnValue(true)
})

describe('agent team tools', () => {
  it('stages the fixed DAG without executing it and leaves final approval in Agent Hub', async () => {
    const result = await tool('agent_team_prepare').execute(
      {
        objective: 'Implement and verify.',
        planner: 'local',
        implementer: 'codex',
        reviewer: 'policy',
        implementer_permission: 'workspace-write',
        approval_mode: 'per-node',
      },
      context
    )
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ id: 'join' })]) }),
      expect.objectContaining({ project, objective: 'Implement and verify.', approvalMode: 'per-node' })
    )
    expect(result).toMatchObject({ status: 'awaiting_approval', node_count: 1 })
    expect(tool('agent_team_prepare')).toMatchObject({ requiresApproval: false, risk: 'sensitive' })
  })

  it.each([
    { planner: 'other', implementer: 'codex', reviewer: 'local', approval_mode: 'team' },
    {
      planner: 'local',
      implementer: 'local',
      reviewer: 'local',
      implementer_permission: 'workspace-write',
      approval_mode: 'team',
    },
    { planner: 'local', implementer: 'codex', reviewer: 'local', approval_mode: 'automatic' },
  ])('rejects invalid or over-privileged team definitions before preparing', async args => {
    await expect(tool('agent_team_prepare').execute({ objective: 'Task', ...args }, context)).rejects.toThrow()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('returns lifecycle metadata without prompts, objectives or node outputs and requires no approval', async () => {
    const result = await tool('agent_team_status').execute({ run_id: 'team-run' }, context)
    expect(result).toMatchObject({
      ok: true,
      run_id: 'team-run',
      status: 'running',
      nodes: [{ id: 'planner', status: 'completed' }],
    })
    expect(JSON.stringify(result)).not.toContain('private output')
    expect(JSON.stringify(result)).not.toContain('Private objective')
    expect(tool('agent_team_status')).toMatchObject({ requiresApproval: false, mutating: false, risk: 'low' })
  })

  it('rejects status and cancellation after the active workspace binding changes', async () => {
    mocks.snapshot.mockResolvedValue({ ...project, workspaceUpdatedAt: 2 })
    await expect(tool('agent_team_status').execute({ run_id: 'team-run' }, context)).rejects.toThrow('Projektzuordnung')
    await expect(tool('agent_team_cancel').execute({ run_id: 'team-run' }, context)).rejects.toThrow('Projektzuordnung')
    expect(mocks.cancelRun).not.toHaveBeenCalled()
  })

  it('cancels only the matching active-project team', async () => {
    await expect(tool('agent_team_cancel').execute({ run_id: 'team-run' }, context)).resolves.toEqual({
      ok: true,
      cancelled: true,
      run_id: 'team-run',
    })
    expect(mocks.cancelRun).toHaveBeenCalledWith('team-run')
  })
})
