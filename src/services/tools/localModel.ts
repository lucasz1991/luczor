import { executionGate } from '@/services/executionGate'
import type { ToolDef } from './types'

export const localModelToolDependencies = {
  readStatus: async () => (await import('@/services/localModelStatus')).readLocalModelStatus(),
}

/** Fixed read-only status route. No endpoint, file path, prompt or runtime credential is exposed. */
export const localModelTools: ToolDef[] = [
  {
    name: 'local_model_status',
    category: 'app',
    description:
      'Read the managed local model status, model ID, verified readiness and measured GPU/CPU offload from Luczor. Use this to diagnose local model availability instead of guessing an endpoint or port. No project folder is needed. This reads retained readiness and native process status; it does not perform a new HTTP health probe, start a model, run inference, or prove that a worker produced an answer. Unconfirmed values remain unknown.',
    mutating: false,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    risk: 'low',
    scope: 'app',
    effects: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    async execute(args, ctx) {
      if (Object.keys(args).length) throw new Error('Der lokale Modellstatus unterstützt keine Parameter.')
      // Diagnostics are local metadata. Never create a new route for an external model to retrieve them.
      if (ctx.inferenceTarget === 'external')
        throw new Error('Der lokale Modellstatus ist nur in einer lokalen Modellrunde verfügbar.')
      const ticket = ctx.execution ?? executionGate.capture(ctx.signal)
      executionGate.assert(ticket)
      ctx.signal?.throwIfAborted()
      const view = await localModelToolDependencies.readStatus()
      executionGate.assert(ticket)
      ctx.signal?.throwIfAborted()
      return {
        target: 'local',
        state: view.state,
        model_id: view.modelId?.slice(0, 160) ?? null,
        model_id_source: 'signed_catalog_selection',
        model_name: view.modelName.slice(0, 160),
        prepared: view.prepared,
        operational: view.operational,
        reason: view.detail.slice(0, 512),
        checked_at_ms: view.checkedAtMs,
        evidence_source: 'native_process_status_and_retained_verified_readiness',
        health_probe_performed: false,
        inference_performed: false,
        answer_verified: false,
        checks: view.checks.slice(0, 32).map(check => ({
          label: check.label.slice(0, 80),
          value: check.value.slice(0, 512),
          verified: check.verified,
        })),
        resources: view.resourceConfig
          ? {
              requested_mode: view.resourceConfig.requested.mode,
              applied_mode: view.resourceConfig.applied.mode,
              revision: view.resourceConfig.revision,
              applied_revision: view.resourceConfig.appliedRevision,
              change_pending: view.resourceConfig.pending,
            }
          : null,
      }
    },
  },
]
