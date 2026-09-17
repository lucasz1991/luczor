import { describe, expect, it, vi } from 'vitest'
import {
  createDevicePairingPoller,
  DEVICE_PAIRING_POLL_INTERVAL_MS,
  type DevicePairing,
} from '@/services/devicePairing'

function pairing(expiresAt = 60_000): DevicePairing {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    secret: 'a'.repeat(64),
    baseUrl: 'https://luczor.example.test',
    url: 'https://luczor.example.test/devices/pair/123e4567-e89b-42d3-a456-426614174000',
    expiresAt,
  }
}

function harness() {
  let now = 0
  let scheduled: { callback: () => void; delayMs: number } | undefined
  const claim = vi.fn()
  const onPending = vi.fn()
  const onApproved = vi.fn()
  const onExpired = vi.fn()
  const onError = vi.fn()
  const poller = createDevicePairingPoller<string>({
    claim,
    onPending,
    onApproved,
    onExpired,
    onError,
    now: () => now,
    setTimer: (callback, delayMs) => {
      scheduled = { callback, delayMs }
      return scheduled as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: timer => {
      if (timer === (scheduled as unknown as ReturnType<typeof setTimeout>)) scheduled = undefined
    },
  })
  return {
    claim,
    onPending,
    onApproved,
    onExpired,
    onError,
    poller,
    get scheduled() {
      return scheduled
    },
    advanceTo(value: number) {
      now = value
    },
  }
}

describe('device pairing poller', () => {
  it('automatically adopts the browser-approved device key after a pending check', async () => {
    const test = harness()
    test.claim.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'approved', value: 'key' })

    test.poller.start(pairing())
    await vi.waitFor(() => expect(test.onPending).toHaveBeenCalledOnce())
    expect(test.scheduled?.delayMs).toBe(DEVICE_PAIRING_POLL_INTERVAL_MS)

    test.scheduled?.callback()
    await vi.waitFor(() => expect(test.onApproved).toHaveBeenCalledWith(expect.anything(), 'key'))
    expect(test.poller.isPending()).toBe(false)
  })

  it('stops without another request once the short browser-pairing lifetime expires', async () => {
    const test = harness()
    test.claim.mockResolvedValue({ status: 'pending' })

    test.poller.start(pairing(1_000))
    await vi.waitFor(() => expect(test.onPending).toHaveBeenCalledOnce())
    expect(test.scheduled?.delayMs).toBe(1_000)

    test.advanceTo(1_000)
    test.scheduled?.callback()
    await vi.waitFor(() => expect(test.onExpired).toHaveBeenCalledOnce())
    expect(test.claim).toHaveBeenCalledOnce()
  })

  it('cancels a stale claim when the account target changes or the component closes', async () => {
    const test = harness()
    let resolve!: (value: { status: 'approved'; value: string }) => void
    test.claim.mockReturnValueOnce(new Promise(value => (resolve = value)))

    test.poller.start(pairing())
    test.poller.cancel()
    resolve({ status: 'approved', value: 'key' })

    await Promise.resolve()
    await Promise.resolve()
    expect(test.onApproved).not.toHaveBeenCalled()
    expect(test.poller.isPending()).toBe(false)
  })

  it('starts the replacement pairing immediately while an abandoned claim is still resolving', async () => {
    const test = harness()
    let resolveOld!: (value: { status: 'approved'; value: string }) => void
    test.claim
      .mockReturnValueOnce(new Promise(value => (resolveOld = value)))
      .mockResolvedValueOnce({ status: 'approved', value: 'new-key' })

    test.poller.start(pairing())
    test.poller.start(pairing(120_000))

    await vi.waitFor(() => expect(test.onApproved).toHaveBeenCalledWith(expect.anything(), 'new-key'))
    resolveOld({ status: 'approved', value: 'old-key' })
    await Promise.resolve()
    await Promise.resolve()

    expect(test.onApproved).toHaveBeenCalledOnce()
  })
})
