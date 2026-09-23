import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { runWorkflowImage, type WorkflowImageInput } from '@/services/workflows/image'
import type { ToolDef } from './types'
import { getToolSession } from './toolSessionCoordinator'
import { validateToolArguments } from './validateArguments'

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['capabilities', 'capture', 'ocr', 'compare', 'vision'] },
    artifact_id: { type: 'string', maxLength: 200 },
    other_artifact_id: { type: 'string', maxLength: 200 },
    monitor_id: { type: 'integer', minimum: 0, maximum: 4294967295 },
    language: { type: 'string', maxLength: 40 },
    instruction: { type: 'string', minLength: 1, maxLength: 12000 },
    inference: { type: 'string', enum: ['local', 'external'] },
    output_format: { type: 'string', enum: ['text', 'json'] },
    max_output_chars: { type: 'integer', minimum: 256, maximum: 20000 },
  },
  required: ['action'],
}

function input(args: Record<string, unknown>): WorkflowImageInput {
  return {
    action: String(args.action) as WorkflowImageInput['action'],
    artifactId: typeof args.artifact_id === 'string' ? args.artifact_id : undefined,
    otherArtifactId: typeof args.other_artifact_id === 'string' ? args.other_artifact_id : undefined,
    monitorId: typeof args.monitor_id === 'number' ? args.monitor_id : undefined,
    language: typeof args.language === 'string' ? args.language : undefined,
    instruction: typeof args.instruction === 'string' ? args.instruction : undefined,
    inference: args.inference === 'local' || args.inference === 'external' ? args.inference : undefined,
    outputFormat: args.output_format === 'json' ? 'json' : 'text',
    maxOutputChars: typeof args.max_output_chars === 'number' ? args.max_output_chars : undefined,
    maxChars: typeof args.max_output_chars === 'number' ? args.max_output_chars : undefined,
  }
}

export const visionTools: ToolDef[] = [
  {
    name: 'image_analyze',
    category: 'app',
    description:
      'Zuerst capabilities für verfügbare lokale Bildfunktionen abfragen. capture erstellt ein temporäres Bild, ocr liest Text, compare vergleicht Pixel. vision benötigt eine separat eingerichtete externe Vision-Route und deren Freigaben; ein lokales Textmodell bietet keine Bildanalyse.',
    parameters: schema,
    mutating: false,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'sensitive',
    scope: 'project',
    effects: ['read'],
    capabilityKey: 'image.vision',
    sessionKind: 'vision',
    approvalMode: 'session',
    async execute(args, ctx) {
      validateToolArguments(schema, args)
      if (args.action === 'vision' && args.inference !== 'external') {
        return {
          ok: false,
          code: 'workflow_vision_multimodal_runtime_unavailable',
          error:
            'Für diese lokale Runtime ist keine multimodale Bildanalyse verfügbar. Eine Wiederholung oder ein anderer Textprompt ändert diese Fähigkeit nicht.',
          next_tool: 'image_analyze',
          next_arguments: { action: 'capabilities' },
          guidance:
            'OCR kann Bildtext lesen, aber keine Szene verstehen. Externe Bildanalyse nur über eine eingerichtete und freigegebene Vision-Route anfordern.',
        }
      }
      const account = await getVerifiedAccountSnapshot()
      if (!account) throw new Error('Für Bildanalyse ist eine verifizierte Serververbindung erforderlich.')
      const session = await getToolSession(ctx, 'vision')
      return runWorkflowImage(input(args), {
        scope: session.scope,
        invokeTask: session.invokeTask,
        ticket: session.ticket,
        workflowExecutionId: session.scope.runId,
      })
    },
  },
]
