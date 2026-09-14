import { describe, expect, it } from 'vitest'
import { toolCategoryMap, toolDiscovery, searchToolCatalog, type ToolDescriptor } from '@/services/tools/discovery'
import { focusedTools } from '@/services/inference/focusedTools'
import { topToolUsage, toolUsageContext, type ToolUsage } from '@/services/tools/usage'
import { fitRequestContext } from '@/services/inference/contextBudget'

const definition = (name: string): ToolDescriptor => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object' } },
})
const pool = [
  'browser_fill',
  'browser_dom_read',
  'os_open_url',
  'os_click',
  'fs_read',
  'memory_recall',
  'device_dispatch',
  'workflow_run_start',
  'agent_team_prepare',
].map(definition)
describe('hierarchical tool discovery', () => {
  it.each([
    ['Formular ausfüllen', 'browser_fill'],
    ['Gedächtnis', 'memory_recall'],
    ['Dateisystem auslesen', 'fs_read'],
    ['external chrome', 'os_open_url'],
    ['Tastatur', 'os_click'],
  ])('finds synonyms without relying on tool descriptions: %s', (query, name) => {
    expect(searchToolCatalog(pool, query).map(item => item.meta.name)).toContain(name)
  })
  it('keeps internal browser, external browser, desktop and remote devices separate', () => {
    expect(toolDiscovery(definition('browser_fill')).category).toBe('computer/browser/forms')
    expect(searchToolCatalog(pool, '', 'computer/browser').map(item => item.meta.name)).toEqual([
      'browser_fill',
      'browser_dom_read',
    ])
    expect(toolDiscovery(definition('os_open_url')).category).toBe('computer/external-browser/execute')
    expect(toolDiscovery(definition('device_dispatch')).category).toBe('devices/jobs/execute')
    for (const node of toolCategoryMap(pool)) {
      expect(node.keywords.length).toBeGreaterThan(0)
    }
    for (const node of toolCategoryMap(pool).filter(item => item.parent))
      expect(toolCategoryMap(pool).some(parent => parent.id === node.parent)).toBe(true)
  })
  it('offers only permitted branches and paginates exact tool records', async () => {
    const focused = focusedTools('Gedächtnis')
    focused.select(pool)
    const result = await focused.selector.execute(
      { query: 'Formular', category: 'computer/browser' },
      { projectId: 'p' }
    )
    expect(result).toMatchObject({
      available: [
        { name: 'browser_fill', path: ['Computer', 'Luczor-Browser', 'Formulare'] },
        { name: 'browser_dom_read' },
      ],
    })
    focused.select(pool.filter(tool => !tool.function.name.startsWith('browser_')))
    await expect(focused.selector.execute({ category: 'computer/browser' }, { projectId: 'p' })).rejects.toThrow()
    await expect(focused.selector.execute({ names: ['browser_fill'] }, { projectId: 'p' })).rejects.toThrow()
    const many = Array.from({ length: 30 }, (_, index) => definition(`custom_${index}`))
    focused.select(many)
    expect(await focused.selector.execute({ offset: 16 }, { projectId: 'p' })).toMatchObject({
      total: 30,
      nextOffset: null,
      available: many.slice(16).map(tool => ({ name: tool.function.name })),
    })
  })
  it('keeps top ten real counts and complete paths inside the compacted context, without loading ten schemas', () => {
    const many = Array.from({ length: 15 }, (_, index) => definition(`custom_${index}`))
    const rows: ToolUsage[] = many.map((tool, index) => ({
      name: tool.function.name,
      calls: index + 1,
      successes: index,
      failures: 1,
      durationMs: 100,
    }))
    rows.push({ name: 'forbidden', calls: 1000, successes: 1000, failures: 0, durationMs: 0 })
    const top = topToolUsage(many, rows)
    expect(top).toHaveLength(10)
    expect(top[0]?.name).toBe('custom_14')
    const map = toolUsageContext(many, rows)
    expect(map.length).toBeLessThan(3000)
    expect(map).not.toContain('forbidden')
    const fitted = fitRequestContext(
      [
        { role: 'system', content: map },
        { role: 'user', content: 'Bitte weiter' },
      ],
      [],
      { targetTokens: 1024 }
    )
    expect(fitted.messages[0]?.content).toBe(map)
    expect(fitted.report.categories.tools).toBeGreaterThan(0)
    expect(focusedTools('hi').select(many, rows)).toHaveLength(10)
    expect(toolUsageContext(many, [])).toContain('Noch keine gemessene')
    expect(toolUsageContext([], rows)).toBe('')
    expect(toolUsageContext(many, rows, false)).not.toContain('tools_select(')
  })
})
