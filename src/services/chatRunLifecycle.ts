export type ChatStopSnapshot = {
  generation: number
  controller: AbortController | null
  cancel: (() => void | Promise<void>) | null
}

/** Capture cancellation ownership before any asynchronous goal/tool teardown. */
export async function stopCapturedChatRun<T extends ChatStopSnapshot>(options: {
  capture: () => T
  isCurrent: (snapshot: T) => boolean
  abortReason?: unknown
  pauseGoal?: () => void | Promise<void>
  finishCurrent: (snapshot: T) => void
  clearCurrent: (snapshot: T) => void
}): Promise<void> {
  const snapshot = options.capture()
  const pending: Promise<unknown>[] = []
  const begin = (action: (() => void | Promise<void>) | null | undefined) => {
    if (!action) return
    try {
      pending.push(Promise.resolve(action()))
    } catch {
      // One failed cleanup must not prevent cancellation of the captured chat.
    }
  }
  begin(options.pauseGoal)
  snapshot.controller?.abort(options.abortReason)
  if (options.isCurrent(snapshot)) options.finishCurrent(snapshot)
  begin(snapshot.cancel)
  await Promise.allSettled(pending)
  // A new admission is a new generation even before it creates a controller.
  if (options.isCurrent(snapshot)) options.clearCurrent(snapshot)
}
