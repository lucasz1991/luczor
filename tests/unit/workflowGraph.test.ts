import { describe, expect, it } from 'vitest'
import { connectWorkflowSteps, moveWorkflowNode, workflowGraph } from '@/services/workflows/graph'
import type { WorkflowDefinition } from '@/services/workflows/types'
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
})
