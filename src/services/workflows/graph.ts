import type { WorkflowDefinition, WorkflowTask } from './types'

export type GraphPosition = { x: number; y: number }
type Layout = Record<string, GraphPosition>
const validPosition = (v: unknown): v is GraphPosition =>
  !!v &&
  typeof v === 'object' &&
  ['x', 'y'].every(key => {
    const n = Reflect.get(v, key)
    return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000
  })

/** Layout is presentation metadata. It never determines execution order. */
export function moveWorkflowNode(
  definition: WorkflowDefinition,
  key: string,
  position: GraphPosition
): WorkflowDefinition {
  if (!definition.steps.some(step => step.key === key) || !validPosition(position))
    throw new Error('Ungültige Knotenposition.')
  const old = definition.meta?.node_positions
  const positions: Layout = Object.fromEntries(
    Object.entries(old && typeof old === 'object' ? old : {}).filter(
      ([id, value]) => definition.steps.some(step => step.key === id) && validPosition(value)
    )
  )
  return {
    ...definition,
    meta: {
      ...definition.meta,
      node_positions: { ...positions, [key]: { x: Math.round(position.x), y: Math.round(position.y) } },
    },
  }
}

export function connectWorkflowSteps(
  definition: WorkflowDefinition,
  source: string,
  target: string
): WorkflowDefinition {
  const steps = new Map(definition.steps.map(step => [step.key, step]))
  if (!steps.has(source) || !steps.has(target) || source === target)
    throw new Error('Wähle zwei unterschiedliche vorhandene Schritte.')
  const visited = new Set<string>()
  const depends = (key: string): boolean => {
    if (key === target) return true
    if (visited.has(key)) return false
    visited.add(key)
    return (steps.get(key)?.depends_on ?? []).some(depends)
  }
  if (depends(source))
    throw new Error('Diese Verbindung erzeugt einen Kreis. Nutze für Wiederholungen einen Schleifenbaustein.')
  return {
    ...definition,
    steps: definition.steps.map(step =>
      step.key === target ? { ...step, depends_on: [...new Set([...(step.depends_on ?? []), source])] } : step
    ),
  }
}

export function workflowGraph(definition: WorkflowDefinition, catalog: WorkflowTask[] = []) {
  const positions = definition.meta?.node_positions as Layout | undefined
  const keys = new Set(definition.steps.map(step => step.key))
  const nodes = definition.steps.map((step, index) => {
    const task = catalog.find(item => item.key === step.type)
    return {
      id: step.key,
      type: 'workflow',
      position: validPosition(positions?.[step.key])
        ? { ...positions![step.key]! }
        : { x: (index % 3) * 300, y: Math.floor(index / 3) * 220 },
      data: {
        title: typeof step.payload.title === 'string' && step.payload.title ? step.payload.title : step.key,
        task: task?.label ?? step.type,
        key: step.key,
        location: task?.runner === 'server' ? 'Server' : task?.runner === 'client' ? 'Gerät' : 'Ausführungsort offen',
        input: Object.keys((step.payload.input_bindings ?? {}) as object).join(', ') || 'Definierte Parameter',
        output: Object.keys((task?.output_schema?.properties ?? {}) as object).join(', ') || 'Schrittergebnis',
        failure:
          step.routes?.failed?.type === 'step'
            ? step.routes.failed.step_key
            : step.routes?.failed?.type === 'end'
              ? 'Beenden'
              : 'Lauf mit Fehlerstatus',
      },
    }
  })
  const edges: Array<{
    id: string
    source: string
    target: string
    label: string
    class: string
    style?: Record<string, string>
  }> = []
  for (const step of definition.steps) {
    for (const source of step.depends_on ?? [])
      if (keys.has(source))
        edges.push({
          id: `dependency:${source}:${step.key}`,
          source,
          target: step.key,
          label: 'Ablauf',
          class: 'wf-edge--dependency',
        })
    for (const [field, path] of Object.entries((step.payload.input_bindings ?? {}) as Record<string, unknown>)) {
      const match = typeof path === 'string' ? /^steps\.([^.]+)\.(.+)$/u.exec(path) : null
      if (match && keys.has(match[1]!))
        edges.push({
          id: `data:${match[1]}:${step.key}:${field}`,
          source: match[1]!,
          target: step.key,
          label: `${match[2]} → ${field}`,
          class: 'wf-edge--data',
          style: { stroke: '#ac95ea', strokeDasharray: '5 4' },
        })
    }
    for (const [outcome, route] of Object.entries(step.routes ?? {}))
      if (route.type === 'step' && route.step_key && keys.has(route.step_key))
        edges.push({
          id: `route:${step.key}:${outcome}`,
          source: step.key,
          target: route.step_key,
          label: outcome === 'failed' ? 'Bei Fehler' : outcome,
          class: 'wf-edge--outcome',
          style: { stroke: outcome === 'failed' ? '#d68e8e' : '#8cbeb5' },
        })
  }
  return { nodes, edges }
}
