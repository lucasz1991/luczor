import type { ToolDef } from './types'
import { getToolSession } from './toolSessionCoordinator'
import { validateToolArguments } from './validateArguments'
import { invoke } from '@tauri-apps/api/core'
import { executionGate, executionPayload } from '@/services/executionGate'
import { requireProjectWorkspace, resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import { freezeAgentWorkflowScope } from '@/services/agents/workflowScope'

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runtime: { type: 'string', enum: ['node', 'python'] },
    code: { type: 'string', minLength: 1, maxLength: 200000 },
    timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 },
    input: { type: 'object', additionalProperties: true },
  },
  required: ['runtime', 'code'],
}

export const terminalTools: ToolDef[] = [
  {
    name: 'project_terminal_run',
    category: 'project',
    description:
      'Führt geprüften Node- oder Python-Code im gebundenen Projektordner aus. Keine freie Shell; Ausgabe und Laufzeit bleiben begrenzt.',
    parameters: schema,
    mutating: true,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'critical',
    scope: 'project',
    effects: ['execute'],
    capabilityKey: 'node.run',
    sessionKind: 'terminal',
    approvalMode: 'session',
    async execute(args, ctx) {
      validateToolArguments(schema, args)
      if (ctx.workflowScope) {
        const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
        executionGate.assert(ticket, true)
        const principalId = await resolveWorkspacePrincipalId()
        const workspace = await requireProjectWorkspace(ctx.projectId, principalId)
        const scope = freezeAgentWorkflowScope(ctx.workflowScope, {
          principalId,
          projectId: ctx.projectId,
          projectName: '',
          rootPath: workspace.rootPath,
          workspaceUpdatedAt: workspace.updatedAt,
        })!
        const execution = await executionPayload(ticket, true)
        const result = await invoke('wf_run_script', {
          payload: {
            runtime: args.runtime,
            code: args.code,
            timeout_seconds: args.timeout_seconds ?? null,
            fullAccessAcknowledged: true,
            scope,
            execution: { ...execution, workflowExecutionId: scope.runId },
            ...(args.input !== undefined ? { input: args.input } : {}),
          },
        })
        executionGate.assert(ticket, true)
        return result
      }
      const session = await getToolSession(ctx, 'terminal')
      return session.invokeTask('wf_run_script', {
        runtime: args.runtime,
        code: args.code,
        timeout_seconds: args.timeout_seconds ?? null,
        fullAccessAcknowledged: true,
        scope: session.scope,
        ...(args.input !== undefined ? { input: args.input } : {}),
      })
    },
  },
]
