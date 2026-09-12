/** Preserve sequence and payload across uncertain acknowledgements; send one event at a time. */
export function createProgressReporter(
  send: (sequence: number, summary: string) => Promise<unknown>,
  initialSequence = 0
) {
  let sequence = initialSequence
  let pending: { sequence: number; summary: string } | null = null
  let tail = Promise.resolve()
  const flushPending = async () => {
    if (!pending) return
    await send(pending.sequence, pending.summary)
    sequence = pending.sequence
    pending = null
  }
  return {
    report(summary: string) {
      const next = tail
        .catch(() => {})
        .then(async () => {
          await flushPending()
          pending = { sequence: sequence + 1, summary: summary.slice(0, 4000) }
          await flushPending()
        })
      tail = next
      return next
    },
    flush: () => tail.catch(() => {}).then(flushPending),
    sequence: () => sequence,
  }
}
