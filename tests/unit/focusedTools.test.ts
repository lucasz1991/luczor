import { describe, it, expect } from 'vitest'
import { focusedTools, cleanLocalHistory } from '@/services/inference/focusedTools'
import type { WireMessage } from '@/services/inference/types'

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
  it('bounds definitions and allows later selection only from the permitted pool', async () => {
    const focus = focusedTools('Repo und Dateien prüfen')
    expect(focus.select(pool).length).toBeLessThanOrEqual(10)
    expect(focus.select(pool).map(t => t.function.name)).toContain('fs_read')
    await focus.selector.execute({ names: ['workflow_get', 'fs_write'] }, { projectId: 'test' })
    expect(focus.select(pool).map(t => t.function.name)).toEqual(
      expect.arrayContaining(['workflow_get', 'fs_write', 'goal_report'])
    )
    await expect(focus.selector.execute({ names: ['forbidden'] }, { projectId: 'test' })).rejects.toThrow()
    expect(focus.select(pool.filter(t => t.function.name !== 'fs_write')).map(t => t.function.name)).not.toContain(
      'fs_write'
    )
    expect(focus.select([])).toEqual([])
  })
  it('exposes discovery without silently executing anything', async () => {
    const focus = focusedTools('hi')
    focus.select(pool)
    const catalog = await focus.selector.execute({}, { projectId: 'test' })
    expect(catalog).toMatchObject({
      selected: [],
      available: pool.map(t => ({ name: t.function.name, description: t.function.description })),
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
