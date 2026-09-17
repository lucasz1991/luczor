export type MemoryUsageKind = 'localRecall' | 'sharedRecall' | 'save' | 'graphSearch' | 'graphRead' | 'graphIndex'
export type UsageCounter = {
  completed: number
  failed: number
  active: number
  lastAt: number | null
  lastMs: number | null
  results: number
}
const kinds: MemoryUsageKind[] = ['localRecall', 'sharedRecall', 'save', 'graphSearch', 'graphRead', 'graphIndex']
const empty = (): UsageCounter => ({ completed: 0, failed: 0, active: 0, lastAt: null, lastMs: null, results: 0 })
let generation = 0
const counters = new Map(kinds.map(kind => [kind, empty()]))
export function resetMemoryUsage() {
  generation++
  for (const kind of kinds) counters.set(kind, empty())
}
if (typeof window !== 'undefined') window.addEventListener('luczor:api-identity-changing', resetMemoryUsage)
export function memoryUsageSnapshot() {
  return kinds.map(kind => ({ kind, ...counters.get(kind)! }))
}
/** Only counters and timings survive. No query, path, content, identity or error text. */
export async function trackMemoryUsage<T>(
  kind: MemoryUsageKind,
  work: (markFailed: () => void) => Promise<T>
): Promise<T> {
  const epoch = generation
  const counter = counters.get(kind)!
  const start = performance.now()
  counter.active++
  let failed = false
  try {
    const result = await work(() => {
      failed = true
    })
    if (epoch === generation) {
      if (failed) counter.failed++
      else counter.completed++
      const items = Array.isArray(result)
        ? result
        : result && typeof result === 'object' && 'hits' in result
          ? result.hits
          : result && typeof result === 'object' && 'snippets' in result
            ? result.snippets
            : null
      counter.results += Array.isArray(items) ? items.length : 0
    }
    return result
  } catch (error) {
    if (epoch === generation) counter.failed++
    throw error
  } finally {
    if (epoch === generation) {
      counter.active--
      counter.lastAt = Date.now()
      counter.lastMs = Math.round(performance.now() - start)
    }
  }
}
