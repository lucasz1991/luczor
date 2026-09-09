/* eslint id-length: ["error", { "min": 2, "exceptions": ["x", "y"] }] -- Vue Flow's coordinate contract uses x/y. */
import type { WorkflowDefinition, WorkflowTask, WorkflowTrigger } from './types'
import {
  inspectWorkflowBinding,
  workflowBindingSource,
  workflowPorts,
  workflowStepBindings,
  WORKFLOW_INPUT_NODE,
  WORKFLOW_EVENT_NODE,
} from './bindings'

export type GraphPosition = { x: number; y: number }
type Layout = Record<string, GraphPosition>
/** Shared with the node template: bounded summary text plus one line for every actual port. */
export const WORKFLOW_NODE_METRICS = Object.freeze({ width: 280, summary: 170, padding: 12, port: 26, gap: 56 })
export function workflowNodeSize(inputs: number, outputs: number) {
  const ports = inputs + outputs
  return {
    width: WORKFLOW_NODE_METRICS.width,
    height:
      WORKFLOW_NODE_METRICS.summary +
      WORKFLOW_NODE_METRICS.padding * 2 +
      2 +
      (ports ? 15 + ports * WORKFLOW_NODE_METRICS.port : 0),
  }
}
type SizedNode = {
  id: string
  position: GraphPosition
  data: { sourceKind: string; layout: ReturnType<typeof workflowNodeSize> }
}
type Rectangle = GraphPosition & { width: number; height: number }
const intersects = (left: Rectangle, right: Rectangle) =>
  left.x < right.x + right.width + WORKFLOW_NODE_METRICS.gap &&
  left.x + left.width + WORKFLOW_NODE_METRICS.gap > right.x &&
  left.y < right.y + right.height + WORKFLOW_NODE_METRICS.gap &&
  left.y + left.height + WORKFLOW_NODE_METRICS.gap > right.y

/** Only unpositioned nodes move. Reserve every saved rectangle before placing new nodes. */
function positionWorkflowNodes(nodes: SizedNode[], positions: Layout | undefined) {
  const occupied: Rectangle[] = nodes
    .filter(node => !node.data.sourceKind && validPosition(positions?.[node.id]))
    .map(node => ({ ...positions![node.id]!, ...node.data.layout }))
  const pitch = WORKFLOW_NODE_METRICS.width + WORKFLOW_NODE_METRICS.gap
  const place = (node: SizedNode, initial: GraphPosition) => {
    const rectangle = { ...initial, ...node.data.layout }
    let collisions = occupied.filter(other => intersects(rectangle, other))
    while (collisions.length) {
      rectangle.y = Math.max(...collisions.map(other => other.y + other.height + WORKFLOW_NODE_METRICS.gap))
      collisions = occupied.filter(other => intersects(rectangle, other))
    }
    node.position = { x: rectangle.x, y: rectangle.y }
    occupied.push(rectangle)
    return rectangle.y + rectangle.height + WORKFLOW_NODE_METRICS.gap
  }
  for (const kinds of [['trigger'], ['input', 'event']]) {
    let top = 0
    for (const node of nodes.filter(item => kinds.includes(item.data.sourceKind)))
      top = place(node, { x: (kinds[0] === 'trigger' ? -2 : -1) * pitch, y: top })
  }
  const steps = nodes.filter(node => !node.data.sourceKind)
  let top = 0
  for (let index = 0; index < steps.length; index += 3) {
    const row = steps.slice(index, index + 3)
    let bottom = top
    row.forEach((node, column) => {
      if (validPosition(positions?.[node.id])) {
        node.position = { ...positions![node.id]! }
      } else bottom = Math.max(bottom, place(node, { x: column * pitch, y: top }))
    })
    top = bottom
  }
}
const validPosition = (value: unknown): value is GraphPosition =>
  !!value &&
  typeof value === 'object' &&
  ['x', 'y'].every(key => {
    const coordinate = Reflect.get(value, key)
    return typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= 100_000
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

export function connectWorkflowData(
  definition: WorkflowDefinition,
  catalog: WorkflowTask[],
  source: string,
  field: string,
  target: string,
  targetField: string
): WorkflowDefinition {
  const prefix = source === WORKFLOW_INPUT_NODE ? 'input' : source === WORKFLOW_EVENT_NODE ? 'event' : `steps.${source}`
  const reference = `${prefix}.${field}`
  const result = inspectWorkflowBinding(definition, catalog, target, targetField, reference)
  const next = result.source.id.startsWith('@') ? definition : connectWorkflowSteps(definition, source, target)
  return {
    ...next,
    steps: next.steps.map(step =>
      step.key === target
        ? {
            ...step,
            payload: {
              ...step.payload,
              input_bindings: { ...((step.payload.input_bindings as object) ?? {}), [targetField]: reference },
            },
          }
        : step
    ),
  }
}

export function workflowGraph(
  definition: WorkflowDefinition,
  catalog: WorkflowTask[] = [],
  triggers: WorkflowTrigger[] = []
) {
  const positions = definition.meta?.node_positions as Layout | undefined
  const keys = new Set(definition.steps.map(step => step.key))
  const nodes = definition.steps.map(step => {
    const task = catalog.find(item => item.key === step.type)
    return {
      id: step.key,
      type: 'workflow',
      draggable: true,
      position: { x: 0, y: 0 },
      data: {
        title: typeof step.payload.title === 'string' && step.payload.title ? step.payload.title : step.key,
        task: task?.label ?? step.type,
        key: step.key,
        sourceKind: '' as '' | 'input' | 'event' | 'trigger',
        ...workflowPorts(definition, catalog, step.key),
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
    sourceHandle?: string
    targetHandle?: string
    style?: Record<string, string>
  }> = []
  const usedSources = new Set(
    definition.steps.flatMap(step =>
      workflowStepBindings(step).map(binding => workflowBindingSource(definition, binding.reference)?.id)
    )
  )
  if (definition.input_schema || triggers.length || usedSources.has(WORKFLOW_INPUT_NODE))
    usedSources.add(WORKFLOW_INPUT_NODE)
  for (const [id, title, kind] of [
    [WORKFLOW_INPUT_NODE, 'Workflow-Eingaben', 'input'],
    [WORKFLOW_EVENT_NODE, 'Ereignisdaten', 'event'],
  ] as const) {
    if (!usedSources.has(id)) continue
    nodes.push({
      id,
      type: 'workflow',
      draggable: false,
      position: { x: 0, y: 0 },
      data: {
        key: id,
        title,
        task: kind === 'input' ? 'Startwerte und Eingabeschema' : 'Daten des auslösenden Ereignisses',
        sourceKind: kind,
        location: 'Datenquelle',
        input: 'Auslöser oder manueller Start',
        output: 'Benannte Datenfelder',
        failure: 'Laufzeitprüfung',
        ...workflowPorts(definition, catalog, id),
      },
    })
  }
  for (const trigger of triggers) {
    const id = `@trigger:${trigger.id}`
    nodes.push({
      id,
      type: 'workflow',
      draggable: false,
      position: { x: 0, y: 0 },
      data: {
        key: id,
        title: trigger.name,
        task: trigger.kind,
        sourceKind: 'trigger',
        location: trigger.enabled ? 'Auslöser · Aktiv' : 'Auslöser · Pausiert',
        input: 'Bestehende Triggerverwaltung',
        output: Object.keys(trigger.input ?? {}).join(', ') || 'Startsignal',
        failure: 'Auslöserprotokoll',
        inputs: [],
        outputs: [],
      },
    })
    for (const target of [WORKFLOW_INPUT_NODE, WORKFLOW_EVENT_NODE])
      if (usedSources.has(target))
        edges.push({
          id: `trigger:${trigger.id}:${target}`,
          source: id,
          target,
          sourceHandle: 'trigger',
          targetHandle: 'trigger',
          label: target === WORKFLOW_INPUT_NODE ? 'Startwerte' : 'Ereignis',
          class: 'wf-edge--trigger',
          style: { stroke: trigger.enabled ? '#8cbeb5' : '#858896', strokeDasharray: '3 4' },
        })
  }
  for (const step of definition.steps) {
    for (const source of step.depends_on ?? [])
      if (keys.has(source))
        edges.push({
          id: `dependency:${source}:${step.key}`,
          source,
          target: step.key,
          sourceHandle: 'out',
          targetHandle: 'in',
          label: 'Ablauf',
          class: 'wf-edge--dependency',
        })
    for (const { target: field, reference } of workflowStepBindings(step)) {
      const source = workflowBindingSource(definition, reference)
      if (source) {
        let verification = 'Laufzeitprüfung'
        let invalid = false
        try {
          if (
            inspectWorkflowBinding(definition, catalog, step.key, field, reference).verification === 'types_compatible'
          )
            verification = 'Typen passend'
        } catch {
          verification = 'Verbindung prüfen'
          invalid = true
        }
        edges.push({
          id: `data:${source.id}:${step.key}:${field}`,
          source: source.id,
          target: step.key,
          sourceHandle: `data:${source.path}`,
          targetHandle: `data:${field}`,
          label: `${source.path} → ${field} · ${verification}`,
          class: 'wf-edge--data',
          style: { stroke: invalid ? '#d68e8e' : '#ac95ea', strokeDasharray: '5 4' },
        })
      }
    }
    for (const [outcome, route] of Object.entries(step.routes ?? {}))
      if (route.type === 'step' && route.step_key && keys.has(route.step_key))
        edges.push({
          id: `route:${step.key}:${outcome}`,
          source: step.key,
          target: route.step_key,
          sourceHandle: 'out',
          targetHandle: 'in',
          label: outcome === 'failed' ? 'Bei Fehler' : outcome,
          class: 'wf-edge--outcome',
          style: { stroke: outcome === 'failed' ? '#d68e8e' : '#8cbeb5' },
        })
  }
  const sizedNodes = nodes.map(node => ({
    ...node,
    data: { ...node.data, layout: workflowNodeSize(node.data.inputs.length, node.data.outputs.length) },
  }))
  positionWorkflowNodes(sizedNodes, positions)
  return { nodes: sizedNodes, edges }
}
