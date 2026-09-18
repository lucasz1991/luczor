import { beforeAll, describe, expect, it } from 'vitest'
import {
  toolCategoryMap,
  toolDiscovery,
  searchToolCatalog,
  normalizeToolSearch,
  type ToolDescriptor,
} from '@/services/tools/discovery'
import { focusedTools } from '@/services/inference/focusedTools'
import { topToolUsage, toolUsageContext, type ToolUsage } from '@/services/tools/usage'
import { compactToolOutput, fitRequestContext } from '@/services/inference/contextBudget'
import type { ToolCatalogPage } from '@/services/inference/toolCatalogOutput'

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

let registeredTools: ToolDescriptor[] = []
beforeAll(async () => {
  // Import/transform the real registry outside each fast search assertion.
  // The complete suite transforms many dependencies concurrently.
  registeredTools = (await import('@/services/tools/registry')).toOpenAITools()
}, 30_000)

// Opt-in benchmark only; the legacy scorer mirrors the previous implementation.
// Fixed short queries contain no stop words, keeping the comparison equivalent.
function legacySearch(tools: ToolDescriptor[], query: string) {
  const tokens = normalizeToolSearch(query).split(' ').filter(Boolean)
  return tools
    .map(tool => {
      const meta = toolDiscovery(tool)
      const words = normalizeToolSearch(
        `${meta.name} ${meta.description} ${meta.keywords.join(' ')} ${meta.path.join(' ')}`
      ).split(' ')
      const score = tokens.reduce(
        (sum, token) =>
          sum + (words.some(word => word === token || (token.length >= 4 && word.startsWith(token))) ? 1 : 0),
        0
      )
      return { tool, score }
    })
    .filter(row => row.score > 0)
    .sort((left, right) => right.score - left.score)
}

it.runIf(process.env.LUCZOR_TOOL_SEARCH_BENCHMARK === '1')(
  'benchmarks warm local search against the previous scorer',
  async () => {
    const tools = registeredTools
    const queries = [
      'Datei lesen',
      'Formular ausfuellen',
      'Erinnerungen nachschlagen',
      'browser_dom_read',
      'workflow run cancel',
      'device jobs status',
    ]
    const measure = (search: typeof legacySearch) => {
      for (const query of queries) search(tools, query)
      const times: number[] = []
      for (let index = 0; index < 120; index++) {
        const start = performance.now()
        search(tools, queries[index % queries.length]!)
        times.push(performance.now() - start)
      }
      times.sort((left, right) => left - right)
      return { p50Ms: times[60], p95Ms: times[114] }
    }
    const original = JSON.stringify(tools)
    process.stdout.write(
      `Local tool search benchmark ${JSON.stringify({
        tools: tools.length,
        samples: 120,
        legacy: measure(legacySearch),
        indexed: measure(searchToolCatalog),
      })}\n`
    )
    expect(JSON.stringify(tools)).toBe(original)
  }
)

describe('hierarchical tool discovery', () => {
  it('keeps the exact requested tool first in focused selection, not another ID substring', () => {
    const tools = ['fs_read', ...Array.from({ length: 12 }, (_, index) => `custom_${index}`), 'fs_read_extended'].map(
      definition
    )
    const selected = focusedTools('fs_read_extended').select(tools)
    expect(selected[0]?.function.name).toBe('fs_read_extended')
    expect(selected.length).toBeLessThanOrEqual(10)
    expect(focusedTools(`${'context '.repeat(400)} fs_read_extended`).select(tools)[0]?.function.name).toBe(
      'fs_read_extended'
    )
  })

  it.each([
    ['lokale Datei lesen', 'fs_read'],
    ['Datei speichern', 'fs_write'],
    ['Dateien durchsuchen', 'fs_search'],
    ['Datei loeschen', 'fs_delete'],
    ['browser form fill', 'browser_fill'],
    ['Formular ausfuellen', 'browser_fill'],
    ['Browser schliessen', 'browser_close'],
    ['Erinnerungen nachschlagen', 'memory_recall'],
    ['Erinnerung speichern', 'memory_remember'],
    ['workflow run start', 'workflow_run_start'],
    ['workflow run cancel', 'workflow_run_cancel'],
    ['device jobs status', 'device_job_status'],
  ])('retrieves the real registered capability near the top without executing it: %s', (query, expected) => {
    const tools = registeredTools
    expect(tools.some(tool => tool.function.name === expected)).toBe(true)
    expect(
      searchToolCatalog(tools, query)
        .slice(0, 3)
        .map(row => row.meta.name)
    ).toContain(expected)
  })

  it('bounds cyclic/deep schema inspection and keeps an empty catalog query in registry order', () => {
    const tool = definition('custom_lookup')
    const cyclic: Record<string, unknown> = { description: 'quartzneedle' }
    cyclic.properties = { loop: cyclic }
    tool.function.parameters = cyclic
    expect(searchToolCatalog([tool], 'quartzneedle')).toHaveLength(1)
    const tools = ['custom_z', 'custom_a'].map(definition)
    expect(searchToolCatalog(tools, 'the und bitte').map(row => row.tool)).toEqual(tools)
    expect(searchToolCatalog(tools, 'z'.repeat(10_000)).every(row => Number.isFinite(row.score))).toBe(true)
  })

  it('ranks the requested operation above shared category words regardless of pool order', () => {
    const files = ['fs_write', 'fs_search', 'fs_list', 'fs_read'].map(definition)
    expect(searchToolCatalog(files, 'Datei lesen')[0]?.meta.name).toBe('fs_read')
    expect(searchToolCatalog(files, 'read file')[0]?.meta.name).toBe('fs_read')
    expect(searchToolCatalog(files, 'Datei speichern')[0]?.meta.name).toBe('fs_write')
    expect(searchToolCatalog(files, 'Dateien durchsuchen')[0]?.meta.name).toBe('fs_search')
  })

  it('prioritizes exact IDs over descriptions mentioning another tool', () => {
    const other = definition('fs_write')
    other.function.description = 'Use fs_read before changing files. fs_read fs_read fs_read'
    expect(searchToolCatalog([other, definition('fs_read')], 'Bitte fs_read verwenden')[0]?.meta.name).toBe('fs_read')
  })

  it('searches full descriptions and nested parameter names/descriptions, but never examples or defaults', () => {
    const tool = definition('custom_lookup')
    tool.function.description = `${'General information. '.repeat(12)} Retrieves an invoice.`
    tool.function.parameters = {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          properties: { invoiceNumber: { type: 'string', description: 'Rechnungsnummer', default: 'secretdefault' } },
        },
      },
      examples: [{ options: { invoiceNumber: 'secretexample' } }],
    }
    for (const query of ['invoice', 'invoice number', 'Rechnungsnummer'])
      expect(searchToolCatalog([tool], query)[0]?.meta.name).toBe('custom_lookup')
    expect(searchToolCatalog([tool], 'secretdefault secretexample')).toEqual([])
    expect(searchToolCatalog([tool], 'invoice')[0]?.meta.description.length).toBeLessThanOrEqual(160)
  })

  it.each([
    ['Formular ausfuellen', 'browser_fill'],
    ['Browser schliessen', 'browser_close'],
    ['Datei loeschen', 'fs_delete'],
    ['Erinnerung speichern', 'memory_remember'],
    ['Erinnerungen nachschlagen', 'memory_recall'],
  ])('ranks bilingual operation aliases: %s', (query, expected) => {
    const candidates = ['fs_read', 'memory_analyze', 'browser_dom_read', 'browser_open', expected].map(definition)
    expect(searchToolCatalog(candidates, query)[0]?.meta.name).toBe(expected)
  })

  it('does not amplify repeated query words and preserves exact category filtering', () => {
    const tools = ['fs_write', 'fs_read', 'project_cloud_read'].map(definition)
    expect(searchToolCatalog(tools, 'read read read file')).toEqual(searchToolCatalog(tools, 'read file'))
    expect(searchToolCatalog(tools, 'fs_read', 'files/cloud').map(row => row.meta.name)).not.toContain('fs_read')
    expect(searchToolCatalog(tools, 'unfindablezzzz')).toEqual([])
  })

  it('refreshes changed tool descriptions and nested schemas and never returns a cached removed tool', () => {
    const tool = definition('custom_lookup')
    const field = { type: 'string', description: 'quartzneedle' }
    tool.function.parameters = { properties: { key: field } }
    expect(searchToolCatalog([tool], 'quartzneedle')).toHaveLength(1)
    field.description = 'cobaltneedle'
    expect(searchToolCatalog([tool], 'quartzneedle')).toEqual([])
    expect(searchToolCatalog([tool], 'cobaltneedle')).toHaveLength(1)
    tool.function.description = 'amberneedle'
    expect(searchToolCatalog([tool], 'amberneedle')).toHaveLength(1)
    expect(searchToolCatalog([], 'amberneedle')).toEqual([])
    expect(searchToolCatalog([definition('other_tool')], 'amberneedle')).toEqual([])
  })

  it.each([
    ['Formular ausfüllen', 'browser_fill'],
    ['Gedächtnis', 'memory_recall'],
    ['Dateisystem auslesen', 'fs_read'],
    ['external chrome', 'os_open_url'],
    ['Tastatur', 'os_click'],
  ])('finds synonyms without relying on tool descriptions: %s', (query, name) => {
    expect(searchToolCatalog(pool, query).map(item => item.meta.name)).toContain(name)
  })

  it('uses English map labels while German search terms remain valid', () => {
    const metadata = toolDiscovery(definition('memory_recall'))
    expect(metadata.path).toEqual(['Knowledge', 'Memories', 'Read and inspect'])
    expect(metadata.keywords).toEqual(expect.arrayContaining(['memory', 'erinnerung', 'lesen']))
    expect(searchToolCatalog(pool, 'Erinnerungen').map(item => item.meta.name)).toContain('memory_recall')
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
        { name: 'browser_fill', path: ['Computer', 'Luczor browser', 'Forms'] },
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
  it('retains the sole terminal hit through both compaction stages and loads its schema', async () => {
    const focus = focusedTools('Android device')
    const tools = [...pool, definition('project_terminal_run')]
    focus.select(tools)
    const output = await focus.selector.execute({ query: 'terminal shell command' }, { projectId: 'p' })
    const outcome = { ok: true, output: compactToolOutput(output, 6000) }
    const fitted = fitRequestContext(
      [
        { role: 'system', content: 'Mandatory rules. '.repeat(1000) },
        { role: 'user', content: 'Find terminal' },
        { role: 'tool', name: 'tools_select', tool_call_id: 'search', content: JSON.stringify(outcome) },
      ],
      [],
      { targetTokens: 1024 }
    )
    const received = JSON.parse(fitted.messages.find(message => message.role === 'tool')!.content)
      .output as ToolCatalogPage
    expect(received.available.map(hit => hit.name)).toContain('project_terminal_run')
    expect(received.nextOffset).toBeNull()
    expect(received.categories).toBeUndefined()
    await focus.selector.execute({ names: ['project_terminal_run'] }, { projectId: 'p' })
    expect(focus.select(tools).map(tool => tool.function.name)).toContain('project_terminal_run')
  })

  it('pages complete names without gaps and remains stable through repeated smaller projections', async () => {
    const focus = focusedTools('catalog')
    const tools = Array.from({ length: 35 }, (_, index) => definition(`device_${index}_${'x'.repeat(90)}`))
    focus.select(tools)
    const seen: string[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const raw = await focus.selector.execute({ offset, query: 'device' }, { projectId: 'p' })
      const projected = compactToolOutput({ ok: true, output: compactToolOutput(raw, 6000) }, 700) as {
        output: ToolCatalogPage
      }
      expect(compactToolOutput(projected, 700)).toEqual(projected)
      expect(JSON.stringify(projected).length).toBeLessThanOrEqual(700)
      expect(projected.output.available.length).toBeGreaterThan(0)
      seen.push(...projected.output.available.map(hit => hit.name))
      offset = projected.output.nextOffset
      expect(offset === null || offset === seen.length).toBe(true)
      expect(seen.length).toBeLessThanOrEqual(tools.length)
    }
    expect(seen).toEqual(tools.map(tool => tool.function.name))
  })

  it('preserves hits when actual request fitting compacts an oversized catalog outcome', () => {
    const page: ToolCatalogPage = {
      catalog: 'luczor-tools-v1',
      selected: ['project_terminal_run'],
      offset: 0,
      total: 16,
      nextOffset: null,
      categories: Array.from({ length: 16 }, (_, index) => ({
        id: `category_${index}`,
        label: 'Category '.repeat(15),
        tools: 20,
      })),
      available: Array.from({ length: 16 }, (_, index) => ({
        name: index ? `device_${index}` : 'project_terminal_run',
        description: 'Description '.repeat(100),
      })),
    }
    const raw = JSON.stringify(page)
    const first = { ok: true, output: compactToolOutput(page, 6000) }
    expect(JSON.stringify(first).length).toBeGreaterThan(1800)
    const fitted = fitRequestContext(
      [
        { role: 'system', content: 'Mandatory rules. '.repeat(1000) },
        { role: 'user', content: 'Find tools' },
        { role: 'tool', name: 'tools_select', content: JSON.stringify(first), tool_call_id: 'search' },
      ],
      [],
      { targetTokens: 1024 }
    )
    expect(fitted.report.shortenedToolResults).toBe(0)
    const message = fitted.messages.find(item => item.role === 'tool')!
    const result = JSON.parse(message.content).output as ToolCatalogPage
    expect(result.available).toEqual(page.available.map(({ name }) => ({ name })))
    expect(result.selected).toEqual(['project_terminal_run'])
    expect(result.nextOffset).toBeNull()
    expect(JSON.stringify(compactToolOutput(JSON.parse(message.content), 1800))).toBe(message.content)
    expect(JSON.stringify(page)).toBe(raw)
  })

  it('preserves selected IDs and reports invalid names without changing selection or granting tools', async () => {
    const focus = focusedTools('device')
    focus.select([definition('device_list'), definition('device_dispatch')])
    await focus.selector.execute({ names: ['device_list'] }, { projectId: 'p' })
    await expect(
      focus.selector.execute({ names: ['device_dispatch', 'device_fake'] }, { projectId: 'p' })
    ).rejects.toThrow('Selection unchanged')
    const page = await focus.selector.execute({}, { projectId: 'p' })
    const projected = compactToolOutput({ ok: true, output: page }, 450) as { output: ToolCatalogPage }
    expect(projected.output.selected).toEqual(['device_list'])
    expect(projected.output.available.every(hit => hit.name !== 'device_fake')).toBe(true)
    expect(focus.select([definition('device_dispatch')]).map(tool => tool.function.name)).not.toContain('device_list')
  })

  it('guides repeated discovery, resets on execution and explains an out-of-range page', async () => {
    const focus = focusedTools('terminal')
    focus.select([definition('project_terminal_run')])
    for (let index = 0; index < 2; index++) await focus.selector.execute({ query: 'terminal' }, { projectId: 'p' })
    expect(await focus.selector.execute({ query: 'terminal' }, { projectId: 'p' })).toMatchObject({
      guidance: expect.stringContaining('Repeated discovery'),
    })
    focus.recordExecution('project_terminal_run')
    expect(await focus.selector.execute({ query: 'terminal' }, { projectId: 'p' })).toMatchObject({
      guidance: expect.stringContaining('Copy available names'),
    })
    expect(await focus.selector.execute({ query: 'terminal', offset: 5 }, { projectId: 'p' })).toMatchObject({
      available: [],
      guidance: expect.stringContaining('offset=0'),
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
    expect(toolUsageContext(many, [])).toContain('No measured tool usage')
    expect(toolUsageContext([], rows)).toBe('')
    expect(toolUsageContext(many, rows, false)).not.toContain('tools_select(')
  })
})
