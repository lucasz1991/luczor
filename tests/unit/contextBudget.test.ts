import { describe, expect, it } from 'vitest'
import { compactToolOutput, contextBreakdown, fitRequestContext } from '@/services/inference/contextBudget'
import { focusedTools } from '@/services/inference/focusedTools'
import type { WireMessage } from '@/services/inference/types'

describe('shared request budget and evidence retention', () => {
  it('uses the available model window instead of a fixed ten-thousand-token history ceiling', () => {
    const history: WireMessage[] = [{ role: 'system', content: 'Retain the conversation requirements.' }]
    for (let index = 0; index < 12; index++)
      history.push(
        { role: 'user', content: `Requirement ${index}: ` + 'detail '.repeat(350) },
        { role: 'assistant', content: 'Established answer '.repeat(120) }
      )
    history.push({ role: 'user', content: 'Apply the previously agreed requirements.' })
    const result = fitRequestContext(history, [], { contextTokens: 131072, retrievalAvailable: true })
    expect(result.report.estimatedInputTokens).toBeGreaterThan(10000)
    expect(result.report.targetTokens).toBe(Math.floor(131072 * 0.65))
    expect(result.report.summarizedMessages).toBe(0)
    expect(result.messages).toEqual(history)
  })

  it('archives the fewest oldest complete rounds needed instead of dropping all but two', () => {
    const history: WireMessage[] = [{ role: 'system', content: 'Mandatory policy.' }]
    for (let index = 0; index < 10; index++)
      history.push(
        { role: 'user', content: `Requirement ${index}\n` + 'detail\n'.repeat(210) },
        { role: 'assistant', content: `Answer ${index}\n` + 'result\n'.repeat(210) }
      )
    history.push({ role: 'user', content: 'Continue with the agreed requirements.' })
    const original = structuredClone(history)
    const result = fitRequestContext(history, [], { targetTokens: 9000, retrievalAvailable: true })
    expect(result.report.estimatedInputTokens).toBeLessThanOrEqual(9000)
    expect(result.report.summarizedMessages).toBeGreaterThan(0)
    expect(result.report.summarizedMessages).toBeLessThanOrEqual(6)
    expect(result.report.summarizedMessages % 2).toBe(0)
    expect(result.messages).toContainEqual(history[9])
    expect(result.messages).toContainEqual(history[10])
    expect(result.messages.at(-1)).toEqual(history.at(-1))
    expect(history).toEqual(original)
  })

  it('keeps conversation requirements ahead of optional retrieved records', () => {
    const workspace = JSON.stringify({ id: 'project-workspace', content: 'E:/projekte/luczor' })
    const optional = JSON.stringify({ id: 'optional-memory', content: 'Extra context '.repeat(3000) })
    const history: WireMessage[] = [
      { role: 'system', content: `[LUCZOR-SCOPE-KONTEXT]\n${workspace}\n${optional}\n[LUCZOR-SCOPE-KONTEXT-END]` },
      { role: 'user', content: 'The report must retain exact file identities.' },
      { role: 'assistant', content: 'The report will preserve the original paths.' },
      { role: 'user', content: 'Also retain the full tool receipts.' },
      { role: 'assistant', content: 'Both requirements are included.' },
      { role: 'user', content: 'Implement those requirements now.' },
    ]
    const result = fitRequestContext(history, [], { targetTokens: 3000, retrievalAvailable: true })
    expect(result.report.summarizedMessages).toBe(0)
    expect(result.messages.slice(1)).toEqual(history.slice(1))
    expect(result.messages[0]!.content).toContain(workspace)
    expect(result.messages[0]!.content).not.toContain('optional-memory')
    expect(history[0]!.content).toContain(optional)
  })

  it('compacts complete old rounds, retains the current request and can retrieve exact originals', async () => {
    const history: WireMessage[] = [{ role: 'system', content: 'Never repeat confirmed changes.' }]
    for (let i = 0; i < 30; i++)
      history.push(
        { role: 'user', content: `Requirement ${i}: ` + 'detail '.repeat(500) },
        { role: 'assistant', content: 'Unverified response '.repeat(200) }
      )
    history.push({ role: 'user', content: 'Now verify the result.' })
    const before = JSON.stringify(history)
    const result = fitRequestContext(history, [], { targetTokens: 6000, retrievalAvailable: true })
    expect(result.report.summarizedMessages).toBeGreaterThan(0)
    expect(result.report.estimatedInputTokens).toBeLessThan(6000)
    expect(result.messages.at(-1)).toEqual(history.at(-1))
    expect(JSON.stringify(history)).toBe(before)
    expect(result.messages.some(message => message.content.includes('Assistentenaussage, ungeprüft'))).toBe(true)
    const focus = focusedTools('Verify', () => history)
    const exact = await focus.reader.execute({ index: 1 }, { projectId: 'p' })
    expect(exact).toMatchObject({ index: 1, text: history[1]!.content })
    await expect(focus.reader.execute({ index: 0 }, { projectId: 'p' })).rejects.toThrow()
  })
  it('keeps full current tool evidence and execution arguments even above the planning target', () => {
    const history: WireMessage[] = [
      { role: 'system', content: 'Policy' },
      { role: 'user', content: 'Read file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'fs_read', arguments: '{"path":"file.ts"}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'a',
        content: JSON.stringify({ ok: true, path: 'file.ts', content: 'x'.repeat(40000) }),
      },
    ]
    const result = fitRequestContext(history, [], { targetTokens: 2000 })
    expect(result.messages[2]).toEqual(history[2])
    expect(result.messages).toEqual(history)
    expect(result.report.shortenedToolResults).toBe(0)
    expect(result.report.overTarget).toBe(true)
    expect(fitRequestContext(result.messages, [], { targetTokens: 1024 }).messages).toEqual(history)
  })
  it('counts profile, knowledge and tool arguments separately and flags unavoidable overflow', () => {
    const messages: WireMessage[] = [
      {
        role: 'system',
        content: 'rule [LUCZOR-PROFILE]style[LUCZOR-PROFILE-END][LUCZOR-SCOPE-KONTEXT]data[LUCZOR-SCOPE-KONTEXT-END]',
      },
      { role: 'user', content: 'x'.repeat(40000) },
    ]
    const tools = [{ type: 'function', function: { name: 'test', parameters: { type: 'object' } } }]
    const breakdown = contextBreakdown(messages, tools)
    expect(breakdown.profile).toBeGreaterThan(0)
    expect(breakdown.knowledge).toBeGreaterThan(0)
    expect(breakdown.tools).toBeGreaterThan(0)
    const fitted = fitRequestContext(messages, tools, { contextTokens: 4096 })
    expect(fitted.report.overTarget).toBe(true)
    expect(fitted.messages[1]).toEqual(messages[1])
  })
  it('removes optional knowledge records atomically while retaining workspace authority', () => {
    const workspace = JSON.stringify({ id: 'project-workspace', content: 'unbound' })
    const extra = JSON.stringify({ id: 'low-priority', content: 'x'.repeat(9000) })
    const result = fitRequestContext(
      [
        { role: 'system', content: `[LUCZOR-SCOPE-KONTEXT]\n${workspace}\n${extra}\n[LUCZOR-SCOPE-KONTEXT-END]` },
        { role: 'user', content: 'hi' },
      ],
      [],
      { targetTokens: 1024 }
    )
    expect(result.messages[0]!.content).toContain(workspace)
    expect(result.messages[0]!.content).not.toContain('low-priority')
  })
  it('paginates tool discovery and does not lose tools beyond the first page', async () => {
    const focus = focusedTools('hi')
    const pool = Array.from({ length: 50 }, (_, i) => ({
      type: 'function' as const,
      function: { name: `tool_${i}`, description: 'test', parameters: {} },
    }))
    focus.select(pool)
    const page = await focus.selector.execute({ offset: 32 }, { projectId: 'p' })
    expect(page).toMatchObject({
      total: 51,
      nextOffset: 48,
      available: expect.arrayContaining([expect.objectContaining({ name: 'tool_47' })]),
    })
    await focus.selector.execute({ names: ['tool_49'] }, { projectId: 'p' })
    expect(focus.select(pool).some(tool => tool.function.name === 'tool_49')).toBe(true)
  })
  it('bounds escaped JSON and does not mutate hostile object keys or input', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"id":"test","text":"' + '\\"'.repeat(10000) + '"}')
    const compacted = compactToolOutput(value, 900)
    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(900)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(value.text.length).toBe(10000)
  })

  it('retains complete long and Unicode file references under repeated compaction', () => {
    const path = 'folder/'.repeat(185) + 'Bericht_e\u0301_Ä_📁_2026-09-13.md'
    const name = 'Bericht_e\u0301_Ä_📁_2026-09-13.md'
    const source = { entries: [{ path, name, file_ref: 'file_123456789abc', content: 'large content '.repeat(3000) }] }
    const first = compactToolOutput(source, 6000)
    const second = compactToolOutput(first, 1800)
    for (const result of [first, second]) {
      const serialized = JSON.stringify(result)
      expect(serialized).toContain(JSON.stringify(path))
      expect(serialized).toContain(JSON.stringify(name))
      expect(serialized).toContain('file_123456789abc')
    }
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(1800)
    expect(source.entries[0]!.path).toBe(path)
  })

  it('omits an unrepresentable file entry instead of clipping a path or escaped JSON', () => {
    const path = 'folder/'.repeat(300) + 'report.md'
    const result = compactToolOutput({ path, name: 'report.md', content: 'x'.repeat(10000) }, 900)
    expect(result).toMatchObject({ truncated: true, projection: { omitted: true } })
    expect(JSON.stringify(result)).not.toContain('folder/')
    const escaped = compactToolOutput({ path: '\\'.repeat(700), content: 'x'.repeat(10000) }, 900)
    expect(JSON.stringify(escaped)).not.toContain('excerpt')
    expect(JSON.stringify(escaped).length).toBeLessThanOrEqual(900)
  })

  it('keeps historical structured tool excerpts valid and never slices a filename in prose', () => {
    const path = 'folder/'.repeat(150) + 'ABSCHLUSSBERICHT_2026-09-13.md'
    const history: WireMessage[] = [
      { role: 'user', content: 'Read the report' },
      { role: 'tool', name: 'fs_list', tool_call_id: 'old', content: JSON.stringify({ entries: [{ path }] }) },
      { role: 'assistant', content: `The file is ${path}` },
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'x'.repeat(15000) },
      { role: 'user', content: 'continue' },
    ]
    const result = fitRequestContext(history, [], { targetTokens: 1024, retrievalAvailable: true })
    const note = result.messages.find(message => message.content.startsWith('[LUCZOR-HISTORY-NOTES]'))!
    const records = JSON.parse(note.content.split('\n')[2]!) as { index: number; excerpt: string; truncated: boolean }[]
    const tool = records.find(record => record.index === 1)!
    expect(() => JSON.parse(tool.excerpt)).not.toThrow()
    expect(tool.excerpt).not.toContain('folder/')
    expect(records.find(record => record.index === 2)).toMatchObject({ excerpt: '', truncated: true })
    expect(history[1]!.content).toContain(path)
  })
})
