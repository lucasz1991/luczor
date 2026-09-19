import { buildBridgeMarkdown, detectAgents, writeBridgeFile } from '@/services/agents'
import { agentHub, agentProjectSnapshot, prepareAgentJob } from '@/services/agents/hub'
import { requireProjectWorkspace, resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
import { executionGate } from '@/services/executionGate'
import { asString, getProject } from './shared'
import type { ToolDef } from './types'

export const agentTools: ToolDef[] = [
  {
    name: 'agent_detect',
    category: 'app',
    description: 'Detect which local coding-agent CLIs (Claude Code, OpenAI Codex) are installed on this PC.',
    mutating: false,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    risk: 'sensitive',
    scope: 'desktop',
    effects: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { type: 'boolean', description: 'Refresh PATH detection. Defaults to true.' },
      },
      required: [],
    },
    async execute() {
      return { ok: true, agents: await detectAgents() }
    },
  },
  {
    name: 'agent_dispatch',
    category: 'app',
    description:
      'Prepare a managed Codex job in the active project for final review in Agenten & Erinnerungen. This compatibility entry point never runs an unmanaged CLI. Prefer agent_job_prepare for explicit permissions, model-agent choice and resume.',
    mutating: true,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'critical',
    scope: 'project',
    effects: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string', enum: ['codex'] },
        prompt: { type: 'string', description: 'The task/instruction for the agent (German or English).' },
      },
      required: ['agent', 'prompt'],
    },
    async execute(args, ctx) {
      const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
      executionGate.assert(ticket, true)
      if (args.agent !== 'codex')
        throw new Error('Verwaltete Agentenaufträge verwenden codex, local oder policy über agent_job_prepare.')
      const prompt = asString(args.prompt).trim()
      if (!prompt) throw new Error('prompt is empty')
      const project = await agentProjectSnapshot(ctx.projectId)
      executionGate.assert(ticket, true)
      if (project.rootPath && (await getRepositoryExternalPolicy()) === 'deny') {
        throw new Error('Die Repository-Richtlinie verbietet die Übergabe an einen externen Coding-Agenten.')
      }
      executionGate.assert(ticket, true)
      const job = await prepareAgentJob({
        projectId: ctx.projectId,
        mode: ticket.mode,
        adapterId: 'codex',
        prompt,
        role: 'assistant',
        permission: 'read-only',
        expectedProject: project,
        assertExecution: () => executionGate.assert(ticket, true),
      })
      try {
        executionGate.assert(ticket, true)
      } catch (error) {
        agentHub.cancel(job.id)
        throw error
      }
      return {
        ok: true,
        job_id: job.id,
        status: job.status,
        instruction: 'Auftrag in Agenten & Erinnerungen prüfen und starten.',
      }
    },
  },
  {
    name: 'agent_bridge_write',
    category: 'app',
    description:
      "Write/refresh LUCZOR.md in the active project's bound local workspace only when the user explicitly requests the Claude/Codex bridge. Never use it to save normal project goals/tasks/summary.",
    mutating: true,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'critical',
    scope: 'project',
    effects: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: {
          type: 'string',
          description: 'Optional explicit markdown; auto-generated from project state if omitted.',
        },
      },
      required: [],
    },
    async execute(args, ctx) {
      const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
      executionGate.assert(ticket, true)
      const principalId = await resolveWorkspacePrincipalId()
      executionGate.assert(ticket, true)
      const workspace = await requireProjectWorkspace(ctx.projectId, principalId)
      executionGate.assert(ticket, true)
      if (!Number.isSafeInteger(workspace.updatedAt))
        throw new Error('Die Projektzuordnung besitzt keine sichere Version.')
      let content = asString(args.content)
      if (!content) {
        const project = getProject(ctx.projectId)
        content = buildBridgeMarkdown({
          name: project?.name ?? ctx.projectId,
          summary: project?.summary ?? '',
          goals: (project?.goals ?? []).map(goal => ({
            title: goal.title,
            description: goal.description ?? '',
            status: goal.status,
          })),
        })
      }
      await writeBridgeFile(
        {
          principalId,
          projectId: ctx.projectId,
          expectedRootPath: workspace.rootPath,
          expectedWorkspaceUpdatedAt: workspace.updatedAt!,
        },
        content,
        ticket
      )
      executionGate.assert(ticket, true)
      return { ok: true, path: 'LUCZOR.md', workspace: workspace.displayName }
    },
  },
]
