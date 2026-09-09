import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ request: vi.fn(), environment: vi.fn() }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mocks.request }))
vi.mock('@/services/workflows/capabilities', () => ({ currentWorkflowEnvironmentHash: mocks.environment }))
import {
  parseVerifiedAgentEvidence,
  readVerifiedWorkflowAgentEvidence,
  verifiedAgentScore,
} from '@/services/workflows/agentEvidence'
const environment = 'a'.repeat(64)
function fixture() {
  return {
    version: 1,
    revision: 'b'.repeat(64),
    scope_hash: 'c'.repeat(64),
    device_environment_hash: environment,
    minimum_samples: 5,
    rows: [
      {
        adapter: 'claude',
        model: 'test-model',
        model_source: 'runtime',
        samples: 5,
        passed: 4,
        failed: 1,
        latest_test_at: '2026-09-08T10:00:00Z',
        evidence_ids: [1, 2, 3, 4, 5],
      },
    ],
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.environment.mockResolvedValue(environment)
  mocks.request.mockResolvedValue({ data: fixture() })
})
afterEach(() => vi.useRealTimers())

describe('verified workflow assertion evidence', () => {
  it('loads only an existing current-account run/step and validates its device environment', async () => {
    const config = { baseUrl: 'https://test.invalid', clientId: 'test-device', deviceKey: 'synthetic-only' }
    const value = await readVerifiedWorkflowAgentEvidence({
      runPublicId: 'run-1',
      stepId: 2,
      config,
      signal: new AbortController().signal,
    })
    expect(value?.rows[0]?.passed).toBe(4)
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      '/workflow-runs/run-1/steps/2/agent-evidence',
      { signal: expect.any(AbortSignal), timeoutMs: 5000 },
      config
    )
  })
  it.each(['environment', 'minimum', 'counts', 'duplicate', 'missing_ids', 'source', 'model', 'future'])(
    'rejects invalid %s proof',
    reason => {
      const data = fixture()
      if (reason === 'environment') data.device_environment_hash = 'd'.repeat(64)
      if (reason === 'minimum') data.minimum_samples = 1
      if (reason === 'counts') data.rows[0]!.passed = 50
      if (reason === 'duplicate') data.rows.push(data.rows[0]!)
      if (reason === 'missing_ids') data.rows[0]!.evidence_ids = []
      if (reason === 'source') data.rows[0]!.model_source = 'self_review'
      if (reason === 'model') data.rows[0]!.model = 'unsafe\nname'
      if (reason === 'future') data.rows[0]!.latest_test_at = '2999-01-01T00:00:00Z'
      expect(() => parseVerifiedAgentEvidence(data, environment)).toThrow('workflow_agent_evidence_invalid')
    }
  )
  it('does not score insufficient samples or bare failed executions', () => {
    const row = parseVerifiedAgentEvidence(fixture(), environment).rows[0]!
    expect(verifiedAgentScore({ ...row, samples: 4, passed: 4, failed: 0 }, 5)).toBeNull()
    expect(verifiedAgentScore({ ...row, passed: 0, failed: 5 }, 5)).toBeNull()
    expect(verifiedAgentScore({ ...row, passed: 5, failed: 0 }, 5)).toBeGreaterThan(verifiedAgentScore(row, 5)!)
  })
  it('keeps runtime and explicitly pinned request cohorts separate for the same adapter/model', () => {
    const data = fixture()
    data.rows.push({ ...data.rows[0]!, model_source: 'pinned_request', evidence_ids: [6, 7, 8, 9, 10] })
    const result = parseVerifiedAgentEvidence(data, environment)
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map(row => row.model_source)).toEqual(['runtime', 'pinned_request'])
    expect(result.rows.map(row => row.samples)).toEqual([5, 5])
  })
  it('retains a Claude context suffix as a distinct model identity', () => {
    const data = fixture()
    data.rows[0]!.model = 'claude-opus-5[1m]'
    expect(parseVerifiedAgentEvidence(data, environment).rows[0]!.model).toBe('claude-opus-5[1m]')
    data.rows[0]!.adapter = 'codex'
    expect(() => parseVerifiedAgentEvidence(data, environment)).toThrow('invalid')
  })
  it('treats an unavailable endpoint as absent evidence, never a positive score', async () => {
    mocks.request.mockRejectedValue(new Error('404'))
    expect(
      await readVerifiedWorkflowAgentEvidence({
        runPublicId: 'run',
        stepId: 1,
        config: { baseUrl: 'https://test.invalid', clientId: 'd', deviceKey: 'k' },
        signal: new AbortController().signal,
      })
    ).toBeNull()
  })
  it('does not call an endpoint for a legacy or invalid run scope', async () => {
    expect(
      await readVerifiedWorkflowAgentEvidence({
        config: { baseUrl: 'https://test.invalid', clientId: 'd', deviceKey: 'k' },
        signal: new AbortController().signal,
      })
    ).toBeNull()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('bounds an unresponsive read-only environment probe', async () => {
    vi.useFakeTimers()
    mocks.environment.mockReturnValue(new Promise(() => {}))
    const value = readVerifiedWorkflowAgentEvidence({
      runPublicId: 'run',
      stepId: 1,
      config: { baseUrl: 'https://test.invalid', clientId: 'd', deviceKey: 'k' },
      signal: new AbortController().signal,
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await value).toBeNull()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
