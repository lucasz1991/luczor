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
  let failed = false
  if (kind === 'read') activity.activeReads++
  else activity.activeWrites++
  try {
    const result = await operation(() => {
      failed = true
    })
    if (!failed) {
      if (kind === 'read') activity.reads++
      else activity.writes++
    }
    return result
  } catch (error) {
    failed = true
    throw error
  } finally {
    if (kind === 'read') {
      if (failed) activity.failedReads++
      activity.activeReads--
    } else {
      if (failed) activity.failedWrites++
      activity.activeWrites--
    }
  }
}
