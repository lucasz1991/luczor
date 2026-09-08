export type MemoryActivitySnapshot = Readonly<{
  /** Successfully completed logical operations; backend subcalls are not counted again. */
  reads: number
  writes: number
  activeReads: number
  activeWrites: number
  failedReads: number
  failedWrites: number
  measuredSince: number
}>

type MemoryOperation = 'read' | 'write'

// Session-local, bounded telemetry only. Never retain operation arguments, results or errors.
const activity = {
  reads: 0,
  writes: 0,
  activeReads: 0,
  activeWrites: 0,
  failedReads: 0,
  failedWrites: 0,
  measuredSince: Date.now(),
}

export function snapshotMemoryActivity(): MemoryActivitySnapshot {
  return Object.freeze({ ...activity })
}

/** Fallbacks may mark a partial failure without changing their returned result. */
export async function trackMemoryActivity<T>(
  kind: MemoryOperation,
  operation: (markFailed: () => void) => T | PromiseLike<T>
): Promise<T> {
  const activeKey = kind === 'read' ? 'activeReads' : 'activeWrites'
  const completedKey = kind === 'read' ? 'reads' : 'writes'
  const failedKey = kind === 'read' ? 'failedReads' : 'failedWrites'
  let failed = false
  activity[activeKey]++
  try {
    const result = await operation(() => { failed = true })
    if (!failed) activity[completedKey]++
    return result
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (failed) activity[failedKey]++
    activity[activeKey]--
  }
}
