import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getApiConfig: vi.fn(),
  registerDevice: vi.fn(),
  realtimeConfig: vi.fn(),
  nextDeviceJob: vi.fn(),
  reverbAuth: vi.fn(),
}))

const notifications = vi.hoisted(() => ({
  catchUp: vi.fn(),
  handleRealtime: vi.fn(),
}))

const pusherHarness = vi.hoisted(() => {
  class Bindings {
    state = 'connecting'
    handlers = new Map<string, Array<(...args: unknown[]) => void>>()
    bind(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    }
    unbind_all() {
      this.handlers.clear()
    }
  }

  class FakePusher {
    static instances: FakePusher[] = []
    connection = new Bindings()
    channel = new Bindings()
    connect = vi.fn()
    disconnect = vi.fn()
    unsubscribe = vi.fn()
    constructor() {
      FakePusher.instances.push(this)
    }
    subscribe() {
      return this.channel
    }
  }
  return { FakePusher }
})

vi.mock('pusher-js', () => ({ default: pusherHarness.FakePusher }))
vi.mock('@/services/api/luczorApi', () => ({
  getApiConfig: api.getApiConfig,
  LuczorApi: {
    registerDevice: api.registerDevice,
    realtimeConfig: api.realtimeConfig,
    nextDeviceJob: api.nextDeviceJob,
    reverbAuth: api.reverbAuth,
  },
}))
vi.mock('@/services/agents', () => ({ runAgentCli: vi.fn() }))
vi.mock('@/services/notifications', () => ({
  catchUpPushNotifications: notifications.catchUp,
  handleRealtimeNotification: notifications.handleRealtime,
  REALTIME_NOTIFICATION_EVENT: 'app.notification.created',
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('device job transport startup', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const windowEvents = new EventTarget()
    Object.assign(windowEvents, {
      setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
      clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      confirm: vi.fn(() => true),
    })
    const documentEvents = new EventTarget()
    Object.defineProperty(documentEvents, 'visibilityState', { value: 'visible', configurable: true })
    vi.stubGlobal('window', windowEvents)
    vi.stubGlobal('document', documentEvents)
    vi.stubGlobal('navigator', { platform: 'test' })
    if (typeof CustomEvent === 'undefined') {
      vi.stubGlobal(
        'CustomEvent',
        class<T> extends Event {
          detail: T
          constructor(type: string, init: CustomEventInit<T>) {
            super(type)
            this.detail = init.detail as T
          }
        }
      )
    }
    stop = null
    api.getApiConfig.mockReset().mockResolvedValue({
      baseUrl: 'https://luczor.example',
      clientId: 'client-1',
      deviceKey: 'device-key',
    })
    api.registerDevice.mockReset()
    api.realtimeConfig.mockReset()
    api.nextDeviceJob.mockReset().mockResolvedValue({ data: null })
    api.reverbAuth.mockReset()
    notifications.catchUp.mockReset().mockResolvedValue(undefined)
    notifications.handleRealtime.mockReset().mockResolvedValue(undefined)
    pusherHarness.FakePusher.instances.length = 0
  })

  afterEach(() => {
    stop?.()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts REST polling and notification catch-up before Reverb registration completes', async () => {
    api.registerDevice.mockImplementation(() => new Promise(() => {}))
    const { getDeviceJobChannelState, startDeviceJobChannel } = await import('@/services/deviceJobs')

    stop = await startDeviceJobChannel()
    await Promise.resolve()

    expect(api.nextDeviceJob).toHaveBeenCalledWith('client-1')
    expect(notifications.catchUp).toHaveBeenCalled()
    expect(api.realtimeConfig).not.toHaveBeenCalled()
    expect(getDeviceJobChannelState()).toMatchObject({
      running: true,
      rest: 'polling',
      realtime: 'connecting',
    })
  })

  it('keeps REST alive and exposes a degraded state when Reverb setup fails', async () => {
    api.registerDevice.mockRejectedValue(new Error('reverb offline'))
    const { getDeviceJobChannelState, startDeviceJobChannel } = await import('@/services/deviceJobs')

    stop = await startDeviceJobChannel()
    await Promise.resolve()
    await Promise.resolve()

    expect(api.nextDeviceJob).toHaveBeenCalled()
    expect(getDeviceJobChannelState()).toMatchObject({
      running: true,
      rest: 'polling',
      realtime: 'unavailable',
      lastError: 'reverb offline',
    })
  })

  it('backs off REST polling while hidden and stops requests while offline', async () => {
    const { shouldPollDeviceJobs } = await import('@/services/deviceJobs')

    expect(shouldPollDeviceJobs(10_000, null, 'hidden', true)).toBe(true)
    expect(shouldPollDeviceJobs(50_000, 10_000, 'hidden', true)).toBe(false)
    expect(shouldPollDeviceJobs(70_000, 10_000, 'hidden', true)).toBe(true)
    expect(shouldPollDeviceJobs(20_000, 10_000, 'visible', true)).toBe(true)
    expect(shouldPollDeviceJobs(70_000, 10_000, 'visible', false)).toBe(false)
  })
})
