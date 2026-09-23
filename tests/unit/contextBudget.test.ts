import { describe, expect, it } from 'vitest'
import { compactToolOutput, contextBreakdown, fitRequestContext } from '@/services/inference/contextBudget'
import { focusedTools } from '@/services/inference/focusedTools'
import type { WireMessage } from '@/services/inference/types'

describe('shared request budget and evidence retention', () => {
  it('retains the latest usable tool batches when mandatory context alone exceeds the soft budget', () => {
    const history: WireMessage[] = [
      { role: 'system', content: 'Mandatory instructions. '.repeat(800) },
      { role: 'user', content: 'Inspect the project and continue.' },
    ]
    for (let index = 0; index < 12; index++) {
      history.push(
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: `list-${index}`, type: 'function', function: { name: 'fs_list', arguments: '{"path":"."}' } },
          ],
        },
        {
          role: 'tool',
          name: 'fs_list',
          tool_call_id: `list-${index}`,
          content: JSON.stringify({
            ok: true,
            output: {
              path: '',
              truncated: false,
              entries: Array.from({ length: 40 }, (_, file) => ({
                path: `src/Bericht_Ä_${file}.ts`,
                name: `Bericht_Ä_${file}.ts`,
                file_ref: `file_exact_${file}`,
                kind: 'file',
                size_bytes: 100,
              })),
            },
          }),
        }
      )
    }
    const original = structuredClone(history)
    const result = fitRequestContext(history, [{ schema: 'required '.repeat(800) }], {
      contextTokens: 8192,
      retrievalAvailable: true,
      compactCurrentTurn: true,
    })
    expect(result.report.overTarget).toBe(true)
    const receipts = result.messages.filter(message => message.role === 'tool')
    expect(receipts.map(message => message.tool_call_id)).toEqual(['list-10', 'list-11'])
    for (const receipt of receipts) {
      expect(receipt.content).toContain('file_exact_0')
      expect(receipt.content).toContain('src/Bericht_Ä_0.ts')
      expect(
        result.messages.some(
          message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === receipt.tool_call_id)
        )
      ).toBe(true)
    }
    expect(history).toEqual(original)
  })

  it('preserves atomic file identities in nested, compacted model receipts', () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      path: `src/e\u0301-${index}.ts`,
      name: `e\u0301-${index}.ts`,
      file_ref: `file_${index}`,
      kind: 'file',
      extra: 'metadata'.repeat(80),
    }))
    const result = compactToolOutput({ ok: true, output: { path: '', entries, truncated: false } }, 1000) as {
      output: { entries: typeof entries; omittedEntries: number }
    }
    expect(result.output.entries.length).toBeGreaterThan(0)
    expect(result.output.entries[0]).toMatchObject({ path: 'src/e\u0301-0.ts', file_ref: 'file_0' })
    expect(result.output.omittedEntries).toBe(30 - result.output.entries.length)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1000)
  })

  it('archives even a huge completed tool-call pair atomically without clipping arguments', async () => {
    const call = {
      id: 'large-write',
      type: 'function' as const,
      function: { name: 'fs_write', arguments: JSON.stringify({ path: 'exact.ts', content: 'x'.repeat(30000) }) },
    }
    const history: WireMessage[] = [
      { role: 'user', content: 'Write and verify.' },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: '{"ok":true,"revision":"exact-revision"}' },
    ]
    const result = fitRequestContext(history, [], {
      targetTokens: 2000,
      retrievalAvailable: true,
      compactCurrentTurn: true,
    })
    expect(result.report.overTarget).toBe(false)
    expect(result.report.summarizedMessages).toBe(2)
    expect(result.messages.some(message => message.role === 'tool')).toBe(false)
    expect(JSON.stringify(result.messages)).toContain('exact-revision')
    expect(history[1]).toEqual({ role: 'assistant', content: '', tool_calls: [call] })
    const reader = focusedTools('read', () => history).reader
    const page = (await reader.execute({ index: 1 }, { projectId: 'p' })) as { text: string; nextOffset: number }
    expect(page.text).toContain('large-write')
    expect(page.nextOffset).toBe(4000)
  })
  it('compacts a long single user task without losing the archive or splitting tool batches', async () => {
    const history: WireMessage[] = [
      { role: 'system', content: 'Mandatory policy.' },
      { role: 'user', content: 'Implement everything. Never delete original.ts.' },
    ]
    for (let index = 0; index < 30; index++) {
      history.push(
        {
          role: 'assistant',
          content: `Progress ${index}`,
          tool_calls: [
            {
              id: `call-${index}`,
              type: 'function',
              function: { name: 'fs_read', arguments: JSON.stringify({ path: `src/Ä-${index}.ts` }) },
            },
          ],
        },
        {
          role: 'tool',
          name: 'fs_read',
          tool_call_id: `call-${index}`,
          content: JSON.stringify({ ok: true, path: `src/Ä-${index}.ts`, content: 'Exact evidence\n'.repeat(300) }),
        }
      )
    }
    const original = structuredClone(history)
    const result = fitRequestContext(history, [], {
      targetTokens: 6000,
      retrievalAvailable: true,
      compactCurrentTurn: true,
    })
    expect(result.report.overTarget).toBe(false)
    expect(result.report.summarizedMessages).toBeGreaterThan(0)
    expect(result.messages).toContainEqual(history[1])
    for (const message of result.messages) {
      if (message.role !== 'tool') continue
      expect(
        result.messages.some(
          parent => parent.role === 'assistant' && parent.tool_calls?.some(call => call.id === message.tool_call_id)
        )
      ).toBe(true)
    }
    expect(history).toEqual(original)
    const reader = focusedTools('read', () => history).reader
    const retained = await reader.execute({ index: 3, limit: 8000 }, { projectId: 'p' })
    expect(retained).toMatchObject({ text: history[3]!.content, nextOffset: null })
  })

  it('projects a single oversized tool result only with an available exact reader', () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'Read the exact source.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'huge', type: 'function', function: { name: 'fs_read', arguments: '{"path":"exact.ts"}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'huge',
        content: JSON.stringify({ ok: true, path: 'exact.ts', content: 'x'.repeat(60000) }),
      },
    ]
    const result = fitRequestContext(history, [], {
      targetTokens: 2000,
      retrievalAvailable: true,
      compactCurrentTurn: true,
    })
    expect(result.report.overTarget).toBe(false)
    expect(result.report.shortenedToolResults).toBe(1)
    expect(result.messages[1]).toEqual(history[1])
    expect(JSON.parse(result.messages[2]!.content)).toMatchObject({
      contextCompacted: true,
      original: { tool: 'context_read_history', index: 2, offset: 0 },
    })
    expect(history[2]!.content).toContain('x'.repeat(60000))
    expect(fitRequestContext(history, [], { targetTokens: 2000, compactCurrentTurn: true }).messages).toEqual(history)
  })

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
