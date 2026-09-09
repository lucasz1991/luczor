import type { WorkflowDefinition, WorkflowStepDefinition, WorkflowTask } from './types'

export type WorkflowField = { path: string; type: string; schema: Record<string, unknown> }
export const WORKFLOW_INPUT_NODE = '@input'
export const WORKFLOW_EVENT_NODE = '@event'
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const protectedTargets = new Set([
  'device_id',
  'workflow_definition_id',
  'file_scope',
  'workspace_root_id',
  'project_id',
  'body',
  'branches',
  'environment',
])
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const validPath = (value: string) =>
  /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(value) && !value.split('.').some(part => forbidden.has(part))
const types = (schema: Record<string, unknown>): string[] =>
  typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((v): v is string => typeof v === 'string')
      : []
export function workflowSchemaFields(schema: unknown, prefix = '', depth = 0): WorkflowField[] {
  if (depth >= 5) return []
  return Object.entries(record(record(schema).properties))
    .flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key
      if (!validPath(path)) return []
      const field = record(value)
      return [
        { path, schema: field, type: types(field).join(' | ') || 'Typ offen' },
        ...workflowSchemaFields(field, path, depth + 1),
      ]
    })
    .slice(0, 100)
}
export function workflowTaskInputSchema(task?: WorkflowTask): Record<string, unknown> {
  return {
    ...task?.input_schema,
    properties: {
      ...Object.fromEntries(Object.entries(task?.params ?? {}).map(([key, value]) => [key, { type: value.type }])),
      ...record(task?.input_schema?.properties),
    },
  }
}
export function workflowTaskOutputSchema(step: WorkflowStepDefinition, task?: WorkflowTask): Record<string, unknown> {
  const output = { ...task?.output_schema }
  if (['node.run', 'python.run'].includes(step.type) && step.payload.output_schema) {
    output.properties = { ...record(output.properties), data: record(step.payload.output_schema) }
  }
  return output
}
/** Same longest-key lookup as Laravel: dots are valid in existing step keys. */
export function workflowBindingSource(definition: WorkflowDefinition, reference: string) {
  if (!validPath(reference)) return null
  for (const [prefix, id] of [
    ['input.', WORKFLOW_INPUT_NODE],
    ['event.', WORKFLOW_EVENT_NODE],
  ] as const) {
    if (reference.startsWith(prefix)) return { id, path: reference.slice(prefix.length), reference }
  }
  const step = [...definition.steps]
    .sort((a, b) => b.key.length - a.key.length)
    .find(item => reference.startsWith(`steps.${item.key}.`))
  return step ? { id: step.key, path: reference.slice(`steps.${step.key}.`.length), reference } : null
}
export function workflowStepBindings(step: WorkflowStepDefinition): Array<{ target: string; reference: string }> {
  const result = new Map<string, string>()
  function walk(value: unknown, path: string, depth: number) {
    if (depth > 10 || path === 'input_bindings' || ['body', 'branches'].includes(path)) return
    const object = record(value)
    if (Object.keys(object).length === 1 && typeof object.$ref === 'string') result.set(path, object.$ref)
    else for (const [key, child] of Object.entries(object)) walk(child, path ? `${path}.${key}` : key, depth + 1)
  }
  walk(step.payload, '', 0)
  for (const [target, reference] of Object.entries(record(step.payload.input_bindings))) {
    if (typeof reference === 'string') result.set(target, reference)
  }
  return [...result].filter(([target]) => validPath(target)).map(([target, reference]) => ({ target, reference }))
}
function fieldSchema(schema: Record<string, unknown>, path: string): Record<string, unknown> {
  let current = schema
  for (const part of path.split('.')) {
    const properties = record(current.properties)
    if (!Object.hasOwn(properties, part)) {
      if (current.additionalProperties === false) throw new Error(`Das Feld „${path}“ ist im Schema nicht vorgesehen.`)
      return {}
    }
    current = record(Reflect.get(properties, part))
  }
  return current
}
export function inspectWorkflowBinding(
  definition: WorkflowDefinition,
  catalog: WorkflowTask[],
  targetKey: string,
  targetPath: string,
  reference: string
): { source: { id: string; path: string; reference: string }; verification: 'types_compatible' | 'runtime_required' } {
  if (!validPath(targetPath) || protectedTargets.has(targetPath.split('.')[0]!))
    throw new Error('Diese Datenverbindung darf Identität, Rechte oder Ablaufdefinition nicht ändern.')
  const target = definition.steps.find(step => step.key === targetKey)
  const source = workflowBindingSource(definition, reference)
  if (!target || !source || source.id === targetKey)
    throw new Error('Wähle eine vorhandene Quelle und einen anderen Zielschritt.')
  const sourceStep = definition.steps.find(step => step.key === source.id)
  const sourceSchema =
    source.id === WORKFLOW_INPUT_NODE
      ? record(definition.input_schema)
      : sourceStep
        ? workflowTaskOutputSchema(
            sourceStep,
            catalog.find(task => task.key === sourceStep.type)
          )
        : {}
  const from = types(fieldSchema(sourceSchema, source.path))
  const to = types(fieldSchema(workflowTaskInputSchema(catalog.find(task => task.key === target.type)), targetPath))
  if (
    from.length &&
    to.length &&
    !from.every(type => to.includes(type) || (type === 'integer' && to.includes('number')))
  )
    throw new Error(`Die Datentypen passen nicht: ${from.join(' | ')} → ${to.join(' | ')}.`)
  return { source, verification: from.length && to.length ? 'types_compatible' : 'runtime_required' }
}

export function workflowPorts(definition: WorkflowDefinition, catalog: WorkflowTask[], key: string) {
  const step = definition.steps.find(item => item.key === key)
  const task = catalog.find(item => item.key === step?.type)
  const inputs = step
    ? workflowSchemaFields(workflowTaskInputSchema(task)).filter(
        field => !protectedTargets.has(field.path.split('.')[0]!) && field.path !== 'input_bindings'
      )
    : []
  const outputs = workflowSchemaFields(
    key === WORKFLOW_INPUT_NODE ? definition.input_schema : step ? workflowTaskOutputSchema(step, task) : {}
  )
  for (const target of definition.steps)
    for (const binding of workflowStepBindings(target)) {
      const source = workflowBindingSource(definition, binding.reference)
      if (target.key === key && !inputs.some(field => field.path === binding.target))
        inputs.push({ path: binding.target, type: 'Typ offen', schema: {} })
      if (source?.id === key && !outputs.some(field => field.path === source.path))
        outputs.push({ path: source.path, type: 'Typ offen', schema: {} })
    }
  return { inputs, outputs }
}
