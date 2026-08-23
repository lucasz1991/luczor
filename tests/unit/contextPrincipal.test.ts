import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getApiConfig: vi.fn(),
  fetch: vi.fn(),
  storeGet: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn(async () => ({ get: mocks.storeGet })),
  },
}))

vi.mock('@/services/api/luczorApi', () => ({
  getApiConfig: mocks.getApiConfig,
  fetchWithTimeout: mocks.fetch,
}))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
vi.mock('@/services/memory/luczorMemory', () => ({ luczorMemory: {} }))

import { askContext } from '@/services/contextController'

describe('context account snapshot boundary', () => {
  beforeEach(() => {
    mocks.getApiConfig.mockReset()
    mocks.storeGet.mockReset().mockResolvedValue(true)
    mocks.fetch.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({
        context_id: 'context-1',
        task_type: 'coding.fix_bug',
        budget: { max_input_tokens: 800, estimated_tokens: 0 },
        memory: [],
        instructions: [],
      }),
    })
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the same verified immutable config that produced the graph principal', async () => {
    const config = Object.freeze({
      baseUrl: 'https://verified.example',
      deviceKey: 'verified-device-key',
      clientId: 'client-1',
    })

    await askContext({
      projectId: 'project-1',
      query: 'Fix MemoryController',
      account: Object.freeze({
        principalId: 'account:v2:verified',
        serverOrigin: 'https://verified.example',
        serverInstance: 'https://verified.example',
        accountId: 7,
        config,
      }),
    })

    expect(mocks.getApiConfig).not.toHaveBeenCalled()
    expect(mocks.fetch).toHaveBeenCalledWith(
      'https://verified.example/api/v1/context/ask',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer verified-device-key' }),
      })
    )
  })
})
