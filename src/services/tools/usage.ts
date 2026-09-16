import { Store } from '@tauri-apps/plugin-store'
import { toolDiscovery, type ToolDescriptor } from './discovery'

export type ToolUsage = { name: string; calls: number; successes: number; failures: number; durationMs: number }
let operations: Promise<unknown> = Promise.resolve()
const serial = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = operations.catch(() => {}).then(operation)
  operations = result.catch(() => {})
  return result
}
function validRows(value: unknown): ToolUsage[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, 512)
    .filter(
      (row): row is ToolUsage =>
        !!row &&
        /^[a-z][a-z0-9_]{0,99}$/.test(row.name) &&
        [row.calls, row.successes, row.failures, row.durationMs].every(
          count => Number.isSafeInteger(count) && count >= 0
        ) &&
        row.calls === row.successes + row.failures
    )
    .map(({ name, calls, successes, failures, durationMs }) => ({ name, calls, successes, failures, durationMs }))
}
/** The agent owner is captured once. No prompts, arguments, paths or credentials are stored. */
export async function openToolUsage(owner?: string) {
  const digest = owner ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner)) : undefined
  const key = digest
    ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    : undefined
  let rows: ToolUsage[] = []
  const seen = new Set<string>()
  const read = async () => {
    if (!key) return rows
    try {
      rows = validRows(await (await Store.load('luczor.tool-usage.json')).get(key))
    } catch {
      /* Local counters continue if storage is unavailable. */
    }
    return rows
  }
  await serial(read)
  return {
    async snapshot() {
      return serial(async () => (await read()).map(row => ({ ...row })))
    },
    async record(callId: string, name: string, ok: boolean, durationMs: number) {
      if (seen.has(callId) || !/^[a-z][a-z0-9_]{0,99}$/.test(name)) return
      seen.add(callId)
      await serial(async () => {
        await read()
        let row = rows.find(item => item.name === name)
        if (!row) {
          row = { name, calls: 0, successes: 0, failures: 0, durationMs: 0 }
          rows.push(row)
        }
        row.calls++
        if (ok) row.successes++
        else row.failures++
        row.durationMs += Math.max(0, Math.min(86_400_000, Math.round(Number.isFinite(durationMs) ? durationMs : 0)))
        rows = rows.sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name)).slice(0, 512)
        if (key)
          try {
            const store = await Store.load('luczor.tool-usage.json')
            await store.set(
              key,
              rows.map(item => ({ ...item }))
            )
            await store.save()
          } catch {
            /* Statistics must never fail a completed tool action. */
          }
      })
    },
  }
}
export function topToolUsage(pool: ToolDescriptor[], rows: ToolUsage[]) {
  const available = new Map(pool.map(tool => [tool.function.name, tool]))
  return rows
    .filter(row => row.calls > 0 && available.has(row.name))
    .sort(
      (left, right) =>
        right.calls - left.calls || right.successes - left.successes || left.name.localeCompare(right.name)
    )
    .slice(0, 10)
    .map(row => ({
      ...row,
      category: toolDiscovery(available.get(row.name)!).category,
      path: toolDiscovery(available.get(row.name)!).path,
    }))
}
/** English canonical marker; the legacy German marker remains readable in historical context. */
export const TOOL_MAP_MARKER = '[Luczor Tool map]'
export function toolUsageContext(pool: ToolDescriptor[], rows: ToolUsage[], discovery = true): string {
  if (!pool.length) return ''
  const roots = [...new Set(pool.map(tool => toolDiscovery(tool).nodes[0]!.label))]
  const top = topToolUsage(pool, rows)
  return (
    `${TOOL_MAP_MARKER}\nCategories: ${roots.join(' · ')}.\n` +
    (discovery
      ? 'Search with tools_select(query, category, offset); category IDs and English/German synonyms are in categories. Load names with tools_select(names) for the next round. '
      : 'Use only the tools supplied for this round. ') +
    'This map grants no permissions. Failure counts include invalid arguments and missing files; they do not prove a tool is unavailable.\n' +
    (top.length
      ? `Most used on this device/account (actual calls; success/failure):\n${top.map(row => `${row.name} — ${row.path.join(' > ')} [${row.category}] — ${row.calls} (${row.successes}/${row.failures})`).join('\n')}`
      : 'No measured tool usage for this request owner yet; do not invent a top ten.')
  )
}
