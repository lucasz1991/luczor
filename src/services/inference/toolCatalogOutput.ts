export type ToolCatalogPage = {
  catalog: 'luczor-tools-v1'
  selected: string[]
  available: { name: string; description?: string; category?: string; path?: string[] }[]
  offset: number
  total: number
  nextOffset: number | null
  categories?: { id: string; label: string; tools: number }[]
  guidance?: string
}

/** Keep complete tool identities and a cursor for every undelivered hit.
 * Repeated projection is stable; catalog arrays never become generic wrappers.
 */
export function compactToolCatalog(value: unknown, maxChars: number): unknown | undefined {
  if (!value || typeof value !== 'object') return undefined
  const envelope = value as Record<string, unknown>
  const wrapped = envelope.output && typeof envelope.output === 'object'
  const source = (wrapped ? envelope.output : envelope) as ToolCatalogPage
  if (source.catalog !== 'luczor-tools-v1' || !Array.isArray(source.available)) return undefined
  const page = structuredClone(source)
  const result = () => (wrapped ? { ...envelope, output: page } : page)
  const fits = () => JSON.stringify(result()).length <= maxChars
  if (fits()) return result()
  for (const hit of page.available) {
    delete hit.description
    delete hit.path
    delete hit.category
  }
  if (fits()) return result()
  delete page.categories
  if (fits()) return result()
  delete page.guidance
  while (!fits() && page.available.length) {
    page.available.pop()
    page.nextOffset = page.offset + page.available.length
  }
  if (fits()) return result()
  // Even the selected IDs cannot fit. Never emit shortened IDs or a false end cursor.
  return { truncated: true, omitted: true, reason: 'Tool catalog budget too small; repeat tools_select.' }
}
