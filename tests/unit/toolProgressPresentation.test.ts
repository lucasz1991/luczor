import { describe, expect, it } from 'vitest'
import { presentLocalToolResult } from '@/services/toolProgressPresentation'
import type { PendingToolCall } from '@/state/types'
const call: PendingToolCall = {
  id: 't',
  name: 'file_read',
  projectId: 'p',
  args: {},
  status: 'executed',
  createdAt: 0,
  updatedAt: 1,
  requiresApproval: false,
  result: {
    toolCallId: 't',
    name: 'file_read',
    ok: true,
    ts: 1,
    output: { result: 'Datei gelesen', api_key: 'private-test-key' },
  },
}
describe('local intermediate tool results', () => {
  it('shows a bounded actual result while masking credentials', () => {
    const detail = presentLocalToolResult(call).detail
    expect(detail).toContain('Datei gelesen')
    expect(detail).not.toContain('private-test-key')
    expect(
      presentLocalToolResult({ ...call, result: { ...call.result!, output: 'x'.repeat(3000) } }).detail!.length
    ).toBeLessThan(1700)
  })
  it('keeps proposals free of premature results and marks ephemeral previews', () => {
    expect(presentLocalToolResult({ ...call, status: 'executing' }).detail).toBeUndefined()
    expect(presentLocalToolResult({ ...call, dataHandling: 'ephemeral' }).detail).toContain('Temporäres lokales')
  })
})
