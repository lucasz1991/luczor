import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getApiConfig: vi.fn(),
  registerDevice: vi.fn(),
  realtimeConfig: vi.fn(),
  nextDeviceJob: vi.fn(),
  reverbAuth: vi.fn(),
  approveDeviceJob: vi.fn(),
  startDeviceJob: vi.fn(),
  completeDeviceJob: vi.fn(),
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
    options: unknown
    constructor(_key?: string, options?: unknown) {
      this.options = options
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
    approveDeviceJob: api.approveDeviceJob,
    startDeviceJob: api.startDeviceJob,
    completeDeviceJob: api.completeDeviceJob,
  },
}))
vi.mock('@/services/agents', () => ({ runAgentCli: vi.fn() }))
vi.mock('@/services/agents/workflowAgent', () => ({ runWorkflowAgent: vi.fn() }))
vi.mock('@/services/notifications', () => ({
  catchUpPushNotifications: notifications.catchUp,
  handleRealtimeNotification: notifications.handleRealtime,
  REALTIME_NOTIFICATION_EVENT: 'app.notification.created',
}))
const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
const webChat = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@/services/webWorkspaceJob', () => ({ runWebWorkspaceJob: webChat.run }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

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
    api.approveDeviceJob.mockReset().mockResolvedValue(undefined)
    api.startDeviceJob.mockReset().mockResolvedValue(undefined)
    api.completeDeviceJob.mockReset().mockResolvedValue(undefined)
    native.invoke.mockReset().mockResolvedValue(undefined)
    webChat.run.mockReset().mockResolvedValue({ ok: true, text: 'Personal response' })
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

    expect(api.nextDeviceJob).toHaveBeenCalledWith(
      'client-1',
      expect.objectContaining({ clientId: 'client-1' }),
      expect.any(AbortSignal)
    )
    expect(notifications.catchUp).toHaveBeenCalled()
    expect(api.realtimeConfig).not.toHaveBeenCalled()
    expect(getDeviceJobChannelState()).toMatchObject({
      running: true,
      rest: 'polling',
      realtime: 'connecting',
    })
  })

  it('invalidates a channel start waiting on API config and an old stop cannot stop its replacement', async () => {
    const config = deferred<{ baseUrl: string; clientId: string; deviceKey: string }>()
    api.getApiConfig.mockImplementationOnce(() => config.promise)
    const { getDeviceJobChannelState, startDeviceJobChannel, stopDeviceJobChannel } =
      await import('@/services/deviceJobs')
    const pending = startDeviceJobChannel()
    stopDeviceJobChannel()
    config.resolve({ baseUrl: 'https://old.example', clientId: 'old-client', deviceKey: 'old-key' })
    const oldStop = await pending
    expect(api.nextDeviceJob).not.toHaveBeenCalled()
    expect(api.registerDevice).not.toHaveBeenCalled()

    api.getApiConfig.mockResolvedValue({
      baseUrl: 'https://new.example',
      clientId: 'new-client',
      deviceKey: 'new-key',
    })
    const newStop = await startDeviceJobChannel()
    expect(getDeviceJobChannelState().running).toBe(true)
    oldStop()
    expect(getDeviceJobChannelState().running).toBe(true)
    stop = newStop
  })

  it('does not continue Reverb setup after identity invalidation during registration or config', async () => {
    const registration = deferred<{ session: { token: string } }>()
    api.registerDevice.mockImplementationOnce(() => registration.promise)
    const { startDeviceJobChannel, stopDeviceJobChannel } = await import('@/services/deviceJobs')
    stop = await startDeviceJobChannel()
    await Promise.resolve()
    stopDeviceJobChannel()
    registration.resolve({ session: { token: 'old-token' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(api.realtimeConfig).not.toHaveBeenCalled()

    const realtime = deferred<{ data: { key: string; host: string; scheme: string; port: number } }>()
    api.registerDevice.mockResolvedValue({ session: { token: 'new-token' } })
    api.realtimeConfig.mockImplementationOnce(() => realtime.promise)
    stop = await startDeviceJobChannel()
    await vi.waitFor(() => expect(api.realtimeConfig).toHaveBeenCalledOnce())
    stopDeviceJobChannel()
    realtime.resolve({ data: { key: 'key', host: 'host', scheme: 'https', port: 443 } })
    await Promise.resolve()
    await Promise.resolve()
    expect(pusherHarness.FakePusher.instances).toHaveLength(0)
  })

  it('drops a realtime notification whose handler crosses the identity boundary', async () => {
    const handled = deferred<void>()
    api.registerDevice.mockResolvedValue({ session: { token: 'token' } })
    api.realtimeConfig.mockResolvedValue({ data: { key: 'key', host: 'host', scheme: 'https', port: 443 } })
    notifications.handleRealtime.mockImplementationOnce(() => handled.promise)
    const { startDeviceJobChannel, stopDeviceJobChannel } = await import('@/services/deviceJobs')
    stop = await startDeviceJobChannel()
    await vi.waitFor(() => expect(pusherHarness.FakePusher.instances).toHaveLength(1))
    const instance = pusherHarness.FakePusher.instances[0]!
    const handler = instance.channel.handlers.get('app.notification.created')?.[0]
    const catchUpsBefore = notifications.catchUp.mock.calls.length
    handler?.({ id: 'old-account-notification' })
    await Promise.resolve()
    stopDeviceJobChannel()
    handled.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(notifications.catchUp).toHaveBeenCalledTimes(catchUpsBefore)
  })

  it('rejects realtime authorization that completes after the channel identity changed', async () => {
    const authorization = deferred<Record<string, unknown>>()
    api.registerDevice.mockResolvedValue({ session: { token: 'old-token' } })
    api.realtimeConfig.mockResolvedValue({ data: { key: 'key', host: 'host', scheme: 'https', port: 443 } })
    api.reverbAuth.mockImplementationOnce(() => authorization.promise)
    const { startDeviceJobChannel, stopDeviceJobChannel } = await import('@/services/deviceJobs')
    stop = await startDeviceJobChannel()
    await vi.waitFor(() => expect(pusherHarness.FakePusher.instances).toHaveLength(1))
    const instance = pusherHarness.FakePusher.instances[0]!
    const customHandler = (
      instance.options as {
        channelAuthorization: {
          customHandler: (
            input: { socketId: string; channelName: string },
            callback: (error: Error | null, auth: unknown) => void
          ) => Promise<void>
        }
      }
    ).channelAuthorization.customHandler
    const callback = vi.fn()
    const pending = customHandler({ socketId: 'socket', channelName: 'private-device.old' }, callback)
    await vi.waitFor(() => expect(api.reverbAuth).toHaveBeenCalledOnce())
    stopDeviceJobChannel()
    authorization.resolve({ auth: 'old-account-auth' })
    await pending
    expect(callback).toHaveBeenCalledWith(expect.any(Error), null)
    await customHandler({ socketId: 'late', channelName: 'private-device.old' }, callback)
    expect(api.reverbAuth).toHaveBeenCalledOnce()
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

  it('discards a REST job delivered after stop without verification or effects', async () => {
    let deliver!: (value: unknown) => void
    api.nextDeviceJob.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          deliver = resolve
        })
    )
    const { startDeviceJobChannel } = await import('@/services/deviceJobs')
    stop = await startDeviceJobChannel()
    stop()
    deliver({ data: { id: 'late', tool_profile: 'desktop.input.type_text', payload: { text: 'late' } } })
    await vi.advanceTimersByTimeAsync(1)
    expect(native.invoke).not.toHaveBeenCalledWith('verify_device_job', expect.anything())
    expect(api.startDeviceJob).not.toHaveBeenCalled()
  })

  it('rejects a mutation while observing and rechecks Not-Aus after native verification', async () => {
    const { startDeviceJobChannel } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    const job = { id: 'input', status: 'queued', tool_profile: 'desktop.input.type_text', payload: { text: 'private' } }
    api.nextDeviceJob.mockResolvedValueOnce({ data: job })
    stop = await startDeviceJobChannel()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    stop()
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'p1' })
    native.invoke.mockImplementation(async command => {
      if (command === 'verify_device_job') updateExecutionControls({ mode: 'act', killSwitch: true, scope: 'p1' })
    })
    api.nextDeviceJob.mockResolvedValueOnce({ data: job })
    stop = await startDeviceJobChannel()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('runs a verified personal web chat in Observe while workspace tools remain blocked', async () => {
    const { startDeviceJobChannel } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'p1' })
    const job = {
      id: 'personal',
      status: 'approval_required',
      tool_profile: 'workspace.chat',
      payload: { scope: 'personal' },
    }
    api.nextDeviceJob.mockResolvedValueOnce({ data: job })
    stop = await startDeviceJobChannel()
    await vi.waitFor(() => expect(api.completeDeviceJob).toHaveBeenCalled())
    expect(native.invoke).toHaveBeenCalledWith('verify_device_job', { payload: job })
    expect(api.approveDeviceJob).toHaveBeenCalledWith(
      'personal',
      'client-1',
      true,
      undefined,
      expect.any(Object),
      expect.any(AbortSignal)
    )
    expect(api.startDeviceJob).toHaveBeenCalledWith('personal', 'client-1', expect.any(Object), expect.any(AbortSignal))
    expect(webChat.run).toHaveBeenCalledWith(
      job.payload,
      expect.anything(),
      expect.any(Function),
      'personal',
      expect.objectContaining({ baseUrl: 'https://luczor.example', clientId: 'client-1' })
    )
    expect(api.completeDeviceJob).toHaveBeenCalledWith(
      'personal',
      'client-1',
      true,
      { ok: true, text: 'Personal response' },
      undefined,
      expect.objectContaining({ baseUrl: 'https://luczor.example', clientId: 'client-1', deviceKey: 'device-key' }),
      expect.any(AbortSignal)
    )
    stop()
    api.startDeviceJob.mockClear()
    api.nextDeviceJob.mockResolvedValueOnce({ data: { ...job, id: 'workspace', payload: { scope: 'workspace' } } })
    stop = await startDeviceJobChannel()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    expect(webChat.run).toHaveBeenCalledTimes(1)
  })

  it('previews the complete signed workflow and records ok:false as a failure', async () => {
    const { startDeviceJobChannel } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'p1' })
    native.invoke.mockImplementation(async command =>
      command === 'wf_http_request' ? { ok: false, status: 503, body: 'unavailable' } : undefined
    )
    const job = {
      id: 'api-failure',
      status: 'approval_required',
      tool_profile: 'workflow.task',
      payload: { task_key: 'api.call', params: { url: 'https://example.test', method: 'POST', body: 'review-me' } },
    }
    api.nextDeviceJob.mockResolvedValueOnce({ data: job })
    stop = await startDeviceJobChannel()
    await vi.waitFor(() => expect(api.completeDeviceJob).toHaveBeenCalled(), { timeout: 2000 })
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('review-me'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('SHA-256:'))
    expect(api.completeDeviceJob).toHaveBeenCalledWith(
      'api-failure',
      'client-1',
      false,
      expect.objectContaining({ ok: false, status: 503 }),
      expect.any(String),
      expect.any(Object),
      expect.any(AbortSignal)
    )
  })

  it('does not start or approve a job when the channel stops during local approval', async () => {
    const { startDeviceJobChannel } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'p1' })
    vi.mocked(window.confirm).mockImplementation(() => {
      stop?.()
      return true
    })
    api.nextDeviceJob.mockResolvedValueOnce({
      data: {
        id: 'stopped',
        status: 'approval_required',
        tool_profile: 'desktop.open_url',
        payload: { url: 'https://example.test' },
      },
    })
    stop = await startDeviceJobChannel()
    await vi.waitFor(() => expect(window.confirm).toHaveBeenCalled(), { timeout: 2000 })
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    expect(api.approveDeviceJob).not.toHaveBeenCalled()
  })

  it('waits for a native decision and records a cancellation without executing the device action', async () => {
    const answer = deferred<string>()
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: native.invoke } })
    native.invoke.mockImplementation(command =>
      command === 'plugin:dialog|message' ? answer.promise : Promise.resolve()
    )
    const { startDeviceJobChannel } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'p1' })
    api.nextDeviceJob.mockResolvedValueOnce({
      data: {
        id: 'cancel-dialog',
        status: 'approval_required',
        tool_profile: 'desktop.open_url',
        payload: { url: 'https://example.test' },
      },
    })
    stop = await startDeviceJobChannel()
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith('plugin:dialog|message', expect.anything(), undefined)
    )
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    expect(api.approveDeviceJob).not.toHaveBeenCalled()
    answer.resolve('Abbrechen')
    await vi.waitFor(() =>
      expect(api.approveDeviceJob).toHaveBeenCalledWith(
        'cancel-dialog',
        'client-1',
        false,
        'Rejected on local device',
        expect.any(Object),
        expect.any(AbortSignal)
      )
    )
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    expect(native.invoke).not.toHaveBeenCalledWith('open_url', expect.anything())
  })

  it('discards native approval after the execution controls change while its dialog is open', async () => {
    const answer = deferred<string>()
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: native.invoke } })
    native.invoke.mockImplementation(command =>
      command === 'plugin:dialog|message' ? answer.promise : Promise.resolve()
    )
    const { startDeviceJobChannel, getDeviceJobChannelState } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'p1' })
    api.nextDeviceJob.mockResolvedValueOnce({
      data: {
        id: 'stale-dialog',
        status: 'approval_required',
        tool_profile: 'desktop.open_url',
        payload: { url: 'https://example.test' },
      },
    })
    stop = await startDeviceJobChannel()
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith('plugin:dialog|message', expect.anything(), undefined)
    )
    updateExecutionControls({ mode: 'act', killSwitch: true, scope: 'p1' })
    answer.resolve('Bestätigen')
    await vi.waitFor(() => expect(getDeviceJobChannelState().lastError).toContain('Ausführung verworfen'))
    expect(api.approveDeviceJob).not.toHaveBeenCalled()
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    expect(native.invoke).not.toHaveBeenCalledWith('open_url', expect.anything())
  })

  it('reports a failed native dialog without approving or executing the device action', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: native.invoke } })
    native.invoke.mockImplementation(command =>
      command === 'plugin:dialog|message' ? Promise.reject(new Error('dialog.message not allowed')) : Promise.resolve()
    )
    const { startDeviceJobChannel, getDeviceJobChannelState } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'p1' })
    api.nextDeviceJob.mockResolvedValueOnce({
      data: {
        id: 'failed-dialog',
        status: 'approval_required',
        tool_profile: 'desktop.open_url',
        payload: { url: 'https://example.test' },
      },
    })
    stop = await startDeviceJobChannel()
    await vi.waitFor(() =>
      expect(getDeviceJobChannelState().lastError).toContain('Bestätigungsdialog konnte nicht geöffnet')
    )
    expect(api.approveDeviceJob).not.toHaveBeenCalled()
    expect(api.startDeviceJob).not.toHaveBeenCalled()
    expect(native.invoke).not.toHaveBeenCalledWith('open_url', expect.anything())
  })

  it('does not execute or complete a job when identity changes while server start is pending', async () => {
    const started = deferred<void>()
    const { startDeviceJobChannel, stopDeviceJobChannel } = await import('@/services/deviceJobs')
    const { updateExecutionControls } = await import('@/services/executionGate')
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'p1' })
    api.startDeviceJob.mockImplementationOnce(() => started.promise)
    api.nextDeviceJob.mockResolvedValueOnce({
      data: {
        id: 'pending-start',
        status: 'queued',
        tool_profile: 'desktop.open_url',
        payload: { url: 'https://example.test' },
      },
    })
    stop = await startDeviceJobChannel()
    await vi.waitFor(() => expect(api.startDeviceJob).toHaveBeenCalledOnce())
    stopDeviceJobChannel()
    started.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(native.invoke).not.toHaveBeenCalledWith('open_url', expect.anything())
    expect(api.completeDeviceJob).not.toHaveBeenCalled()
  })
})
