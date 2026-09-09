import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { currentWorkflowEnvironmentHash } from './capabilities'

export type VerifiedAgentEvidenceRow = Readonly<{
  adapter: 'local' | 'codex' | 'claude'
  model: string
  model_source: 'runtime' | 'pinned_request'
  samples: number
  passed: number
  failed: number
  mean_duration_ms?: number | null
  latest_test_at: string
  evidence_ids: readonly number[]
}>
export type VerifiedAgentEvidence = Readonly<{
  version: 1
  revision: string
  scope_hash: string
  device_environment_hash: string
  minimum_samples: number
  rows: readonly VerifiedAgentEvidenceRow[]
}>
const SHA = /^[a-f0-9]{64}$/u
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,159}$/u
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum

/** Reject missing/malformed proof rather than treating self-reported success as model quality. */
export function parseVerifiedAgentEvidence(value: unknown, environment: string): VerifiedAgentEvidence {
  const data = value as VerifiedAgentEvidence
  if (
    !data ||
    data.version !== 1 ||
    !SHA.test(data.revision ?? '') ||
    !SHA.test(data.scope_hash ?? '') ||
    !SHA.test(environment) ||
    data.device_environment_hash !== environment ||
    !integer(data.minimum_samples, 5, 100) ||
    !Array.isArray(data.rows) ||
    data.rows.length > 100
  )
    throw new Error('workflow_agent_evidence_invalid')
  const seen = new Set<string>()
  for (const row of data.rows) {
    if (
      !row ||
      !['local', 'codex', 'claude'].includes(row.adapter) ||
      typeof row.model !== 'string' ||
      !MODEL.test(row.adapter === 'claude' ? row.model.replace(/\[1m\]$/u, '') : row.model) ||
      !['runtime', 'pinned_request'].includes(row.model_source) ||
      !integer(row.samples, 1, 10000) ||
      !integer(row.passed, 0, row.samples) ||
      !integer(row.failed, 0, row.samples) ||
      row.passed + row.failed !== row.samples ||
      (row.mean_duration_ms != null && (!Number.isFinite(row.mean_duration_ms) || row.mean_duration_ms < 0)) ||
      !Number.isFinite(Date.parse(row.latest_test_at)) ||
      Date.parse(row.latest_test_at) > Date.now() + 60000 ||
      !Array.isArray(row.evidence_ids) ||
      row.evidence_ids.length > 20 ||
      row.evidence_ids.length < Math.min(row.samples, data.minimum_samples) ||
      row.evidence_ids.some((id: unknown) => !integer(id, 1, Number.MAX_SAFE_INTEGER)) ||
      new Set(row.evidence_ids).size !== row.evidence_ids.length ||
      seen.has(`${row.adapter}:${row.model}:${row.model_source}`)
    )
      throw new Error('workflow_agent_evidence_invalid')
    seen.add(`${row.adapter}:${row.model}:${row.model_source}`)
  }
  return structuredClone(data)
}

/** Read existing completed real-test evidence only. No scoring writes, self-review or provider probes. */
export async function readVerifiedWorkflowAgentEvidence(input: {
  runPublicId?: string
  stepId?: number
  config: LuczorApiConfigSnapshot
  signal: AbortSignal
}): Promise<VerifiedAgentEvidence | null> {
  if (
    !input.runPublicId ||
    !/^[a-zA-Z0-9-]{1,80}$/u.test(input.runPublicId) ||
    !integer(input.stepId, 1, Number.MAX_SAFE_INTEGER)
  )
    return null
  input.signal.throwIfAborted()
  const deadline = new AbortController()
  const signal = AbortSignal.any([input.signal, deadline.signal])
  let stop: () => void = () => {}
  const timer = setTimeout(() => deadline.abort(new Error('workflow_agent_evidence_timeout')), 5000)
  try {
    return await Promise.race([
      (async () => {
        const environment = await currentWorkflowEnvironmentHash()
        signal.throwIfAborted()
        if (!environment) return null
        const response = await requestWithConfig<{ data: unknown }>(
          `/workflow-runs/${encodeURIComponent(input.runPublicId!)}/steps/${input.stepId}/agent-evidence`,
          { signal, timeoutMs: 5000 },
          input.config
        )
        signal.throwIfAborted()
        return parseVerifiedAgentEvidence(response.data, environment)
      })(),
      new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason)
        signal.addEventListener('abort', stop, { once: true })
      }),
    ])
  } catch {
    input.signal.throwIfAborted()
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

/** Wilson lower bound rewards repeated passed assertions while retaining failed test observations. */
export function verifiedAgentScore(row: VerifiedAgentEvidenceRow, minimumSamples: number): number | null {
  if (row.samples < minimumSamples || row.passed < 1) return null
  const proportion = row.passed / row.samples
  const z2 = 1.96 ** 2
  return (
    (proportion +
      z2 / (2 * row.samples) -
      1.96 * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * row.samples)) / row.samples)) /
    (1 + z2 / row.samples)
  )
}
