import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSystemStatusMonitor, percent } from '@/services/systemStatusMonitor'
import type { SystemMetrics } from '@/services/systemMetrics'

const metrics = (changes: Partial<SystemMetrics> = {}): SystemMetrics => ({
  cpu_percent: 12,
  ram_percent: 50,
  ram_used_mb: 8_192,
  ram_total_mb: 16_384,
  gpu_percent: 30,
  cpu_temp_c: null,
  gpu_temp_c: 52,
  ...changes,
})

const unavailableScopes = () => ({
  app: { cpu: null, ram: null, gpu: null },
  model: { cpu: null, ram: null, gpu: null },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const monitors: ReturnType<typeof createSystemStatusMonitor>[] = []
const createMonitor = (options: Parameters<typeof createSystemStatusMonitor>[0]) => {
  const monitor = createSystemStatusMonitor(options)
  monitors.push(monitor)
  return monitor
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
})
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.dispose()
  vi.useRealTimers()
})

describe('system status telemetry values', () => {
  it('tracks SSD activity separately from process scopes and keeps missing counter gaps', async () => {
    const disk = {
      mount: 'E:',
      kind: 'ssd' as const,
      total_bytes: 1000,
      used_bytes: 420,
      busy_percent: 0,
      read_percent: null,
      write_percent: 15,
    }
    const read = vi
      .fn()
      .mockResolvedValueOnce(metrics({ disk }))
      .mockResolvedValueOnce(metrics({ disk: null }))
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    await monitor.refresh()
    disk.used_bytes = 900
    expect(monitor.state.sample?.disk?.used_bytes).toBe(420)
    expect(monitor.state.history[0]?.disk).toEqual({ busy: 0, read: null, write: 15 })
    await monitor.refresh()
    expect(monitor.state.sample?.disk).toBeNull()
    expect(monitor.state.history[1]?.disk).toBeUndefined()
  })

  it.each([null, undefined, NaN, Infinity, -Infinity, '', '20', {}, true])('keeps %j unavailable', value => {
    expect(percent(value)).toBeNull()
  })

  it('preserves zero and clamps measured percentages without converting strings', () => {
    expect(percent(0)).toBe(0)
    expect(percent(17.25)).toBe(17.25)
    expect(percent(-4)).toBe(0)
    expect(percent(110)).toBe(100)
  })
})

describe('system status process scopes', () => {
  it('retains independently measured total, app, and model values on a shared scale', async () => {
    const monitor = createMonitor({
      read: async () =>
        metrics({
          app_cpu_percent: 2,
          app_ram_percent: 3,
          app_ram_used_mb: 491.52,
          app_gpu_percent: 4,
          model_cpu_percent: 7,
          model_ram_percent: 20,
          model_ram_used_mb: 3_276.8,
          model_gpu_percent: 25,
          model_running: true,
        }),
    })
    monitor.setActive(true)
    await monitor.refresh()
    expect(monitor.state.history[0]).toEqual({
      at: Date.now(),
      cpu: 12,
      ram: 50,
      gpu: 30,
      app: { cpu: 2, ram: 3, gpu: 4 },
      model: { cpu: 7, ram: 20, gpu: 25 },
    })
    expect(monitor.state.sample).toMatchObject({
      app_ram_used_mb: 491.52,
      model_ram_used_mb: 3_276.8,
      model_running: true,
    })
  })

  it('preserves measured zeros separately from unsupported process counters', async () => {
    const monitor = createMonitor({
      read: async () =>
        metrics({
          app_cpu_percent: 0,
          app_ram_percent: 0,
          app_ram_used_mb: 0,
          app_gpu_percent: null,
          model_cpu_percent: 0,
          model_ram_percent: 0,
          model_ram_used_mb: 0,
          model_gpu_percent: 0,
          model_running: true,
        }),
    })
    monitor.setActive(true)
    await monitor.refresh()
    expect(monitor.state.history[0]).toMatchObject({
      app: { cpu: 0, ram: 0, gpu: null },
      model: { cpu: 0, ram: 0, gpu: 0 },
    })
    expect(monitor.state.sample).toMatchObject({ app_ram_used_mb: 0, model_ram_used_mb: 0 })
  })

  it('does not derive missing app or model data from total utilization or memory', async () => {
    const monitor = createMonitor({
      read: async () => metrics({ model_running: true, model_ram_used_mb: 8_192 }),
    })
    monitor.setActive(true)
    await monitor.refresh()
    expect(monitor.state.history[0]).toMatchObject(unavailableScopes())
    expect(monitor.state.sample).toMatchObject({
      app_cpu_percent: null,
      app_ram_percent: null,
      app_gpu_percent: null,
      model_cpu_percent: null,
      model_ram_percent: null,
      model_gpu_percent: null,
      model_ram_used_mb: 8_192,
    })
  })

  it('normalizes non-finite process counters without discarding other measured scopes', async () => {
    const monitor = createMonitor({
      read: async () =>
        metrics({
          app_cpu_percent: NaN,
          app_ram_percent: 110,
          app_ram_used_mb: Infinity,
          app_gpu_percent: 1,
          model_cpu_percent: 2,
          model_ram_percent: Infinity,
          model_ram_used_mb: -1,
          model_gpu_percent: NaN,
        }),
    })
    monitor.setActive(true)
    await monitor.refresh()
    expect(monitor.state.history[0]).toMatchObject({
      cpu: 12,
      ram: 50,
      gpu: 30,
      app: { cpu: null, ram: 100, gpu: 1 },
      model: { cpu: 2, ram: null, gpu: null },
    })
    expect(monitor.state.sample).toMatchObject({ app_ram_used_mb: null, model_ram_used_mb: null, model_running: null })
  })

  it('clears current model data when the process stops while retaining its earlier measurements', async () => {
    const modelValues = {
      model_cpu_percent: 5,
      model_ram_percent: 10,
      model_ram_used_mb: 1_638.4,
      model_gpu_percent: 20,
    }
    const read = vi
      .fn()
      .mockResolvedValueOnce(metrics({ ...modelValues, model_running: true, app_cpu_percent: 2 }))
      .mockResolvedValueOnce(metrics({ ...modelValues, model_running: false, app_cpu_percent: 3 }))
      .mockResolvedValueOnce(metrics({ model_running: true, app_cpu_percent: 4 }))
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    await monitor.refresh()
    expect(monitor.state.history[0]?.model).toEqual({ cpu: 5, ram: 10, gpu: 20 })
    await vi.advanceTimersByTimeAsync(3_500)
    expect(monitor.state.sample).toMatchObject({
      model_running: false,
      model_cpu_percent: null,
      model_ram_percent: null,
      model_ram_used_mb: null,
      model_gpu_percent: null,
    })
    expect(monitor.state.history[1]).toMatchObject({
      cpu: 12,
      app: { cpu: 3 },
      model: { cpu: null, ram: null, gpu: null },
    })
    expect(monitor.state.history[0]?.model).toEqual({ cpu: 5, ram: 10, gpu: 20 })
    await vi.advanceTimersByTimeAsync(3_500)
    expect(monitor.state.sample).toMatchObject({
      model_running: true,
      model_cpu_percent: null,
      model_ram_percent: null,
      model_gpu_percent: null,
    })
    expect(monitor.state.history[2]?.model).toEqual({ cpu: null, ram: null, gpu: null })
  })

  it('records a gap for every scope on errors and recovers without bridging missing process values', async () => {
    const original = metrics({ app_cpu_percent: 2, model_cpu_percent: 5, model_running: true })
    const read = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error('PRIVATE_PROCESS_DATA'))
      .mockResolvedValueOnce(metrics({ app_cpu_percent: 3, model_running: null }))
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    await monitor.refresh()
    await vi.advanceTimersByTimeAsync(3_500)
    expect(monitor.state.availability).toBe('stale')
    expect(monitor.state.sample).toMatchObject(original)
    expect(monitor.state.history[1]).toEqual({
      at: Date.now(),
      cpu: null,
      ram: null,
      gpu: null,
      ...unavailableScopes(),
    })
    await vi.advanceTimersByTimeAsync(3_500)
    expect(monitor.state.history[2]).toMatchObject({
      cpu: 12,
      app: { cpu: 3 },
      model: { cpu: null, ram: null, gpu: null },
    })
    expect(JSON.stringify(monitor.state)).not.toContain('PRIVATE_PROCESS_DATA')
  })
})

describe('system status monitor', () => {
  it('starts with no synthetic data and reads only while active', async () => {
    const read = vi.fn().mockResolvedValue(metrics({ cpu_percent: 0, gpu_percent: null }))
    const monitor = createMonitor({ read })
    expect(monitor.state).toEqual({ sample: null, history: [], availability: 'idle', lastUpdatedAt: null })
    await monitor.refresh()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).not.toHaveBeenCalled()

    monitor.setActive(true)
    expect(monitor.state.availability).toBe('loading')
    await monitor.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    expect(monitor.state.availability).toBe('live')
    expect(monitor.state.lastUpdatedAt).toBe(Date.now())
    expect(monitor.state.history).toEqual([{ at: Date.now(), cpu: 0, ram: 50, gpu: null, ...unavailableScopes() }])
  })

  it('polls at 3.5 second intervals and retains at most 40 actual samples', async () => {
    const read = vi.fn().mockResolvedValue(metrics())
    const monitor = createMonitor({ read, maxHistory: 500 })
    const start = Date.now()
    monitor.setActive(true)
    await monitor.refresh()
    await vi.advanceTimersByTimeAsync(3_499)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3_500 * 43)
    expect(read).toHaveBeenCalledTimes(45)
    expect(monitor.state.history).toHaveLength(40)
    expect(monitor.state.history[0]?.at).toBe(start + 3_500 * 5)
    expect(monitor.state.history[39]?.at).toBe(start + 3_500 * 44)
  })

  it('marks a failed initial sample unavailable and records a gap without error payloads', async () => {
    const monitor = createMonitor({
      read: async () => {
        throw new Error('PRIVATE_NATIVE_DATA')
      },
    })
    monitor.setActive(true)
    await monitor.refresh()
    expect(monitor.state).toEqual({
      sample: null,
      history: [{ at: Date.now(), cpu: null, ram: null, gpu: null, ...unavailableScopes() }],
      availability: 'unavailable',
      lastUpdatedAt: null,
    })
    expect(JSON.stringify(monitor.state)).not.toContain('PRIVATE_NATIVE_DATA')
  })

  it('keeps the last successful sample visibly stale through failure and resumes with a new sample', async () => {
    const original = metrics()
    const read = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce(metrics({ cpu_percent: 20, gpu_percent: null }))
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    await monitor.refresh()
    const updatedAt = monitor.state.lastUpdatedAt
    await vi.advanceTimersByTimeAsync(3_500)
    expect(monitor.state.availability).toBe('stale')
    expect(monitor.state.sample).toMatchObject(original)
    expect(monitor.state.lastUpdatedAt).toBe(updatedAt)
    expect(monitor.state.history[1]).toEqual({
      at: Date.now(),
      cpu: null,
      ram: null,
      gpu: null,
      ...unavailableScopes(),
    })
    await vi.advanceTimersByTimeAsync(3_500)
    expect(monitor.state.availability).toBe('live')
    expect(monitor.state.lastUpdatedAt).toBe(Date.now())
    expect(monitor.state.history[2]).toEqual({ at: Date.now(), cpu: 20, ram: 50, gpu: null, ...unavailableScopes() })
  })

  it('normalizes missing and non-finite metric values into history gaps', async () => {
    const monitor = createMonitor({
      read: async () => metrics({ cpu_percent: NaN, ram_percent: 110, gpu_percent: Infinity }),
    })
    monitor.setActive(true)
    await monitor.refresh()
    expect(monitor.state.history).toEqual([{ at: Date.now(), cpu: null, ram: 100, gpu: null, ...unavailableScopes() }])
  })

  it('never overlaps native calls and schedules the next poll after settlement', async () => {
    const pending = deferred<SystemMetrics>()
    const read = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(metrics())
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    const first = monitor.refresh()
    const second = monitor.refresh()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(metrics())
    await first
    await vi.advanceTimersByTimeAsync(3_500)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('pauses polling when hidden and marks retained data stale when reopening', async () => {
    const pending = deferred<SystemMetrics>()
    const read = vi.fn().mockResolvedValueOnce(metrics()).mockReturnValueOnce(pending.promise)
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    await monitor.refresh()
    monitor.setActive(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(monitor.state.availability).toBe('idle')
    await vi.advanceTimersByTimeAsync(10_000)
    await monitor.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    monitor.setActive(true)
    expect(monitor.state.availability).toBe('stale')
    pending.resolve(metrics({ cpu_percent: 55 }))
    await monitor.refresh()
    expect(monitor.state.availability).toBe('live')
    expect(monitor.state.sample?.cpu_percent).toBe(55)
  })

  it('discards a closed-view result and waits for it before sampling the reopened view', async () => {
    const old = deferred<SystemMetrics>()
    const fresh = deferred<SystemMetrics>()
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    const outdatedRead = monitor.refresh()
    await vi.advanceTimersByTimeAsync(0)
    monitor.setActive(false)
    monitor.setActive(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(1)
    old.resolve(metrics({ cpu_percent: 99 }))
    await outdatedRead
    expect(read).toHaveBeenCalledTimes(2)
    expect(monitor.state.history).toEqual([])
    expect(monitor.state.sample).toBeNull()
    const newRead = monitor.refresh()
    fresh.resolve(metrics({ cpu_percent: 18 }))
    await newRead
    expect(monitor.state.sample?.cpu_percent).toBe(18)
    expect(monitor.state.history).toHaveLength(1)
  })

  it('ignores late failures after deactivation', async () => {
    const pending = deferred<SystemMetrics>()
    const monitor = createMonitor({ read: () => pending.promise })
    monitor.setActive(true)
    const request = monitor.refresh()
    await vi.advanceTimersByTimeAsync(0)
    monitor.setActive(false)
    pending.reject(new Error('Late error'))
    await request
    expect(monitor.state.availability).toBe('idle')
    expect(monitor.state.history).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not invoke when the view closes before the scheduled read begins', async () => {
    const read = vi.fn().mockResolvedValue(metrics())
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    const request = monitor.refresh()
    monitor.setActive(false)
    await request
    expect(read).not.toHaveBeenCalled()
    expect(monitor.state.history).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears timers on dispose and cannot restart or receive pending data', async () => {
    const pending = deferred<SystemMetrics>()
    const read = vi.fn().mockResolvedValueOnce(metrics()).mockReturnValueOnce(pending.promise)
    const monitor = createMonitor({ read })
    monitor.setActive(true)
    await monitor.refresh()
    expect(vi.getTimerCount()).toBe(1)
    const request = monitor.refresh()
    await vi.advanceTimersByTimeAsync(0)
    monitor.dispose()
    pending.resolve(metrics({ cpu_percent: 99 }))
    await request
    monitor.setActive(true)
    await monitor.refresh()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(monitor.state.availability).toBe('idle')
    expect(monitor.state.sample?.cpu_percent).toBe(12)
    expect(monitor.state.history).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
