import { asString } from './shared'
import type { ToolDef } from './types'
import type { AgentProjectSnapshot } from '@/services/agents/types'
import { agentProjectSnapshot } from '@/services/agents/hub'
import { createStandardAgentTeamDefinition } from '@/services/agents/teams'
import { agentTeams, prepareAgentTeam } from '@/services/agents/teamHub'
import { executionGate } from '@/services/executionGate'

const ADAPTERS = ['codex', 'local', 'policy'] as const

function adapter(value: unknown, label: string): (typeof ADAPTERS)[number] {
  const selected = asString(value)
  if (!ADAPTERS.includes(selected as (typeof ADAPTERS)[number])) throw new Error(`${label} ist ungültig.`)
  return selected as (typeof ADAPTERS)[number]
}

function sameProject(left: AgentProjectSnapshot, right: AgentProjectSnapshot): boolean {
  return (
    left.principalId === right.principalId &&
    left.projectId === right.projectId &&
    left.rootPath === right.rootPath &&
    left.workspaceUpdatedAt === right.workspaceUpdatedAt
  )
}

/** Team tools stage and supervise runs. Human-reviewed output stays in Agent Hub. */
export const agentTeamTools: ToolDef[] = [
  {
    name: 'agent_team_prepare',
    category: 'app',
    description:
      'Prepare a bounded project-scoped agent team for review in Agenten & Erinnerungen. It stages planner, two worker, reviewer and join nodes but never starts them. The user explicitly approves the whole team or each node in the Agent Hub.',
    mutating: true,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    risk: 'sensitive',
    scope: 'project',
    effects: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 24000 },
        planner: { type: 'string', enum: ADAPTERS },
        implementer: { type: 'string', enum: ADAPTERS },
        reviewer: { type: 'string', enum: ADAPTERS },
        implementer_permission: { type: 'string', enum: ['read-only', 'workspace-write'] },
        approval_mode: { type: 'string', enum: ['team', 'per-node'] },
      },
      required: ['objective', 'planner', 'implementer', 'reviewer', 'approval_mode'],
    },
    async execute(args, ctx) {
      const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
      executionGate.assert(ticket, true)
      const objective = asString(args.objective).trim()
      if (!objective || objective.length > 24_000)
        throw new Error('Das Teamziel muss zwischen 1 und 24000 Zeichen enthalten.')
      const planner = adapter(args.planner, 'Planungsagent')
      const implementer = adapter(args.implementer, 'Umsetzungsagent')
      const reviewer = adapter(args.reviewer, 'Reviewagent')
      const approvalMode = asString(args.approval_mode)
      if (!['team', 'per-node'].includes(approvalMode)) throw new Error('Der Team-Freigabemodus ist ungültig.')
      const permission = args.implementer_permission === 'workspace-write' ? 'workspace-write' : 'read-only'
      if (
        args.implementer_permission !== undefined &&
        !['read-only', 'workspace-write'].includes(asString(args.implementer_permission))
      ) {
        throw new Error('Der Codex-Arbeitszugriff ist ungültig.')
      }
      if (implementer !== 'codex' && permission === 'workspace-write') {
        throw new Error('Nur der verwaltete Codex-Agent darf Workspace-Schreibzugriff erhalten.')
      }
      const project = await agentProjectSnapshot(ctx.projectId)
      executionGate.assert(ticket, true)
      const definition = createStandardAgentTeamDefinition({
        planner,
        implementer,
        reviewer,
        implementerPermission: permission,
      })
      executionGate.assert(ticket, true)
      const run = prepareAgentTeam(definition, {
        project,
        objective,
        approvalMode: approvalMode as 'team' | 'per-node',
      })
      return {
        ok: true,
        run_id: run.id,
        status: run.status,
        node_count: run.nodes.length,
        approval_mode: run.approvalMode,
        instruction: 'Teamlauf in Agenten & Erinnerungen vollständig prüfen und freigeben.',
      }
    },
  },
  {
    name: 'agent_team_status',
    category: 'app',
    description:
      'Read bounded lifecycle metadata for a managed team in the active project. It returns no prompts and no agent output; review results in Agenten & Erinnerungen.',
    mutating: false,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    risk: 'low',
    scope: 'project',
    effects: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { run_id: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['run_id'],
    },
    async execute(args, ctx) {
      const project = await agentProjectSnapshot(ctx.projectId)
      const run = agentTeams.getRun(asString(args.run_id))
      if (!run || !sameProject(run.project, project))
        throw new Error('Teamlauf gehört nicht zur aktuellen Projektzuordnung.')
      return {
        ok: true,
        run_id: run.id,
        status: run.status,
        error_code: run.errorCode,
        approval_mode: run.approvalMode,
        max_parallel: run.maxParallel,
        prompt_characters_used: run.promptCharactersUsed,
        prompt_character_limit: run.maxPromptCharacters,
        deadline_at: run.deadlineAt,
        nodes: run.nodes.map(node => ({
          id: node.id,
          label: node.label,
          role: node.role,
          agent: node.adapterId,
          permission: node.permission,
          dependencies: node.dependencies,
          status: node.status,
          error_code: node.errorCode,
          started_at: node.startedAt,
          finished_at: node.finishedAt,
        })),
        instruction: 'Prompts und Ergebnisse bleiben in Agenten & Erinnerungen.',
      }
    },
  },
  {
    name: 'agent_team_cancel',
    category: 'app',
    description:
      'Cancel a managed team in the active project. Running workers keep their resource leases until native or local execution has actually stopped.',
    mutating: true,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    risk: 'low',
    scope: 'project',
    effects: ['execute'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { run_id: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['run_id'],
    },
    async execute(args, ctx) {
      const project = await agentProjectSnapshot(ctx.projectId)
      const run = agentTeams.getRun(asString(args.run_id))
      if (!run || !sameProject(run.project, project))
        throw new Error('Teamlauf gehört nicht zur aktuellen Projektzuordnung.')
      return { ok: true, cancelled: agentTeams.cancelRun(run.id), run_id: run.id }
    },
  },
]
