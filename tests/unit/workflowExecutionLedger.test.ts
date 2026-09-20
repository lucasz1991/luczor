import { describe, expect, it, vi } from 'vitest'
import { createWorkflowExecutionLedger, type WorkflowExecutionRecord } from '@/services/workflows/executionLedger'

function fixture() {
  const records = new Map<string, WorkflowExecutionRecord>()
  const storage = {
    read: vi.fn(async (key: string) => records.get(key)),
    write: vi.fn(async (key: string, value: WorkflowExecutionRecord) => {
      records.set(key, value)
    }),
  }
  return { records, storage, ledger: createWorkflowExecutionLedger(storage) }
}
describe('durable workflow execution', () => {
  it('keeps uncertain effect markers while releasing stopped locks and rejects late completion', async () => {
    const { ledger, records } = fixture()
    let finish!: (value: Record<string, unknown>) => void
    const effect = vi.fn(
      () =>
        new Promise<Record<string, unknown>>(resolve => {
          finish = resolve
        })
    )
    const old = ledger.execute('account', 'execution', {}, effect).catch(error => error)
    await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce())
    ledger.recoverAfterStop()
    await expect(ledger.execute('account', 'execution', {}, effect)).rejects.toThrow('outcome_unknown')
    await expect(ledger.execute('account', 'fresh', {}, async () => ({ ok: true }))).resolves.toEqual({ ok: true })
    finish({ ok: true, late: true })
    expect(await old).toMatchObject({ message: 'workflow_execution_stopped' })
    expect(records.get('account:execution')?.state).toBe('started')
    expect(effect).toHaveBeenCalledOnce()
  })
  it('persists before effects and reuses the exact result after a lost acknowledgment or restart', async () => {
    const { records, storage, ledger } = fixture()
    const effect = vi.fn(async () => {
      expect(records.get('account:execution')?.state).toBe('started')
      return { ok: true, text: 'Result' }
    })
    await expect(ledger.execute('account', 'execution', { code: 'one' }, effect)).resolves.toEqual({
      ok: true,
      text: 'Result',
    })
    const restarted = createWorkflowExecutionLedger(storage)
    await expect(restarted.execute('account', 'execution', { code: 'one' }, effect)).resolves.toEqual({
      ok: true,
      text: 'Result',
    })
    await restarted.acknowledge('account', 'execution')
    expect(records.get('account:execution')?.state).toBe('acknowledged')
    expect(effect).toHaveBeenCalledOnce()
  })
  it('does not repeat uncertain execution or accept a changed request with the same identity', async () => {
    const { ledger } = fixture()
    await expect(
      ledger.execute('account', 'execution', { code: 'one' }, async () => {
        throw new Error('crash')
      })
    ).rejects.toThrow('crash')
    const effect = vi.fn(async () => ({ ok: true }))
    await expect(ledger.execute('account', 'execution', { code: 'one' }, effect)).rejects.toThrow('outcome_unknown')
    await expect(ledger.execute('account', 'execution', { code: 'two' }, effect)).rejects.toThrow('payload_conflict')
    expect(effect).not.toHaveBeenCalled()
  })
  it('fails closed before effects if durable persistence fails', async () => {
    const { ledger, storage } = fixture()
    storage.write.mockRejectedValueOnce(new Error('disk full'))
    const effect = vi.fn(async () => ({ ok: true }))
    await expect(ledger.execute('account', 'execution', {}, effect)).rejects.toThrow('disk full')
    expect(effect).not.toHaveBeenCalled()
  })
  it('isolates the same execution id between accounts', async () => {
    const { ledger } = fixture()
    const effect = vi.fn(async () => ({ ok: true }))
    await ledger.execute('account-a', 'execution', {}, effect)
    await ledger.execute('account-b', 'execution', {}, effect)
    expect(effect).toHaveBeenCalledTimes(2)
  })
})
