import { describe, expect, it } from 'vitest'
import {
  assertWorkflowAgentSelectionCurrent,
  selectWorkflowAgent,
  workflowAgentTask,
  type WorkflowAgentAvailability,
} from '@/services/workflows/agentSelection'
import type { VerifiedAgentEvidence } from '@/services/workflows/agentEvidence'

function availability(): WorkflowAgentAvailability {
  return {
    externalPolicy: 'ask',
    local: { manifestAvailable: true, state: 'ready', activeModelId: 'local' },
    codex: {
      available: true,
      catalog: {
        source: 'codex-cache',
        revision: 'codex-revision',
        validForSeconds: 300,
        models: [{ model: 'codex-test-model', supportedEfforts: ['low', 'medium', 'high'] }],
      },
    },
    claude: {
      available: true,
      cliVersion: '2.1.266',
      catalog: {
        source: 'sdk-documentation',
        revision: 'claude-revision',
        models: [{ model: 'claude-test-model', supportedEfforts: ['low', 'medium', 'high', 'max'] }],
      },
    },
  }
}
function choose(changes: Partial<Parameters<typeof selectWorkflowAgent>[0]> = {}) {
  return selectWorkflowAgent({
    team: false,
    instruction: 'Implementiere Code',
    mode: 'act',
    projectBound: true,
    tier: 'fast',
    availability: availability(),
    ...changes,
  })
}

describe('workflow managed adapter selection', () => {
  it('ranks only comparable verified real-test outcomes after capability and budget filters', () => {
    const evidence: VerifiedAgentEvidence = {
      version: 1,
      revision: 'a'.repeat(64),
      scope_hash: 'b'.repeat(64),
      device_environment_hash: 'c'.repeat(64),
      minimum_samples: 5,
      rows: [
        {
          adapter: 'claude',
          model: 'claude-test-model',
          model_source: 'runtime',
          samples: 6,
          passed: 6,
          failed: 0,
          latest_test_at: '2026-09-08T10:00:00Z',
          evidence_ids: [1, 2, 3, 4, 5, 6],
        },
        {
          adapter: 'codex',
          model: 'codex-test-model',
          model_source: 'pinned_request',
          samples: 5,
          passed: 3,
          failed: 2,
          latest_test_at: '2026-09-08T10:00:00Z',
          evidence_ids: [7, 8, 9, 10, 11],
        },
      ],
    }
    expect(choose({ evidence })).toMatchObject({
      adapter: 'claude',
      model: 'claude-test-model',
      qualityEvidence: 'verified_real_tests',
      qualityEvidenceLabel: 'Verifizierter Testfallerfolg vergleichbarer Aufgabe',
      evidence: { samples: 6, passed: 6, failed: 0 },
    })
    expect(
      choose({ evidence, availability: { ...availability(), claude: { ...availability().claude, available: false } } })
    ).toMatchObject({ adapter: 'codex', qualityEvidence: 'verified_real_tests' })
    expect(choose({ evidence, availability: { ...availability(), externalPolicy: 'deny' } }).adapter).toBe('local')
    // Two sub-threshold provenance cohorts cannot be pooled into a qualified model score.
    const partialRows = (['runtime', 'pinned_request'] as const).map((model_source, index) => ({
      ...evidence.rows[0]!,
      model_source,
      samples: 3,
      passed: 3,
      failed: 0,
      evidence_ids: [1, 2, 3].map(id => id + index * 3),
    }))
    expect(choose({ evidence: { ...evidence, rows: partialRows } })).toMatchObject({
      adapter: 'codex',
      qualityEvidence: 'unavailable',
    })
  })

  it('can select a later compatible model with real evidence but never treats a named unknown model as quality proof', () => {
    const data = availability()
    const evidence: VerifiedAgentEvidence = {
      version: 1,
      revision: 'a'.repeat(64),
      scope_hash: 'b'.repeat(64),
      device_environment_hash: 'c'.repeat(64),
      minimum_samples: 5,
      rows: [
        {
          adapter: 'codex',
          model: 'second-model',
          model_source: 'pinned_request',
          samples: 5,
          passed: 5,
          failed: 0,
          latest_test_at: '2026-09-08T10:00:00Z',
          evidence_ids: [1, 2, 3, 4, 5],
        },
      ],
    }
    expect(
      choose({
        evidence,
        availability: {
          ...data,
          codex: {
            ...data.codex,
            catalog: {
              ...data.codex.catalog,
              models: [...data.codex.catalog.models, { model: 'second-model', supportedEfforts: ['low'] }],
            },
          },
        },
      })
    ).toMatchObject({ model: 'second-model', qualityEvidence: 'verified_real_tests' })
    expect(choose({ evidence })).toMatchObject({ model: 'codex-test-model', qualityEvidence: 'unavailable' })
    expect(choose({ evidence, maxBudgetUsd: 0.5 }).adapter).toBe('claude')
  })
  it('selects a compatible installed coding adapter with an explicit pinned model and honest unknown authentication/cost', () => {
    expect(choose()).toMatchObject({
      adapter: 'codex',
      model: 'codex-test-model',
      permission: 'workspace-write',
      availability: 'runtime_present_auth_unknown',
      cost: 'unknown',
      qualityEvidence: 'unavailable',
      effortSelection: { requestedEffort: 'low', status: 'requested' },
    })
  })
  it('preserves local general/planning and the existing admin role team engine', () => {
    expect(choose({ instruction: 'Fasse den Text zusammen' }).adapter).toBe('local')
    expect(choose({ instruction: 'Erstelle einen Plan' })).toMatchObject({
      adapter: 'local',
      reason: 'local_planning_no_provider_cost',
    })
    expect(choose({ team: true })).toMatchObject({
      adapter: 'local',
      reason: 'local_orchestrator_with_approved_admin_specialists',
    })
  })
  it('raises a real reviewer role above a fast prompt without raising its permission', () => {
    expect(choose({ instruction: 'Review den Code', mode: 'observe' })).toMatchObject({
      adapter: 'codex',
      role: 'reviewer',
      permission: 'read-only',
      effortSelection: { requestedEffort: 'high', reason: 'role_requires_deeper_review' },
    })
  })
  it.each([
    { projectBound: false },
    { mode: 'observe' as const },
    { availability: { ...availability(), externalPolicy: 'deny' as const } },
  ])('honors workspace, mode and external-policy restrictions', changes => {
    expect(choose(changes).adapter).toBe('local')
  })
  it('filters Codex instead of claiming it can enforce an SDK cost or turns cap', () => {
    expect(choose({ maxBudgetUsd: 0.25 })).toMatchObject({
      adapter: 'claude',
      cost: 'sdk_budget_cap',
      excluded: ['codex:requested_budget_controls_unavailable'],
    })
    expect(choose({ maxTurns: 4 }).adapter).toBe('claude')
  })
  it('never uses expired cache metadata or a missing runtime as availability proof', () => {
    const data = availability()
    expect(
      choose({
        availability: { ...data, codex: { ...data.codex, catalog: { ...data.codex.catalog, validForSeconds: 0 } } },
      }).adapter
    ).toBe('claude')
    expect(
      choose({
        availability: {
          ...data,
          codex: { ...data.codex, available: false },
          claude: { ...data.claude, available: false },
        },
      })
    ).toMatchObject({ adapter: 'local', reason: 'no_eligible_managed_agent_local_policy' })
  })
  it('can use an approved external candidate when the signed local runtime is unavailable', () => {
    expect(
      choose({ instruction: 'Analysiere den Text', availability: { ...availability(), local: null } }).adapter
    ).toBe('codex')
  })
  it('does not manufacture price or quality ranking from model naming', () => {
    const data = availability()
    const picked = choose({
      availability: {
        ...data,
        codex: {
          ...data.codex,
          catalog: {
            ...data.codex.catalog,
            models: [
              { model: 'expensive-unknown', supportedEfforts: ['low'] },
              { model: 'cheap-in-name-only', supportedEfforts: ['low'] },
            ],
          },
        },
      },
    })
    expect(picked).toMatchObject({ model: 'expensive-unknown', cost: 'unknown', qualityEvidence: 'unavailable' })
  })
  it.each(['policy', 'runtime', 'model', 'revision', 'expiry', 'cli'])(
    'invalidates a changed %s before dispatch',
    changed => {
      const picked = choose(changed === 'cli' ? { maxTurns: 3 } : {})
      const data = structuredClone(availability())
      if (changed === 'policy') Object.assign(data, { externalPolicy: 'deny' })
      if (changed === 'runtime') Object.assign(data.codex, { available: false })
      if (changed === 'model') Object.assign(data.codex.catalog, { models: [] })
      if (changed === 'revision') Object.assign(data.codex.catalog, { revision: 'changed' })
      if (changed === 'expiry') Object.assign(data.codex.catalog, { validForSeconds: 0 })
      if (changed === 'cli') Object.assign(data.claude, { cliVersion: 'different' })
      expect(() => assertWorkflowAgentSelectionCurrent(picked, data)).toThrow('workflow_agent_selection_changed')
    }
  )
  it('matches tasks from reviewed instructions without reading any external input data', () => {
    expect(workflowAgentTask('Review Code')).toBe('review')
    expect(workflowAgentTask('Erstelle Architektur')).toBe('planning')
    expect(workflowAgentTask('Fasse den Inhalt zusammen')).toBe('general')
  })
})
