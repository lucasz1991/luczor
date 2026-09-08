import { describe, expect, it } from 'vitest'
import { workflowReferences } from '@/services/workflows/presentation'
import { workflowStatusLabel } from '@/services/workflows/types'
import type { PendingToolCall } from '@/state/types'

function call(reference: unknown, overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return {
    id: 'call-1',
    projectId: 'project-1',
    name: 'workflow_get',
    args: {},
    requiresApproval: false,
    status: 'executed',
    createdAt: 1,
    updatedAt: 1,
    result: { toolCallId: 'call-1', name: 'workflow_get', ok: true, ts: 1, output: { workflow_ref: reference } },
    ...overrides,
  }
}

describe('workflow chat references', () => {
  it('ignores non-workflow calls and results that were not successfully executed', () => {
    const reference = { id: 7, name: 'Workflow' }
    expect(
      workflowReferences([
        call(reference, { name: 'task_list' }),
        call(reference, { status: 'proposed' }),
        call(reference, {
          result: { toolCallId: 'call-1', name: 'workflow_get', ok: false, ts: 1, output: { workflow_ref: reference } },
        }),
      ])
    ).toEqual([])
  })
  it('handles malformed optional fields from imported history without throwing or passing extra data through', () => {
    const result = workflowReferences([
      call({ id: 7, name: 'Workflow', summary: 42, runId: {}, status: [], version: '2', secret: 'private' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 7,
      name: 'Workflow',
      summary: undefined,
      runId: undefined,
      status: undefined,
      version: undefined,
    })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(workflowReferences([call('invalid'), call({ id: -1, name: 'Invalid' }), call({ id: 7, name: {} })])).toEqual(
      []
    )
  })
  it('bounds display fields, deduplicates saved workflow IDs and limits visible cards', () => {
    const valid = {
      id: 7,
      name: 'N'.repeat(200),
      summary: 'S'.repeat(1200),
      runId: 'r'.repeat(100),
      status: 's'.repeat(100),
      version: 2,
    }
    const result = workflowReferences([call({ id: 7, name: 'Old name' }), call(valid)])
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toHaveLength(160)
    expect(result[0]!.summary).toHaveLength(1000)
    expect(result[0]!.runId).toHaveLength(64)
    expect(result[0]!.status).toHaveLength(64)
    expect(result[0]!.version).toBe(2)
    expect(
      workflowReferences(Array.from({ length: 12 }, (_, index) => call({ id: index + 1, name: `Workflow ${index}` })))
    ).toHaveLength(8)
  })
  it('uses own status labels and preserves unknown inherited property names as text', () => {
    expect(workflowStatusLabel('waiting_for_device')).toBe('Wartet auf Gerät')
    expect(workflowStatusLabel('constructor')).toBe('constructor')
    expect(workflowStatusLabel('__proto__')).toBe('__proto__')
  })
})
