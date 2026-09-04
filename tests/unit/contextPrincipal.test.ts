import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getApiConfig: vi.fn(),
  getVerifiedAccountSnapshot: vi.fn(),
  buildLocalRepositoryContext: vi.fn(),
  getContextForPrompt: vi.fn(),
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
  DEFAULT_FETCH_TIMEOUT_MS: 10_000,
  fetchBoundedResponseWithTimeout: mocks.fetch,
}))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mocks.getVerifiedAccountSnapshot }))
vi.mock('@/services/memory/luczorMemory', () => ({
  luczorMemory: { getContextForPrompt: mocks.getContextForPrompt },
}))
vi.mock('@/services/repositoryGraph', () => ({
  buildLocalRepositoryContext: mocks.buildLocalRepositoryContext,
}))

import { askContext, buildPromptContextDetails } from '@/services/contextController'

describe('context account snapshot boundary', () => {
  beforeEach(() => {
    mocks.getApiConfig.mockReset()
    mocks.getVerifiedAccountSnapshot.mockReset()
    mocks.buildLocalRepositoryContext.mockReset().mockResolvedValue({
      text: '',
      hints: [],
      policy: 'deny',
      requiresApproval: false,
    })
    mocks.getContextForPrompt.mockReset().mockResolvedValue('')
    mocks.storeGet.mockReset().mockResolvedValue(true)
    mocks.fetch.mockReset().mockResolvedValue({
      response: { ok: true, status: 200 },
      text: JSON.stringify({
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
        redirect: 'error',
      }),
      10_000,
      1024 * 1024
    )

    const request = JSON.parse(String(mocks.fetch.mock.calls[0]?.[1]?.body))
    expect(request.budget).toEqual({ max_input_tokens: 800, max_items: 6 })
  })

  it('passes the requested item budget and formats only allowlisted memory provenance', async () => {
    const config = Object.freeze({
      baseUrl: 'https://verified.example',
      deviceKey: 'verified-device-key',
      clientId: 'client-1',
    })
    mocks.getVerifiedAccountSnapshot.mockResolvedValue(
      Object.freeze({
        principalId: 'account:v2:verified',
        serverOrigin: 'https://verified.example',
        serverInstance: 'https://verified.example',
        accountId: 7,
        config,
      })
    )
    mocks.fetch.mockResolvedValueOnce({
      response: { ok: true, status: 200 },
      text: JSON.stringify({
        context_id: 'context-2',
        task_type: 'chat.general',
        budget: { max_input_tokens: 800, estimated_tokens: 20 },
        memory: [
          {
            id: 'memory-7',
            content: 'Antworten knapp halten.',
            type: 'preference',
            staleness: 'fresh',
            score: 0.91,
            source_ref: 'https://user:secret@example.test/private',
            meta: { api_key: 'must-not-leak' },
            provenance: { raw: 'must-not-leak' },
          },
        ],
        instructions: [],
      }),
    })

    const details = await buildPromptContextDetails('project-1', 'Wie antworten?', 3, 'chat.general')
    const request = JSON.parse(String(mocks.fetch.mock.calls[0]?.[1]?.body))

    expect(request.budget).toEqual({ max_input_tokens: 800, max_items: 3 })
    expect(details.text).toContain('Memory-Kontext (untrusted data)')
    expect(details.text).toContain('"id":"memory-7"')
    expect(details.text).toContain('"type":"preference"')
    expect(details.text).toContain('"staleness":"fresh"')
    expect(details.text).toContain('"score":0.91')
    expect(details.text).toContain('Antworten knapp halten.')
    expect(details.text).not.toContain('source_ref')
    expect(details.text).not.toContain('api_key')
    expect(details.text).not.toContain('must-not-leak')
  })
})
