export const DEVICE_PAIRING_POLL_INTERVAL_MS = 3_000

export type DevicePairing = Readonly<{
  id: string
  secret: string
  baseUrl: string
  url: string
  expiresAt: number
}>

export type DevicePairingClaim<T> =
  Readonly<{ status: 'pending' }> | Readonly<{ status: 'expired' }> | Readonly<{ status: 'approved'; value: T }>

type Timer = ReturnType<typeof setTimeout>

type DevicePairingPollerDependencies<T> = {
  claim(pairing: DevicePairing): Promise<DevicePairingClaim<T>>
  onPending(pairing: DevicePairing): void
  onApproved(pairing: DevicePairing, value: T): void
  onExpired(pairing: DevicePairing): void
  onError(pairing: DevicePairing): void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => Timer
  clearTimer?: (timer: Timer) => void
}

/**
 * Polls only the pairing secret generated for this desktop. It never reads a
 * browser cookie and stops at the server's short pairing expiry.
 */
export function createDevicePairingPoller<T>(dependencies: DevicePairingPollerDependencies<T>) {
  const now = dependencies.now ?? Date.now
  const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = dependencies.clearTimer ?? clearTimeout
  let pairing: DevicePairing | null = null
  let timer: Timer | undefined
  let inFlight: DevicePairing | null = null

  function clearScheduledClaim() {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  function expire(current: DevicePairing) {
    if (pairing !== current) return
    clearScheduledClaim()
    pairing = null
    dependencies.onExpired(current)
  }

  function schedule(current: DevicePairing) {
    if (pairing !== current) return
    clearScheduledClaim()
    const remainingMs = current.expiresAt - now()
    if (remainingMs <= 0) {
      expire(current)
      return
    }
    timer = setTimer(
      () => {
        timer = undefined
        void claim(current)
      },
      Math.min(DEVICE_PAIRING_POLL_INTERVAL_MS, remainingMs)
    )
  }

  async function claim(current: DevicePairing) {
    if (pairing !== current || inFlight === current) return
    if (current.expiresAt <= now()) {
      expire(current)
      return
    }
    inFlight = current
    try {
      const result = await dependencies.claim(current)
      if (pairing !== current) return
      if (result.status === 'approved') {
        clearScheduledClaim()
        pairing = null
        dependencies.onApproved(current, result.value)
      } else if (result.status === 'expired') {
        expire(current)
      } else {
        dependencies.onPending(current)
        schedule(current)
      }
    } catch {
      if (pairing !== current) return
      dependencies.onError(current)
      schedule(current)
    } finally {
      if (inFlight === current) inFlight = null
    }
  }

  function cancel() {
    clearScheduledClaim()
    pairing = null
  }

  return {
    start(next: DevicePairing) {
      cancel()
      pairing = next
      void claim(next)
    },
    checkNow() {
      if (!pairing || inFlight === pairing) return
      clearScheduledClaim()
      void claim(pairing)
    },
    cancel,
    isPending() {
      return pairing !== null
    },
  }
}
