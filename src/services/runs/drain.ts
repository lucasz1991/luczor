export type RuntimeDrainResult = { settled: boolean; pendingIds: string[] }
export type NativeStopAcknowledgement = { generation: number; nativeStopped: true }

/** A deadline reports remaining ownership; it never pretends the work has stopped. */
export async function waitForRuntimeDrain(
  pending: () => Array<{ id: string; drained: Promise<void> }>,
  timeoutMs = 1500
): Promise<RuntimeDrainResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error('Ungültige Stoppfrist.')
  const initial = pending()
  if (!initial.length) return { settled: true, pendingIds: [] }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(initial.map(item => item.drained)),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  const pendingIds = pending().map(item => item.id)
  return { settled: pendingIds.length === 0, pendingIds }
}
