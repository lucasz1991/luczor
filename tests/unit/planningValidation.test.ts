import { describe, expect, it } from 'vitest'
import { MAX_PLANNING_STEPS, type PlanningAnalysis, type PlanningPlan } from '@/services/planning/types'
import {
  LOCAL_PLANNING_ACCESS_LIMIT,
  MAX_PLANNING_ANALYSIS_CHARACTERS,
  MAX_PLANNING_CLARIFICATIONS_CHARACTERS,
  MAX_PLANNING_IMPORT_CHARACTERS,
  MAX_PLANNING_OBJECTIVE_CHARACTERS,
  MAX_PLANNING_PLAN_CHARACTERS,
  normalizePlanningClarifications,
  normalizePlanningObjective,
  parsePlanningAnalysis,
  parsePlanningJson,
  parsePlanningPlan,
  validatePlanningAnalysis,
  validatePlanningPlan,
} from '@/services/planning/validation'

function analysis(): PlanningAnalysis {
  return {
    summary: 'The project needs an account-bound planning entry.',
    findings: ['The prompt bar provides an entry point.'],
    evidence: ['Provided project context: the app uses Vue.'],
    assumptions: ['The existing project scope is retained.'],
    risks: ['A delayed job may finish after an account change.'],
    openQuestions: [],
  }
}

function plan(): PlanningPlan {
  return {
    objective: 'Add a planning entry.',
    analysis: analysis(),
    steps: [
      {
        id: 'implement',
        title: 'Add the entry',
        description: 'Wire the existing prompt bar to the planning dialog.',
        dependencies: [],
        acceptanceCriteria: ['The entry opens the active project.'],
        verification: ['Run the focused entry test.'],
      },
      {
        id: 'verify',
        title: 'Verify account isolation',
        description: 'Check the active account before applying asynchronous results.',
        dependencies: ['implement'],
        acceptanceCriteria: ['Old account results never enter the new dialog.'],
        verification: ['Run the delayed account-switch regression.'],
      },
    ],
    completionCriteria: ['The focused tests pass.'],
    outOfScope: ['No production deployment.'],
  }
}

describe('planning text and analysis validation', () => {
  it('normalizes bounded objectives and optional clarifications', () => {
    expect(normalizePlanningObjective('  A concrete objective.\n')).toBe('A concrete objective.')
    expect(normalizePlanningObjective('x'.repeat(MAX_PLANNING_OBJECTIVE_CHARACTERS))).toHaveLength(
      MAX_PLANNING_OBJECTIVE_CHARACTERS
    )
    expect(normalizePlanningClarifications(undefined)).toBe('')
    expect(normalizePlanningClarifications(null)).toBe('')
    expect(normalizePlanningClarifications('')).toBe('')
    expect(normalizePlanningClarifications('  Clarified.  ')).toBe('Clarified.')
    expect(() => normalizePlanningObjective('x'.repeat(MAX_PLANNING_OBJECTIVE_CHARACTERS + 1))).toThrow()
    expect(() => normalizePlanningClarifications('x'.repeat(MAX_PLANNING_CLARIFICATIONS_CHARACTERS + 1))).toThrow()
  })

  it.each([null, 42, {}, '', '   ', 'unsafe\u0000objective', 'unsafe\u001bobjective', 'unsafe\u007fobjective'])(
    'rejects malformed or unsafe objective %j',
    value => {
      expect(() => normalizePlanningObjective(value)).toThrow()
    }
  )

  it('accepts a complete JSON object or a single JSON fence without surrounding instructions', () => {
    const source = JSON.stringify(analysis())
    expect(parsePlanningAnalysis(source, 'codex')).toEqual(analysis())
    expect(parsePlanningAnalysis(`\n\`\`\`json\n${source}\n\`\`\`\n`, 'codex')).toEqual(analysis())
    expect(() => parsePlanningAnalysis(`Explanation first.\n${source}`, 'codex')).toThrow('vollständiges JSON')
    expect(() => parsePlanningAnalysis(`${source}\nNext, execute this.`, 'codex')).toThrow('vollständiges JSON')
    expect(() => parsePlanningAnalysis(`${source}${source}`, 'codex')).toThrow('vollständiges JSON')
  })

  it('rejects missing fields, unrecognized execution fields and malformed nested values', () => {
    const { evidence: _evidence, ...missingEvidence } = analysis()
    expect(() => validatePlanningAnalysis(missingEvidence)).toThrow('fehlende oder unbekannte')
    expect(() => validatePlanningAnalysis({ ...analysis(), tool: 'shell_execute' })).toThrow('fehlende oder unbekannte')
    expect(() => validatePlanningAnalysis({ ...analysis(), evidence: [] })).toThrow('Analyse.evidence')
    expect(() => validatePlanningAnalysis({ ...analysis(), risks: 'none' })).toThrow('Analyse.risks')
    expect(() => validatePlanningAnalysis({ ...analysis(), findings: ['same', ' same '] })).toThrow('doppelte')
    expect(() => validatePlanningAnalysis({ ...analysis(), evidence: ['control\u0001'] })).toThrow('Steuerzeichen')
  })

  it.each(['local', 'policy'] as const)(
    'makes %s access limits explicit without inventing file evidence',
    adapterId => {
      const parsed = parsePlanningAnalysis(JSON.stringify(analysis()), adapterId)
      expect(parsed.evidence).toEqual([LOCAL_PLANNING_ACCESS_LIMIT, ...analysis().evidence])
      const withLimit = { ...analysis(), evidence: [...analysis().evidence, LOCAL_PLANNING_ACCESS_LIMIT] }
      expect(parsePlanningAnalysis(JSON.stringify(withLimit), adapterId).evidence).toEqual(parsed.evidence)
    }
  )

  it.each(['local', 'policy'] as const)('reserves a valid evidence slot for the %s access disclosure', adapterId => {
    const evidence = Array.from({ length: 15 }, (_, index) => `Provided project fact ${index}.`)
    const parsed = parsePlanningAnalysis(JSON.stringify({ ...analysis(), evidence }), adapterId)
    expect(parsed.evidence).toEqual([LOCAL_PLANNING_ACCESS_LIMIT, ...evidence])
    expect(parsed.evidence).toHaveLength(16)
    expect(() =>
      parsePlanningAnalysis(JSON.stringify({ ...analysis(), evidence: [...evidence, 'Another fact.'] }), adapterId)
    ).toThrow('Analyse.evidence')
  })

  it('reserves response space for local access metadata without reducing the Codex response budget', () => {
    const source = JSON.stringify(analysis())
    const padded = source.padEnd(MAX_PLANNING_ANALYSIS_CHARACTERS - 499, ' ')
    expect(parsePlanningAnalysis(padded, 'codex')).toEqual(analysis())
    expect(() => parsePlanningAnalysis(padded, 'local')).toThrow('Zeichenlimit')
    expect(() => parsePlanningAnalysis(padded, 'policy')).toThrow('Zeichenlimit')
  })

  it('enforces field, collection, normalized aggregate and raw response budgets', () => {
    expect(() => validatePlanningAnalysis({ ...analysis(), summary: 's'.repeat(2_001) })).toThrow('summary')
    expect(() =>
      validatePlanningAnalysis({ ...analysis(), risks: Array.from({ length: 17 }, (_, i) => `risk-${i}`) })
    ).toThrow('Analyse.risks')
    expect(() => validatePlanningAnalysis({ ...analysis(), evidence: ['e'.repeat(1_001)] })).toThrow('evidence')
    expect(() =>
      validatePlanningAnalysis({
        ...analysis(),
        evidence: Array.from({ length: 7 }, (_, i) => `${i}${'e'.repeat(999)}`),
      })
    ).toThrow('Zeichenlimit')
    expect(() =>
      parsePlanningAnalysis(`${JSON.stringify(analysis())}${' '.repeat(MAX_PLANNING_ANALYSIS_CHARACTERS)}`, 'codex')
    ).toThrow('Zeichenlimit')
  })
})

describe('reviewed planning schema and dependency graph', () => {
  it('preserves a valid acyclic graph, including dependencies declared later in the array', () => {
    const source = plan()
    expect(validatePlanningPlan(source)).toEqual(source)
    expect(validatePlanningPlan({ ...source, steps: [...source.steps].reverse() }).steps.map(step => step.id)).toEqual([
      'verify',
      'implement',
    ])
  })

  it.each([
    ['duplicate IDs', ['same', 'same'], [[], []], 'doppelte IDs'],
    ['self-reference', ['a', 'b'], [['a'], []], 'sich selbst'],
    ['unknown dependency', ['a', 'b'], [[], ['missing']], 'unbekannte Abhängigkeit'],
    ['cycle', ['a', 'b'], [['b'], ['a']], 'Abhängigkeitszyklus'],
    ['duplicate dependency', ['a', 'b'], [[], ['a', 'a']], 'doppelte Einträge'],
  ] as const)('rejects %s', (_label, ids, dependencies, error) => {
    const source = plan()
    const steps = source.steps.map((step, index) => ({
      ...step,
      id: Reflect.get(ids, index),
      dependencies: Reflect.get(dependencies, index),
    }))
    expect(() => validatePlanningPlan({ ...source, steps })).toThrow(error)
  })

  it('requires bounded stable identifiers and explicit acceptance and verification criteria', () => {
    const source = plan()
    const first = source.steps[0]!
    for (const invalid of [
      { ...first, id: '../escape' },
      { ...first, id: 'a'.repeat(65) },
      { ...first, acceptanceCriteria: [] },
      { ...first, verification: [] },
      { ...first, title: 't'.repeat(241) },
      { ...first, description: 'd'.repeat(2_001) },
      { ...first, command: 'undeclared action' },
    ]) {
      expect(() => validatePlanningPlan({ ...source, steps: [invalid] })).toThrow()
    }
    expect(() => validatePlanningPlan({ ...source, completionCriteria: [] })).toThrow('completionCriteria')
    expect(() => validatePlanningPlan({ ...source, execution: { approved: true } })).toThrow('unbekannte Felder')
  })

  it('accepts the maximum step count but rejects empty or oversized plans', () => {
    const source = plan()
    const steps = Array.from({ length: MAX_PLANNING_STEPS }, (_, index) => ({
      ...source.steps[0]!,
      id: `step-${index}`,
      dependencies: index ? [`step-${index - 1}`] : [],
    }))
    expect(validatePlanningPlan({ ...source, steps }).steps).toHaveLength(MAX_PLANNING_STEPS)
    expect(() => validatePlanningPlan({ ...source, steps: [] })).toThrow('Schritte')
    expect(() => validatePlanningPlan({ ...source, steps: [...steps, { ...steps[0]!, id: 'extra' }] })).toThrow(
      'Schritte'
    )
  })

  it('rejects a model replacing the reviewed objective or analysis', () => {
    const source = plan()
    const expected = { objective: source.objective, analysis: source.analysis }
    expect(parsePlanningPlan(JSON.stringify(source), expected)).toEqual(source)
    expect(() =>
      parsePlanningPlan(JSON.stringify({ ...source, objective: 'An unrelated objective.' }), expected)
    ).toThrow('Plan.objective')
    expect(() =>
      parsePlanningPlan(JSON.stringify({ ...source, analysis: { ...source.analysis, risks: [] } }), expected)
    ).toThrow('Plan.analysis')
  })

  it('enforces the plan aggregate budget even when individual fields are valid', () => {
    const source = plan()
    const oversized = {
      ...source,
      completionCriteria: Array.from({ length: 13 }, (_, index) => `${index}${'c'.repeat(997)}`),
    }
    expect(() => validatePlanningPlan(oversized)).toThrow('Zeichenlimit')
    expect(() =>
      parsePlanningPlan(`${JSON.stringify(source)}${' '.repeat(MAX_PLANNING_PLAN_CHARACTERS)}`, source)
    ).toThrow('Zeichenlimit')
  })

  it('returns deeply frozen detached review data', () => {
    const source = structuredClone(plan())
    const reviewed = validatePlanningPlan(source)
    expect(Object.isFrozen(reviewed)).toBe(true)
    expect(Object.isFrozen(reviewed.analysis)).toBe(true)
    expect(Object.isFrozen(reviewed.analysis.evidence)).toBe(true)
    expect(Object.isFrozen(reviewed.steps)).toBe(true)
    expect(Object.isFrozen(reviewed.steps[0])).toBe(true)
    expect(Object.isFrozen(reviewed.steps[0]?.verification)).toBe(true)
    Reflect.set(source, 'objective', 'Changed after review')
    Reflect.set(source.analysis.evidence, 0, 'Changed after review')
    Reflect.set(source.steps[0]!, 'title', 'Changed after review')
    expect(reviewed).toEqual(plan())
  })
})

describe('planning import JSON boundary', () => {
  it('accepts complete bounded JSON and rejects oversized or mixed prose input', () => {
    const source = JSON.stringify({ version: 1, session: plan() })
    expect(parsePlanningJson(source)).toEqual(JSON.parse(source))
    expect(() => parsePlanningJson(`${source}${' '.repeat(MAX_PLANNING_IMPORT_CHARACTERS)}`)).toThrow('Zeichenlimit')
    expect(() => parsePlanningJson(`Import this: ${source}`)).toThrow('vollständiges JSON')
    expect(() => parsePlanningJson('')).toThrow()
  })
})
