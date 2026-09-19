import { describe, it, expect } from 'vitest'
import { focusedTools, cleanLocalHistory } from '@/services/inference/focusedTools'
import type { WireMessage } from '@/services/inference/types'
import { holdRuntimeStatusPrefix, isRuntimeStatusEcho } from '@/services/inference/localResponseGuard'
import { isTextToolOutput, textToolNames } from '@/services/inference/textToolGuard'

const pool = [
  'project_get_state',
  'workspace_get',
  'fs_list',
  'fs_read',
  'fs_search',
  'fs_write',
  'workflow_get',
  'goal_report',
  'agent_assist_status',
  'os_environment',
  'browser_status',
  'browser_open',
  'browser_dom_read',
].map(name => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object' } } }))
describe('focused local tool context', () => {
  it('finds exact archive indices without exposing system instructions or guessing offsets', async () => {
    const archive: WireMessage[] = [
      { role: 'system', content: 'Needle private policy' },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: 'user' as const,
        content: `Needle /exact/file-${index}.txt`,
      })),
    ]
    const focus = focusedTools('history', () => archive)
    const first = await focus.reader.execute({ query: 'needle' }, { projectId: 'p' })
    expect(first).toMatchObject({
      matches: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, role: 'user' })),
      nextOffset: 9,
    })
    expect(JSON.stringify(first)).not.toContain('private policy')
    expect(JSON.stringify(first)).not.toContain('/exact/')
    expect(await focus.reader.execute({ query: 'needle', offset: 9 }, { projectId: 'p' })).toMatchObject({
      matches: [{ index: 9 }, { index: 10 }],
      nextOffset: null,
    })
    expect(await focus.reader.execute({ index: 10 }, { projectId: 'p' })).toMatchObject({
      text: 'Needle /exact/file-9.txt',
    })
    await expect(focus.reader.execute({ index: 0 }, { projectId: 'p' })).rejects.toThrow('gültige Indizes')
    await expect(focus.reader.execute({ index: 1, query: 'needle' }, { projectId: 'p' })).rejects.toThrow('wählen')
    await expect(focus.reader.execute({ offset: -1 }, { projectId: 'p' })).rejects.toThrow('Archivsuche')
  })
  it('returns whole archived JSON and paginates prose only at complete line boundaries', async () => {
    const path = '/projekte/' + 'nested/'.repeat(700) + 'e\u0301📁.ts'
    const json = JSON.stringify({ path, output: 'x'.repeat(9000) })
    const prose = `first line\n${path}\nlast line`
    const focus = focusedTools('read', () => [
      { role: 'tool', tool_call_id: 'a', content: json },
      { role: 'assistant', content: prose },
    ])
    const structured = await focus.reader.execute({ index: 0 }, { projectId: 'p' })
    expect(structured).toMatchObject({ text: json, nextOffset: null })
    const first = (await focus.reader.execute({ index: 1 }, { projectId: 'p' })) as { text: string; nextOffset: number }
    expect(first.text).toBe(`first line\n${path}\n`)
    const second = (await focus.reader.execute({ index: 1, offset: first.nextOffset }, { projectId: 'p' })) as {
      text: string
    }
    expect(first.text + second.text).toBe(prose)
    await expect(focus.reader.execute({ index: 0, offset: 4000 }, { projectId: 'p' })).rejects.toThrow('nextOffset')
    await expect(focus.reader.execute({ index: 1, offset: 4000 }, { projectId: 'p' })).rejects.toThrow('nextOffset')
  })
  it.each([
    'Die nächste Modellrunde wurde unterbrochen: Tokenzählung und Kontextprüfung · HTTP 200: erfolgreich. Tokenbudget: Eingabe (gezählt) 28.000 · Kontext 43.000 · Ausgabelimit 7.000.',
    'Die lokale Modellrunde 2 wurde vor dem Abschluss unterbrochen: HTTP 400\nDer bisherige Arbeitsfortschritt bleibt erhalten (1 Tool-Aufruf erfolgreich).',
    'Der Auftrag wurde in einen bereinigten Fortsetzungsstatus überführt.',
    'Die lokale Modellrunde 1 wurde vor dem Abschluss Untergrenze erreicht: Tokenzählung und Kontextprüfung · HTTP 503: Nicht ausreichend Ressourcen. Der Tokenbudgetstand ist: Eingabe (gezählt) 25.750 · Kontext 40.000 · Ausgabe 6.000.',
    'Der Auftrag wurde in einen bereinigten Fortsetzungsrunde überführt.',
  ])('removes a status-shaped assistant echo from requests, but never user or tool evidence: %s', content => {
    const receipt: WireMessage = {
      role: 'assistant',
      content,
      tool_calls: [{ id: 'receipt', type: 'function', function: { name: 'project_get_state', arguments: '{}' } }],
    }
    const input: WireMessage[] = [
      { role: 'assistant', content },
      { role: 'user', content },
      { role: 'tool', content, tool_call_id: 'receipt' },
      receipt,
    ]
    expect(isRuntimeStatusEcho(content)).toBe(true)
    expect(cleanLocalHistory(input)).toEqual(input.slice(1))
    expect(input).toHaveLength(4)
    for (let end = 1; end <= content.length; end++) expect(holdRuntimeStatusPrefix(content.slice(0, end))).toBe(true)
  })
  it('keeps quoted status explanations and releases normal sentence prefixes', () => {
    expect(isRuntimeStatusEcho('Die nächste Modellrunde verwendet den vorhandenen Kontext.')).toBe(false)
    expect(isRuntimeStatusEcho('> Die nächste Modellrunde wurde unterbrochen: HTTP 200')).toBe(false)
    expect(isRuntimeStatusEcho('Die Meldung bedeutet nicht, dass der Auftrag erfolgreich war.')).toBe(false)
    expect(holdRuntimeStatusPrefix('Die Antwort lautet: 42.')).toBe(false)
  })
  it('recognizes paraphrased diagnostics after ordinary commentary, but not fenced or quoted examples', () => {
    const status =
      'Die lokale Modellrunde 1 wurde vor dem Abschluss Untergrenze erreicht: Tokenzählung und Kontextprüfung · HTTP 503: Nicht ausreichend Ressourcen.'
    const mixed = `Ich prüfe das.\n\n${status}`
    expect(isRuntimeStatusEcho(mixed)).toBe(true)
    expect(holdRuntimeStatusPrefix(mixed)).toBe(true)
    expect(isRuntimeStatusEcho(`Beispiel:\n\n\x60\x60\x60text\n${status}\n\nFortsetzung\n\x60\x60\x60`)).toBe(false)
    expect(isRuntimeStatusEcho(`Das ist ein Zitat:\n\n> ${status}`)).toBe(false)
    expect(
      isRuntimeStatusEcho('Die lokale Modellrunde verarbeitet den vorhandenen Kontext und gibt eine Antwort aus.')
    ).toBe(false)
    const messages: WireMessage[] = [
      { role: 'user', content: 'so jetzt aber' },
      { role: 'assistant', content: mixed },
    ]
    expect(cleanLocalHistory(messages)).toEqual([messages[0]])
  })
  it('recognizes XML function-call wrappers without converting arguments into actions', () => {
    const xml =
      '<output>\n<function-call>\n<name>project_get_state</name>\n<arguments>{"include_goals":true}</arguments>\n</function-call>\n</output>'
    expect(isTextToolOutput(xml)).toBe(true)
    expect(textToolNames(xml, ['project_get_state'])).toEqual(['project_get_state'])
    expect(textToolNames(xml, [])).toEqual([])
    expect(isTextToolOutput('Ich prüfe den Zustand mit project_get_state.')).toBe(false)
  })
  it('cleans unsolicited historical protocol text but preserves requested examples and quotations', () => {
    const xml = '<output><function-call><name>project_get_state</name></function-call></output>'
    const status = 'Die nächste Modellrunde wurde unterbrochen: HTTP 200'
    const unsolicited: WireMessage[] = [
      { role: 'user', content: '???' },
      { role: 'assistant', content: xml },
    ]
    expect(cleanLocalHistory(unsolicited)).toEqual([unsolicited[0]])
    const requested: WireMessage[] = [
      { role: 'user', content: 'Erkläre das XML-Beispiel' },
      { role: 'assistant', content: xml },
      { role: 'user', content: `Zitiere wörtlich: ${status}` },
      { role: 'assistant', content: status },
    ]
    expect(cleanLocalHistory(requested)).toEqual(requested)
  })
  it('bounds definitions and allows later selection only from the permitted pool', async () => {
    const focus = focusedTools('Repo und Dateien prüfen')
    expect(focus.select(pool).length).toBeLessThanOrEqual(10)
    expect(focus.select(pool).map(tool => tool.function.name)).toContain('fs_read')
    await focus.selector.execute({ names: ['workflow_get', 'fs_write'] }, { projectId: 'test' })
    expect(focus.select(pool).map(tool => tool.function.name)).toEqual(
      expect.arrayContaining(['workflow_get', 'fs_write', 'goal_report'])
    )
    await expect(focus.selector.execute({ names: ['forbidden'] }, { projectId: 'test' })).rejects.toThrow()
    expect(
      focus.select(pool.filter(tool => tool.function.name !== 'fs_write')).map(tool => tool.function.name)
    ).not.toContain('fs_write')
    expect(focus.select([])).toEqual([])
  })
  it('exposes discovery without silently executing anything', async () => {
    const focus = focusedTools('hi')
    focus.select(pool)
    const catalog = await focus.selector.execute({}, { projectId: 'test' })
    expect(catalog).toMatchObject({
      selected: [],
      available: [...pool.map(tool => ({ name: tool.function.name })), { name: 'tools_select' }],
    })
  })
  it('accepts and discovers an already advertised history reader without duplicate schemas', async () => {
    const focus = focusedTools('history', () => [{ role: 'user', content: 'Original request' }])
    focus.select(pool)
    const page = await focus.selector.execute({ query: 'context_read_history' }, { projectId: 'test' })
    expect(page).toMatchObject({
      available: expect.arrayContaining([
        {
          name: 'context_read_history',
          description: expect.any(String),
          category: expect.any(String),
          path: expect.any(String),
        },
      ]),
    })
    await expect(
      focus.selector.execute({ names: ['context_read_history', 'tools_select'] }, { projectId: 'test' })
    ).resolves.toMatchObject({ selected: ['context_read_history', 'tools_select'] })
    const schemas = focus.select(pool).map(tool => tool.function.name)
    expect(schemas.filter(name => name === 'context_read_history')).toHaveLength(1)
    expect(schemas.filter(name => name === 'tools_select')).toHaveLength(1)
    expect(schemas.length).toBeLessThanOrEqual(10)
    const noArchive = focusedTools('history')
    noArchive.select(pool)
    await expect(
      noArchive.selector.execute({ names: ['context_read_history'] }, { projectId: 'test' })
    ).rejects.toThrow('Unavailable names')
  })
  it('removes exact historical UI failures but preserves tool evidence and user examples', () => {
    const failure =
      'Die lokale Modellrunde 1 wurde vor dem Abschluss unterbrochen: HTTP 400\nDer Auftrag wurde in einen bereinigten Fortsetzungsstand überführt.'
    const prefix =
      'Prüfe zuerst ausschließlich lesend den aktuellen Zustand des unterbrochenen Auftrags. Wiederhole keine Schreibaktionen. Berichte, was bereits nachweisbar erledigt ist und was noch fehlt.\n\nUrsprünglicher Auftrag:\n'
    const messages: WireMessage[] = [
      { role: 'assistant', content: failure },
      { role: 'user', content: failure },
      { role: 'tool', tool_call_id: 'a', content: 'Saved' },
      { role: 'user', content: prefix + prefix + 'test' },
    ]
    const cleaned = cleanLocalHistory(messages)
    expect(cleaned).toHaveLength(3)
    expect(cleaned[0]?.content).toBe(failure)
    expect(cleaned[1]?.content).toBe('Saved')
    expect(cleaned[2]?.content).toBe(prefix + 'test')
    expect(messages).toHaveLength(4)
  })
})
