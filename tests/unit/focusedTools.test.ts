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
  it.each([
    'Die nächste Modellrunde wurde unterbrochen: Tokenzählung und Kontextprüfung · HTTP 200: erfolgreich. Tokenbudget: Eingabe (gezählt) 28.000 · Kontext 43.000 · Ausgabelimit 7.000.',
    'Die lokale Modellrunde 2 wurde vor dem Abschluss unterbrochen: HTTP 400\nDer bisherige Arbeitsfortschritt bleibt erhalten (1 Tool-Aufruf erfolgreich).',
    'Der Auftrag wurde in einen bereinigten Fortsetzungsstatus überführt.',
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
      available: pool.map(tool => ({ name: tool.function.name, description: tool.function.description })),
    })
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
