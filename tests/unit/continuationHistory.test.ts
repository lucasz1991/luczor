import { describe, expect, it } from 'vitest'
import {
  refreshContinuationContext,
  resumeCheckpointMessages,
  unresolvedCheckpointCalls,
} from '@/services/agents/continuationHistory'
import type { WireMessage } from '@/services/inference/types'

describe('complete checkpoint history', () => {
  it('matches only whole framing lines even when JSON evidence contains marker text, and permits explicit clearing', () => {
    const record = JSON.stringify({
      content: 'embedded [LUCZOR-SCOPE-KONTEXT-END] marker\n[LUCZOR-SCOPE-KONTEXT]\ninside JSON',
    })
    const old = `[LUCZOR-SCOPE-KONTEXT]\n${record}\n[LUCZOR-SCOPE-KONTEXT-END]`
    const next = `[LUCZOR-SCOPE-KONTEXT]\n${JSON.stringify({ content: 'new ' + record })}\n[LUCZOR-SCOPE-KONTEXT-END]`
    const messages: WireMessage[] = [{ role: 'system', content: `Policy\n${old}\nRule` }]
    refreshContinuationContext(messages, next)
    expect(messages[0]!.content).toBe(`Policy\n${next}\nRule`)
    refreshContinuationContext(messages, '')
    expect(messages[0]!.content).toBe('Policy\n\nRule')
  })
  it('refreshes retrieved context without replacing rules or retained instructions', () => {
    const messages: WireMessage[] = [
      {
        role: 'system',
        content: 'Policy\n[LUCZOR-SCOPE-KONTEXT]\nold repository revision\n[LUCZOR-SCOPE-KONTEXT-END]\nRule',
      },
      { role: 'user', content: 'Never remove the old file.' },
    ]
    refreshContinuationContext(
      messages,
      'Unrelated prose\n[LUCZOR-SCOPE-KONTEXT]\nnew memory and repository revision\n[LUCZOR-SCOPE-KONTEXT-END]'
    )
    expect(messages[0]!.content).toContain('Policy\n')
    expect(messages[0]!.content).toContain('\nRule')
    expect(messages[0]!.content).not.toContain('Unrelated prose')
    expect(messages[0]!.content).not.toContain('old repository revision')
    expect(messages[1]).toEqual({ role: 'user', content: 'Never remove the old file.' })
  })
  it('retains complete instructions and receipts and marks only missing replies unknown', () => {
    const source: WireMessage[] = [
      { role: 'user', content: 'Constraint\n'.repeat(1000) + 'Never delete final.ts' },
      {
        role: 'assistant',
        content: 'Public progress',
        tool_calls: [
          { id: 'done', type: 'function', function: { name: 'fs_write', arguments: '{"path":"a.ts"}' } },
          { id: 'unknown', type: 'function', function: { name: 'fs_write', arguments: '{"path":"b.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'done', content: '{"ok":true,"revision":"sha-exact"}' },
    ]
    const copy = structuredClone(source)
    const result = resumeCheckpointMessages(source)
    expect(result.slice(0, 3)).toEqual(source)
    expect(result[3]).toMatchObject({ role: 'tool', tool_call_id: 'unknown' })
    expect(JSON.parse(result[3]!.content)).toMatchObject({ ok: false, executed: 'unknown' })
    expect(unresolvedCheckpointCalls(source).map(call => call.id)).toEqual(['unknown'])
    expect(unresolvedCheckpointCalls(result).map(call => call.id)).toEqual(['unknown'])
    expect(resumeCheckpointMessages(result)).toEqual(result)
    expect(source).toEqual(copy)
  })
})
