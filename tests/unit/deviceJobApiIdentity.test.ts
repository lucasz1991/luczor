import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ load: vi.fn(), key: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: settings.load } }))
vi.mock('@/services/secureDeviceKey', () => ({ loadDeviceKey: settings.key, saveDeviceKey: vi.fn() }))

import { LuczorApi, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'

const config = Object.freeze({
  baseUrl: 'https://approved.example.test/luczor',
  deviceKey: 'approved-device-key',
  clientId: 'device-1',
})
const result = Object.freeze({ ok: true, text: 'Approved private answer', scope: 'personal' })
const operations: Array<{
  name: string
  path: string
  body?: Record<string, unknown>
  run: (snapshot?: LuczorApiConfigSnapshot, signal?: AbortSignal) => Promise<unknown>
}> = [
  {
    name: 'next',
    path: '/devices/jobs/next?client_id=device-1',
    run: (snapshot, signal) => LuczorApi.nextDeviceJob('device-1', snapshot, signal),
  },
  {
    name: 'approve',
    path: '/devices/jobs/job-1/approve',
    body: { client_id: 'device-1', approved: true },
    run: (snapshot, signal) => LuczorApi.approveDeviceJob('job-1', 'device-1', true, undefined, snapshot, signal),
  },
  {
    name: 'start',
    path: '/devices/jobs/job-1/start',
    body: { client_id: 'device-1' },
    run: (snapshot, signal) => LuczorApi.startDeviceJob('job-1', 'device-1', snapshot, signal),
  },
  {
    name: 'complete',
    path: '/devices/jobs/job-1/complete',
    body: { client_id: 'device-1', ok: true, result },
    run: (snapshot, signal) =>
      LuczorApi.completeDeviceJob('job-1', 'device-1', true, result, undefined, snapshot, signal),
  },
]

beforeEach(() => {
  vi.resetAllMocks()
  settings.load.mockResolvedValue({
    get: vi.fn(async (key: string) =>
      key === 'luczor_api_base_url' ? 'https://changed.example.test' : 'different-device'
    ),
  })
  settings.key.mockResolvedValue('changed-device-key')
})

afterEach(() => vi.unstubAllGlobals())

describe('device-job requests retain the approved account identity', () => {
  it.each(operations)('$name uses only its captured destination and credentials', async operation => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"data":null}'))
    vi.stubGlobal('fetch', fetchMock)

    await operation.run(config)

    expect(settings.load).not.toHaveBeenCalled()
    expect(settings.key).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${config.baseUrl}/api/v1${operation.path}`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${config.deviceKey}` }),
        body: operation.body ? JSON.stringify(operation.body) : undefined,
        redirect: 'error',
      })
    )
  })

  it.each(operations)('$name never calls fetch after its channel has been invalidated', async operation => {
    const fetchMock = vi.fn(async () => new Response('{"data":null}'))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(operation.run(config, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks completion if cancellation occurs while fallback settings are loading', async () => {
    const controller = new AbortController()
    settings.load.mockImplementationOnce(async () => {
      controller.abort()
      return { get: vi.fn(async () => 'device-1') }
    })
    const fetchMock = vi.fn(async () => new Response('{"data":null}'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      LuczorApi.completeDeviceJob('job-1', 'device-1', true, result, undefined, undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
