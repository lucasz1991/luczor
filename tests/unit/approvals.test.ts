import { describe, expect, it } from 'vitest'
import { awaitApproval, hasPendingApproval, rejectAllApprovals, resolveApproval } from '@/services/approvals'

describe('approval wait cancellation', () => {
  it('settles and removes a pending resolver when its execution signal aborts', async () => {
    const abort = new AbortController()
    const result = awaitApproval('tool-abort', abort.signal)
    expect(hasPendingApproval('tool-abort')).toBe(true)

    abort.abort()

    await expect(result).resolves.toBe(false)
    expect(hasPendingApproval('tool-abort')).toBe(false)
  })

  it('rejects a stale waiter before installing another waiter with the same id', async () => {
    const first = awaitApproval('tool-reused')
    const second = awaitApproval('tool-reused')
    await expect(first).resolves.toBe(false)

    resolveApproval('tool-reused', true)

    await expect(second).resolves.toBe(true)
    expect(hasPendingApproval('tool-reused')).toBe(false)
    rejectAllApprovals()
  })
})
