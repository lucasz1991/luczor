import { buildBridgeMarkdown, detectAgents, writeBridgeFile } from '@/services/agents'
import { prepareAgentJob } from '@/services/agents/hub'
import { requireProjectWorkspace } from '@/services/projectWorkspace'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
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
    effects: ['execute'],
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
      if (args.agent !== 'codex')
        throw new Error('Verwaltete Agentenaufträge verwenden codex, local oder policy über agent_job_prepare.')
      const prompt = asString(args.prompt).trim()
      if (!prompt) throw new Error('prompt is empty')
      const workspace = await requireProjectWorkspace(ctx.projectId)
      if (workspace.isGitRepository && (await getRepositoryExternalPolicy()) === 'deny') {
        throw new Error('Die Repository-Richtlinie verbietet die Übergabe an einen externen Coding-Agenten.')
      }
      const job = await prepareAgentJob({
        projectId: ctx.projectId,
        adapterId: 'codex',
        prompt,
        role: 'assistant',
        permission: 'read-only',
      })
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
      const workspace = await requireProjectWorkspace(ctx.projectId)
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
      await writeBridgeFile(workspace.rootPath, content, ctx.execution)
      return { ok: true, path: 'LUCZOR.md', workspace: workspace.displayName }
    },
  },
]
