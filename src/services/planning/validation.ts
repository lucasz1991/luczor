import {
  MAX_PLANNING_STEPS,
  type PlanningAdapterId,
  type PlanningAnalysis,
  type PlanningPlan,
  type PlanningStep,
} from './types'

export const MAX_PLANNING_OBJECTIVE_CHARACTERS = 3_000
export const MAX_PLANNING_CLARIFICATIONS_CHARACTERS = 4_000
export const MAX_PLANNING_ANALYSIS_CHARACTERS = 6_000
export const MAX_PLANNING_PLAN_CHARACTERS = 12_000
export const MAX_PLANNING_IMPORT_CHARACTERS = 48_000

export const LOCAL_PLANNING_ACCESS_LIMIT =
  'Zugriffsgrenze: Kein direkter Datei- oder Toolzugriff; Belege stammen ausschließlich aus dem bereitgestellten Projektkontext.'

const ANALYSIS_KEYS = ['summary', 'findings', 'evidence', 'assumptions', 'risks', 'openQuestions'] as const
const STEP_KEYS = ['id', 'title', 'description', 'dependencies', 'acceptanceCriteria', 'verification'] as const
const PLAN_KEYS = ['objective', 'analysis', 'steps', 'completionCriteria', 'outOfScope'] as const
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/iu
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} muss ein Objekt sein.`)
  const candidate = value as Record<string, unknown>
  const present = Object.keys(candidate)
  if (present.length !== keys.length || present.some(key => !keys.includes(key))) {
    throw new Error(`${label} enthält fehlende oder unbekannte Felder.`)
  }
  return candidate
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`${label} muss Text sein.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || FORBIDDEN_TEXT.test(normalized)) {
    throw new Error(`${label} ist leer, zu lang oder enthält ungültige Steuerzeichen.`)
  }
  return normalized
}

function textList(
  value: unknown,
  label: string,
  options: { minimum?: number; maximum?: number; itemMaximum?: number } = {}
): readonly string[] {
  const minimum = options.minimum ?? 0
  const maximum = options.maximum ?? 16
  const itemMaximum = options.itemMaximum ?? 1_000
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} muss zwischen ${minimum} und ${maximum} Einträge enthalten.`)
  }
  const normalized = value.map((item, index) => text(item, `${label}[${index}]`, itemMaximum))
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} enthält doppelte Einträge.`)
  return Object.freeze(normalized)
}

function boundedJson(value: unknown, maximum: number, label: string): void {
  if (JSON.stringify(value).length > maximum) throw new Error(`${label} überschreitet das Zeichenlimit.`)
}

function unwrapJson(output: string, maximum: number, label: string): unknown {
  if (typeof output !== 'string' || !output.trim() || output.length > maximum) {
    throw new Error(`${label} ist leer oder überschreitet das Zeichenlimit.`)
  }
  const trimmed = output.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/iu.exec(trimmed)
  const source = fenced?.[1] ?? trimmed
  try {
    return JSON.parse(source) as unknown
  } catch {
    throw new Error(`${label} ist kein vollständiges JSON-Objekt.`)
  }
}

export function normalizePlanningObjective(value: unknown): string {
  return text(value, 'Planungsziel', MAX_PLANNING_OBJECTIVE_CHARACTERS)
}

export function normalizePlanningClarifications(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return text(value, 'Klarstellungen', MAX_PLANNING_CLARIFICATIONS_CHARACTERS)
}

export function validatePlanningAnalysis(value: unknown, options: { maximumEvidence?: number } = {}): PlanningAnalysis {
  const source = record(value, 'Analyse', ANALYSIS_KEYS)
  const result: PlanningAnalysis = Object.freeze({
    summary: text(Reflect.get(source, 'summary'), 'Analyse.summary', 2_000),
    findings: textList(Reflect.get(source, 'findings'), 'Analyse.findings', { maximum: 16 }),
    evidence: textList(Reflect.get(source, 'evidence'), 'Analyse.evidence', {
      minimum: 1,
      maximum: options.maximumEvidence ?? 16,
    }),
    assumptions: textList(Reflect.get(source, 'assumptions'), 'Analyse.assumptions', { maximum: 16 }),
    risks: textList(Reflect.get(source, 'risks'), 'Analyse.risks', { maximum: 16 }),
    openQuestions: textList(Reflect.get(source, 'openQuestions'), 'Analyse.openQuestions', { maximum: 16 }),
  })
  boundedJson(result, MAX_PLANNING_ANALYSIS_CHARACTERS, 'Analyse')
  return result
}

export function parsePlanningAnalysis(output: string, adapterId: PlanningAdapterId): PlanningAnalysis {
  try {
    const localOnly = adapterId !== 'codex'
    const parsed = validatePlanningAnalysis(
      unwrapJson(
        output,
        localOnly ? MAX_PLANNING_ANALYSIS_CHARACTERS - 500 : MAX_PLANNING_ANALYSIS_CHARACTERS,
        'Analyseantwort'
      ),
      { maximumEvidence: localOnly ? 15 : 16 }
    )
    if (adapterId === 'codex') return parsed
    return validatePlanningAnalysis({
      ...parsed,
      evidence: [LOCAL_PLANNING_ACCESS_LIMIT, ...parsed.evidence.filter(item => item !== LOCAL_PLANNING_ACCESS_LIMIT)],
    })
  } catch (error) {
    throw new Error(`Analyseantwort ungültig: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validatePlanningStep(value: unknown, index: number): PlanningStep {
  const source = record(value, `Plan.steps[${index}]`, STEP_KEYS)
  const id = text(Reflect.get(source, 'id'), `Plan.steps[${index}].id`, 64)
  if (!IDENTIFIER.test(id)) throw new Error(`Plan.steps[${index}].id ist keine gültige stabile ID.`)
  return Object.freeze({
    id,
    title: text(Reflect.get(source, 'title'), `Plan.steps[${index}].title`, 240),
    description: text(Reflect.get(source, 'description'), `Plan.steps[${index}].description`, 2_000),
    dependencies: textList(Reflect.get(source, 'dependencies'), `Plan.steps[${index}].dependencies`, {
      maximum: MAX_PLANNING_STEPS - 1,
      itemMaximum: 64,
    }),
    acceptanceCriteria: textList(Reflect.get(source, 'acceptanceCriteria'), `Plan.steps[${index}].acceptanceCriteria`, {
      minimum: 1,
      maximum: 12,
      itemMaximum: 800,
    }),
    verification: textList(Reflect.get(source, 'verification'), `Plan.steps[${index}].verification`, {
      minimum: 1,
      maximum: 12,
      itemMaximum: 800,
    }),
  })
}

function validateGraph(steps: readonly PlanningStep[]): void {
  const ids = new Set(steps.map(step => step.id))
  if (ids.size !== steps.length) throw new Error('Plan.steps enthält doppelte IDs.')
  for (const step of steps) {
    if (step.dependencies.includes(step.id)) throw new Error(`Schritt ${step.id} hängt von sich selbst ab.`)
    if (step.dependencies.some(dependency => !ids.has(dependency))) {
      throw new Error(`Schritt ${step.id} verweist auf eine unbekannte Abhängigkeit.`)
    }
  }

  const resolved = new Set<string>()
  while (resolved.size < steps.length) {
    const ready = steps.filter(
      step => !resolved.has(step.id) && step.dependencies.every(dependency => resolved.has(dependency))
    )
    if (!ready.length) throw new Error('Plan.steps enthält einen Abhängigkeitszyklus.')
    ready.forEach(step => resolved.add(step.id))
  }
}

export function validatePlanningPlan(
  value: unknown,
  expected: { objective?: string; analysis?: PlanningAnalysis } = {}
): PlanningPlan {
  const source = record(value, 'Plan', PLAN_KEYS)
  const rawSteps = Reflect.get(source, 'steps')
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > MAX_PLANNING_STEPS) {
    throw new Error(`Plan.steps muss zwischen 1 und ${MAX_PLANNING_STEPS} Schritte enthalten.`)
  }
  const steps = Object.freeze(rawSteps.map(validatePlanningStep))
  validateGraph(steps)
  const plan: PlanningPlan = Object.freeze({
    objective: normalizePlanningObjective(Reflect.get(source, 'objective')),
    analysis: validatePlanningAnalysis(Reflect.get(source, 'analysis')),
    steps,
    completionCriteria: textList(Reflect.get(source, 'completionCriteria'), 'Plan.completionCriteria', {
      minimum: 1,
      maximum: 16,
      itemMaximum: 1_000,
    }),
    outOfScope: textList(Reflect.get(source, 'outOfScope'), 'Plan.outOfScope', {
      maximum: 16,
      itemMaximum: 1_000,
    }),
  })
  if (expected.objective !== undefined && plan.objective !== expected.objective) {
    throw new Error('Plan.objective weicht vom freigegebenen Planungsziel ab.')
  }
  if (expected.analysis !== undefined && JSON.stringify(plan.analysis) !== JSON.stringify(expected.analysis)) {
    throw new Error('Plan.analysis weicht von der geprüften Analyse ab.')
  }
  boundedJson(plan, MAX_PLANNING_PLAN_CHARACTERS, 'Plan')
  return plan
}

export function parsePlanningPlan(
  output: string,
  expected: { objective: string; analysis: PlanningAnalysis }
): PlanningPlan {
  try {
    return validatePlanningPlan(unwrapJson(output, MAX_PLANNING_PLAN_CHARACTERS, 'Planantwort'), expected)
  } catch (error) {
    throw new Error(`Planantwort ungültig: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function parsePlanningJson(json: string): unknown {
  return unwrapJson(json, MAX_PLANNING_IMPORT_CHARACTERS, 'Planungsimport')
}
