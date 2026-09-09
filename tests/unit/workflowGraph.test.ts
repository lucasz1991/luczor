import { describe, expect, it } from 'vitest'
import { connectWorkflowData, connectWorkflowSteps, moveWorkflowNode, workflowGraph } from '@/services/workflows/graph'
import { inspectWorkflowBinding, WORKFLOW_INPUT_NODE } from '@/services/workflows/bindings'
import type { WorkflowDefinition, WorkflowTask, WorkflowTrigger } from '@/services/workflows/types'
const tasks = (items: Array<Partial<WorkflowTask> & { key: string }>): WorkflowTask[] =>
  items.map(item => ({
    label: item.key,
    kind: 'task',
    runner: 'client',
    mutating: false,
    requires_approval: false,
    allowed_in_definition: true,
    params: {},
    ...item,
  }))
const definition = (): WorkflowDefinition => ({
  steps: [
    { key: 'read', type: 'file.read', payload: { path: 'fixture.txt' } },
    {
      key: 'analyse',
      type: 'llm',
      depends_on: ['read'],
      payload: { input_bindings: { input: 'steps.read.content' } },
      routes: { failed: { type: 'fail' } },
    },
  ],
})
describe('one workflow definition, independent graph presentation', () => {
  it('moves a node without changing executable payload, ordering, dependencies or routes', () => {
    const original = definition()
    const result = moveWorkflowNode(original, 'analyse', { x: 512.7, y: -18.2 })
    expect(result.steps).toEqual(original.steps)
    expect(original.meta).toBeUndefined()
    expect(result.meta?.node_positions).toEqual({ analyse: { x: 513, y: -18 } })
    expect(workflowGraph(result).nodes[1]?.position).toEqual({ x: 513, y: -18 })
  })
  it('distinguishes data transfer from execution and rejects cycle-producing connections', () => {
    const original = definition()
    expect(workflowGraph(original).edges.map(edge => edge.class)).toEqual(['wf-edge--dependency', 'wf-edge--data'])
    expect(() => connectWorkflowSteps(original, 'analyse', 'read')).toThrow('Kreis')
    expect(() => connectWorkflowSteps(original, 'read', 'missing')).toThrow()
    expect(connectWorkflowSteps(original, 'read', 'analyse').steps[1]?.depends_on).toEqual(['read'])
    expect(() => moveWorkflowNode(original, 'read', { x: Infinity, y: 0 })).toThrow()
  })
  it('shows fixed trigger inputs and independent event data without exposing values or trigger credentials', () => {
    const input = definition()
    input.input_schema = { type: 'object', properties: { text: { type: 'string' } } }
    input.steps[1]!.payload.input_bindings = { instruction: 'input.text', input: 'event.payload' }
    const trigger: WorkflowTrigger = {
      id: 7,
      public_id: 'public',
      name: 'Test-Auslöser',
      kind: 'webhook',
      enabled: false,
      config: { secret: 'private-config' },
      webhook_secret: 'private-secret',
      input: { text: 'private-input' },
    }
    const graph = workflowGraph(input, [], [trigger])
    expect(graph.nodes.map(node => node.id)).toEqual(['read', 'analyse', '@input', '@event', '@trigger:7'])
    expect(
      graph.edges.filter(edge => edge.class === 'wf-edge--trigger').map(edge => [edge.source, edge.target])
    ).toEqual([
      ['@trigger:7', '@input'],
      ['@trigger:7', '@event'],
    ])
    expect(graph.edges.filter(edge => edge.class === 'wf-edge--data').map(edge => edge.source)).toEqual([
      '@input',
      '@event',
    ])
    expect(JSON.stringify(graph)).not.toContain('private-')
    expect(graph.nodes.at(-1)?.data.location).toContain('Pausiert')
    expect(input.steps[1]!.payload.input_bindings).toEqual({ instruction: 'input.text', input: 'event.payload' })
  })
  it('resolves dotted step keys by longest match and renders nested $ref bindings', () => {
    const input: WorkflowDefinition = {
      steps: [
        { key: 'source', type: 'file.read', payload: {} },
        { key: 'source.data', type: 'file.read', payload: {} },
        { key: 'next', type: 'llm', payload: { input: { text: { $ref: 'steps.source.data.content' } } } },
      ],
    }
    const edge = workflowGraph(input).edges[0]
    expect(edge).toMatchObject({
      source: 'source.data',
      target: 'next',
      sourceHandle: 'data:content',
      targetHandle: 'data:input.text',
    })
    expect(edge?.label).toContain('Laufzeitprüfung')
  })
  it('binds compatible typed data and adds a dependency without changing unrelated configuration', () => {
    const original = definition()
    const catalog = tasks([
      { key: 'file.read', output_schema: { type: 'object', properties: { content: { type: 'string' } } } },
      { key: 'llm', input_schema: { type: 'object', properties: { instruction: { type: 'string' } } } },
    ])
    const bound = connectWorkflowData(original, catalog, 'read', 'content', 'analyse', 'instruction')
    expect(bound.steps[1]!.payload.input_bindings).toEqual({
      input: 'steps.read.content',
      instruction: 'steps.read.content',
    })
    expect(bound.steps[1]!.depends_on).toEqual(['read'])
    expect(original.steps[1]!.payload.input_bindings).toEqual({ input: 'steps.read.content' })
    expect(inspectWorkflowBinding(bound, catalog, 'analyse', 'instruction', 'steps.read.content').verification).toBe(
      'types_compatible'
    )
  })
  it('rejects incompatible data types, identity changes, nonexistent closed fields and dependency cycles', () => {
    const original = definition()
    original.input_schema = { type: 'object', additionalProperties: false, properties: { amount: { type: 'number' } } }
    const catalog = tasks([{ key: 'llm', input_schema: { properties: { instruction: { type: 'string' } } } }])
    expect(() =>
      connectWorkflowData(original, catalog, WORKFLOW_INPUT_NODE, 'amount', 'analyse', 'instruction')
    ).toThrow('Datentypen')
    expect(() =>
      connectWorkflowData(original, catalog, WORKFLOW_INPUT_NODE, 'missing', 'analyse', 'instruction')
    ).toThrow('Schema')
    for (const field of ['project_id', 'device_id', 'body.steps', '__proto__.x', 'constructor.x']) {
      expect(() => connectWorkflowData(original, [], 'read', 'content', 'analyse', field)).toThrow()
    }
    expect(() => connectWorkflowData(original, [], 'analyse', 'text', 'read', 'content')).toThrow('Kreis')
  })
  it('treats compatible integer to number as known but never claims an unknown schema is verified', () => {
    const original = definition()
    original.input_schema = { properties: { count: { type: 'integer' }, untyped: {} } }
    const catalog = tasks([{ key: 'llm', input_schema: { properties: { value: { type: 'number' } } } }])
    expect(inspectWorkflowBinding(original, catalog, 'analyse', 'value', 'input.count').verification).toBe(
      'types_compatible'
    )
    expect(inspectWorkflowBinding(original, catalog, 'analyse', 'value', 'input.untyped').verification).toBe(
      'runtime_required'
    )
    expect(connectWorkflowData(original, catalog, '@input', 'count', 'analyse', 'value').steps[1]!.depends_on).toEqual([
      'read',
    ])
  })
})
