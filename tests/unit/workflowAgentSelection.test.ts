import { describe, expect, it } from 'vitest'
import {
  assertWorkflowAgentSelectionCurrent,
  selectWorkflowAgent,
  workflowAgentTask,
  type WorkflowAgentAvailability,
} from '@/services/workflows/agentSelection'

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
