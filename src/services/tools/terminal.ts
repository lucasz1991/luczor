import type { ToolDef } from './types'
import { getToolSession } from './toolSessionCoordinator'
import { validateToolArguments } from './validateArguments'

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
