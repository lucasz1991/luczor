import { describe, expect, it, vi } from 'vitest'
import { boundedWorkflowJson, WorkflowOperations, WorkflowOperationUncertain } from '@/services/workflows/operations'

function fixture() {
  let saved: unknown = []
  const store = {
    get: async <T>() => structuredClone(saved) as T,
    set: vi.fn(async (_key: string, value: unknown) => {
      saved = structuredClone(value)
    }),
    save: vi.fn(async () => {}),
  }
  const uuid = vi.fn(() => 'd740bf7e-7c3a-428e-bd76-3040d8119999')
  const operations = new WorkflowOperations({ open: async () => store, uuid })
  const input = {
    scope: { account: 'alice', project: 'p', path: 'create' },
    args: { name: 'Private workflow' },
    assertCurrent: vi.fn(async () => {}),
    verify: vi.fn(async (_id: string): Promise<unknown | null> => null),
    execute: vi.fn(async (_id: string): Promise<unknown> => ({ data: { id: 12 } })),
  }
  return { operations, input, store, uuid, saved: () => saved }
}
describe('workflow write recovery', () => {
  it('persists only hashes and an operation ID before any mutation', async () => {
    const testCase = fixture()
    testCase.input.execute.mockImplementation(async id => {
      expect(testCase.store.save).toHaveBeenCalledOnce()
      expect(JSON.stringify(testCase.saved())).not.toContain('Private workflow')
      expect(JSON.stringify(testCase.saved())).not.toContain('alice')
      expect(JSON.stringify(testCase.saved())).toContain(id)
      return { data: { id: 12 } }
    })
    await expect(testCase.operations.run(testCase.input)).resolves.toEqual({ data: { id: 12 } })
    expect(testCase.saved()).toEqual([])
  })
  it('recovers a committed response without sending the mutation again after a lost reply', async () => {
    const testCase = fixture()
    testCase.input.execute.mockRejectedValueOnce(new Error('connection closed'))
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    testCase.input.verify.mockResolvedValueOnce({ data: { id: 12, version: 1 } })
    await expect(testCase.operations.run(testCase.input)).resolves.toEqual({ data: { id: 12, version: 1 } })
    expect(testCase.input.execute).toHaveBeenCalledOnce()
    expect(testCase.input.verify).toHaveBeenCalledWith(testCase.uuid.mock.results[0]!.value)
  })
  it('reuses the persisted ID only after the server confirms it absent', async () => {
    const testCase = fixture()
    testCase.input.execute.mockRejectedValueOnce(new Error('offline'))
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    await testCase.operations.run(testCase.input)
    expect(testCase.input.verify).toHaveBeenCalledOnce()
    expect(testCase.input.execute.mock.calls[1]![0]).toBe(testCase.input.execute.mock.calls[0]![0])
    expect(testCase.uuid).toHaveBeenCalledOnce()
  })
  it('does not send changed arguments while an earlier outcome is unknown', async () => {
    const testCase = fixture()
    testCase.input.execute.mockRejectedValueOnce(new Error('offline'))
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    await expect(testCase.operations.run({ ...testCase.input, args: { name: 'Replacement' } })).rejects.toBeInstanceOf(
      WorkflowOperationUncertain
    )
    expect(testCase.input.execute).toHaveBeenCalledOnce()
  })
  it('requires a fresh read when recovering an older request with different arguments', async () => {
    const testCase = fixture()
    testCase.input.execute.mockRejectedValueOnce(new Error('offline'))
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    testCase.input.verify.mockResolvedValueOnce({ data: { id: 12 } })
    await expect(testCase.operations.run({ ...testCase.input, args: { name: 'Replacement' } })).rejects.toThrow(
      'aktuellen Workflow'
    )
    expect(testCase.saved()).toEqual([])
    expect(testCase.input.execute).toHaveBeenCalledOnce()
  })
  it('fails closed if verification itself fails', async () => {
    const testCase = fixture()
    testCase.input.execute.mockRejectedValueOnce(new Error('offline'))
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    testCase.input.verify.mockRejectedValueOnce(new Error('server down'))
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    expect(testCase.input.execute).toHaveBeenCalledOnce()
  })
  it('retains recovery across an execution boundary change during the response', async () => {
    const testCase = fixture()
    testCase.input.execute.mockImplementation(async () => {
      testCase.input.assertCurrent.mockRejectedValue(new Error('account changed'))
      return { data: { id: 12 } }
    })
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    expect(testCase.saved()).toHaveLength(1)
  })
  it('clears explicit validation conflicts but retains transient errors', async () => {
    const testCase = fixture()
    const conflict = Object.assign(new Error('version conflict'), { status: 409 })
    testCase.input.execute.mockRejectedValueOnce(conflict)
    await expect(testCase.operations.run(testCase.input)).rejects.toBe(conflict)
    expect(testCase.saved()).toEqual([])
    testCase.input.execute.mockRejectedValueOnce(Object.assign(new Error('rate limit'), { status: 429 }))
    await expect(testCase.operations.run(testCase.input)).rejects.toBeInstanceOf(WorkflowOperationUncertain)
    expect(testCase.saved()).toHaveLength(1)
  })
  it('does not execute when the preflight ledger cannot be durably saved', async () => {
    const testCase = fixture()
    testCase.store.save.mockRejectedValueOnce(new Error('disk full'))
    await expect(testCase.operations.run(testCase.input)).rejects.toThrow('disk full')
    expect(testCase.input.execute).not.toHaveBeenCalled()
  })
  it('rejects prototype keys and oversized, cyclic or non-JSON input', () => {
    expect(() => boundedWorkflowJson(JSON.parse('{"__proto__":{"admin":true}}'))).toThrow()
    expect(() => boundedWorkflowJson({ text: 'ü'.repeat(128000) })).toThrow('256 KB')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => boundedWorkflowJson(cycle)).toThrow()
    expect(() => boundedWorkflowJson({ value: Infinity })).toThrow()
  })
})
