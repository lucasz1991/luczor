import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { AgentTeamNode, AgentTeamRun } from '@/services/agents/teams'

const mocks = vi.hoisted(() => ({
  runs: [] as AgentTeamRun[],
  prepare: vi.fn(),
  approveRun: vi.fn(),
  approveNode: vi.fn(),
  cancelRun: vi.fn(),
  cancelNode: vi.fn(),
  getNodePrompt: vi.fn(() => 'Exact compiled predecessor prompt'),
}))

vi.mock('@/services/agents/teamHub', async () => {
  const { shallowRef } = await import('vue')
  return {
    agentTeamsRevision: shallowRef(0),
    prepareAgentTeam: mocks.prepare,
    agentTeams: {
      listRuns: () => mocks.runs,
      approveRun: mocks.approveRun,
      approveNode: mocks.approveNode,
      cancelRun: mocks.cancelRun,
      cancelNode: mocks.cancelNode,
      getNodePrompt: mocks.getNodePrompt,
    },
  }
})

import AgentTeams from '@/components/agents/AgentTeams.vue'

const project = {
  principalId: 'principal',
  projectId: 'project',
  projectName: 'Project',
  rootPath: 'E:\\project',
  workspaceUpdatedAt: 1,
}

function node(overrides: Partial<AgentTeamNode> & Pick<AgentTeamNode, 'id' | 'label' | 'role'>): AgentTeamNode {
  return {
    adapterId: 'local',
    permission: 'read-only',
    dependencies: [],
    resources: { workspace: 'read', exclusive: ['local_gpu1'] },
    status: 'blocked',
    output: '',
    createdAt: 1,
    ...overrides,
  }
}

function run(overrides: Partial<AgentTeamRun> = {}): AgentTeamRun {
  return {
    id: 'run',
    definitionId: 'template',
    label: 'Review run',
    project,
    objective: 'Review this.',
    approvalMode: 'team',
    status: 'awaiting_approval',
    maxParallel: 2,
    maxPromptCharacters: 20_000,
    promptCharactersUsed: 500,
    createdAt: 1,
    nodes: [
      node({ id: 'planner', label: 'Planung', role: 'planner' }),
      node({
        id: 'implementer-primary',
        label: 'Umsetzung · Hauptpfad',
        role: 'implementer',
        dependencies: ['planner'],
      }),
      node({
        id: 'implementer-edge',
        label: 'Umsetzung · Randfälle',
        role: 'implementer',
        dependencies: ['planner'],
      }),
      node({
        id: 'reviewer',
        label: 'Unabhängiges Review',
        role: 'reviewer',
        dependencies: ['implementer-primary', 'implementer-edge'],
      }),
      node({ id: 'join', label: 'Konsolidierter Abschluss', role: 'join', dependencies: ['reviewer'] }),
    ],
    ...overrides,
  }
}

async function render(props: { mode?: 'observe' | 'act'; killSwitch?: boolean } = {}): Promise<string> {
  return renderToString(
    createSSRApp({
      render: () =>
        h(AgentTeams, {
          project,
          mode: props.mode ?? 'act',
          killSwitch: props.killSwitch ?? false,
          codexAvailable: true,
          modelOptions: [{ id: 'local', label: 'Local', available: true }],
        }),
    })
  )
}

beforeEach(() => {
  mocks.runs.length = 0
  vi.clearAllMocks()
})

describe('AgentTeams UI', () => {
  it('renders the shared five-node DAG, limits and explicit whole-team approval', async () => {
    mocks.runs.push(run())
    const html = await render()
    for (const label of [
      'Planung',
      'Umsetzung · Hauptpfad',
      'Umsetzung · Randfälle',
      'Unabhängiges Review',
      'Konsolidierter Abschluss',
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toContain('500 / 20.000 Promptzeichen')
    expect(html).toContain('Ganzes Team starten')
    expect(html).toContain('Vollständigen Teamrahmen prüfen')
  })

  it('shows the exact per-node prompt plus structured review/join propagation errors', async () => {
    mocks.runs.push(
      run({
        approvalMode: 'per-node',
        status: 'running',
        nodes: [
          node({
            id: 'reviewer',
            label: 'Independent review',
            role: 'reviewer',
            dependencies: ['implementer'],
            status: 'awaiting_approval',
          }),
          node({
            id: 'join',
            label: 'Join',
            role: 'join',
            dependencies: ['reviewer'],
            status: 'skipped',
            errorCode: 'dependency_failed',
          }),
        ],
      })
    )
    const html = await render()
    expect(html).toContain('Exact compiled predecessor prompt')
    expect(html).toContain('Ein erforderlicher Vorgänger ist fehlgeschlagen.')
    expect(html).toContain('Diesen Knoten starten')
  })

  it('disables a writing team approval in observe mode and under Not-Aus', async () => {
    mocks.runs.push(
      run({
        nodes: [
          node({
            id: 'writer',
            label: 'Writer',
            role: 'implementer',
            adapterId: 'codex',
            permission: 'workspace-write',
            resources: { workspace: 'write' },
          }),
          node({ id: 'review', label: 'Review', role: 'reviewer', dependencies: ['writer'] }),
        ],
      })
    )
    const observe = await render({ mode: 'observe' })
    expect(observe).toMatch(/<button[^>]*disabled[^>]*>\s*Ganzes Team starten/)
    const stopped = await render({ killSwitch: true })
    expect(stopped).toMatch(/<button[^>]*disabled[^>]*>\s*Ganzes Team starten/)
  })
})
