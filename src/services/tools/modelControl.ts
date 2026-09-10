import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { getCodexModelCapabilities, getCodexRuntimeStatus } from '@/services/agents/codexAgent'
import { getClaudeRuntimeStatus, CLAUDE_CAPABILITIES } from '@/services/agents/claudeAgent'
import type { ToolDef } from './types'
import { validateToolArguments } from './validateArguments'

export const MODEL_CONTROL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inference: { type: 'string', enum: ['local', 'external'] },
    model: { type: 'string', maxLength: 160 },
    provider: { type: 'string', maxLength: 80 },
    thinking_tier: { type: 'string', enum: ['fast', 'balanced', 'thorough', 'max', 'ultra'] },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    top_p: { type: 'number', minimum: 0, maximum: 1 },
    seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
    stop: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 160 } },
    max_output_tokens: { type: 'integer', minimum: 256, maximum: 131072 },
    context_limit: { type: 'integer', minimum: 1024, maximum: 262144 },
    output_format: { type: 'string', enum: ['text', 'json'] },
  },
  required: [],
}

export function validateModelControls(value: Record<string, unknown>): Record<string, unknown> {
  validateToolArguments(MODEL_CONTROL_SCHEMA, value)
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

export const modelTools: ToolDef[] = [
  {
    name: 'model_capabilities',
    category: 'app',
    description: 'Liest bestätigte lokale, Codex-, Claude- und Vision-Modellfähigkeiten sowie ihre Gründe.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    mutating: false,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    risk: 'low',
    scope: 'app',
    effects: ['read'],
    capabilityKey: 'llm',
    sessionKind: 'model',
    async execute(args) {
      if (Object.keys(args).length) throw new Error('Modellfähigkeiten unterstützen keine Parameter.')
      const [local, codex, claude, catalog, account] = await Promise.all([
        invoke<Record<string, unknown>>('local_model_status').catch(() => null),
        getCodexRuntimeStatus().catch(() => ({ available: false })),
        getClaudeRuntimeStatus().catch(() => ({ available: false })),
        getCodexModelCapabilities().catch(() => ({ revision: 'unavailable', models: [] })),
        getVerifiedAccountSnapshot().catch(() => null),
      ])
      return {
        local,
        managed: { codex, claude, codexCatalog: catalog, claudeCatalog: CLAUDE_CAPABILITIES },
        vision: account ? 'capability_probe_available' : 'verified_account_required',
      }
    },
  },
  {
    name: 'model_control_validate',
    category: 'app',
    description: 'Prüft Expertenparameter gegen den sicheren Luczor-Modellvertrag, ohne eine Inferenz zu starten.',
    parameters: MODEL_CONTROL_SCHEMA,
    mutating: false,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    risk: 'low',
    scope: 'app',
    effects: ['read'],
    capabilityKey: 'llm.control',
    sessionKind: 'model',
    async execute(args) {
      return { ok: true, controls: validateModelControls(args) }
    },
  },
]
