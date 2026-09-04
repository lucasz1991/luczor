import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getApiConfig: vi.fn(),
}))

vi.mock('@/services/api/luczorApi', () => ({
  getApiConfig: apiMocks.getApiConfig,
  createCorrelationId: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
  readBoundedResponseText: vi.fn(),
}))

import { OpenRouterService } from '@/services/openrouter.service'
import {
  buildLaravelProxyBody,
  hashLaravelProxyBody,
  hashSerializedLaravelProxyBody,
  serializeLaravelProxyBody,
} from '@/services/inference/laravelProxyBody'
import type { InferenceRequest } from '@/services/inference/types'

async function approved(request: InferenceRequest, clientId = 'client-1'): Promise<InferenceRequest> {
  return {
    ...request,
    expectedProxyBodySha256: await hashLaravelProxyBody(request, clientId),
    expectedProxyConfig: {
      baseUrl: 'https://luczor.example',
      deviceKey: 'device-key',
      clientId,
    },
    expectedProxyApprovalExpiresAt: '2099-01-01T00:00:00Z',
  }
}

describe('OpenRouterService tool choice', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    apiMocks.getApiConfig.mockReset()
    apiMocks.getApiConfig.mockResolvedValue({
      baseUrl: 'https://luczor.example',
      deviceKey: 'device-key',
      clientId: 'client-1',
    })
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('sends required for an explicit execution round', async () => {
    await OpenRouterService.streamChatWithTools(
      await approved({
        messages: [{ role: 'user', content: 'Speichere das Ziel' }],
        tools: [{ type: 'function', function: { name: 'project_upsert_goal' } }],
        toolChoice: 'required',
      })
    )

    const request = fetchMock.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(String(request.body))
    expect(body.tool_choice).toBe('required')
    expect(body.tools[0].function.name).toBe('project_upsert_goal')
    expect((request.headers as Record<string, string>)['X-Luczor-Correlation-Id']).toBe(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('rejects an oversized streaming data block while it is being read', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(`data: ${'x'.repeat(1024 * 1024 + 1)}`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )

    await expect(
      OpenRouterService.streamChatWithTools(
        await approved({
          messages: [{ role: 'user', content: 'test' }],
        })
      )
    ).rejects.toThrow(/zu großen Datenblock/)
  })

  it('ignores impossible tool indexes instead of allocating sparse untrusted arrays', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1000000,"function":{"name":"x","arguments":"{}"}}]},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    )

    const result = await OpenRouterService.streamChatWithTools(
      await approved({
        messages: [{ role: 'user', content: 'test' }],
      })
    )

    expect(result.rawToolCalls).toEqual([])
  })

  it('surfaces a canonical proxy error emitted after a stream has started', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"content":"Teilantwort"}}]}\n\n' +
          'data: {"error":{"message":"Provider stream exceeded the gateway size limit.","code":"upstream_stream_too_large","status":502}}\n\n' +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    )

    await expect(
      OpenRouterService.streamChatWithTools(
        await approved({
          messages: [{ role: 'user', content: 'test' }],
        })
      )
    ).rejects.toThrow(/upstream_stream_too_large.*HTTP 502/)
  })

  it('rejects a truncated proxy stream without DONE or finish marker', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('data: {"choices":[{"delta":{"content":"Teilantwort"}}]}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )

    await expect(
      OpenRouterService.streamChatWithTools(await approved({ messages: [{ role: 'user', content: 'test' }] }))
    ).rejects.toThrow(/ohne terminalen Abschlussmarker/)
  })

  it('hashes the exact canonical bytes sent to Laravel including stream, client and optional metadata', async () => {
    const request: InferenceRequest = {
      messages: [{ role: 'user', content: 'Plane lokal sicher' }],
      tools: [{ type: 'function', function: { name: 'project_get_state' } }],
      toolChoice: 'required',
      projectId: 'project-1',
      taskType: 'planning',
      contextId: 'context-1',
      repoId: 'repo-1',
      branch: 'feature/local',
      commitSha: 'abc123',
      inputSource: 'keyboard',
    }
    const expectedHash = await hashLaravelProxyBody(request, 'client-1')
    await OpenRouterService.streamChatWithTools(await approved(request))

    const sent = String((fetchMock.mock.calls[0]![1] as RequestInit).body)
    expect(sent).toBe(serializeLaravelProxyBody(buildLaravelProxyBody(request, 'client-1', true)))
    expect(await hashSerializedLaravelProxyBody(sent)).toBe(expectedHash)
    expect(JSON.parse(sent)).toMatchObject({
      stream: true,
      client_id: 'client-1',
      project_id: 'project-1',
      task_type: 'planning',
      context_id: 'context-1',
      repo_id: 'repo-1',
      branch: 'feature/local',
      commit_sha: 'abc123',
      input_source: 'keyboard',
      tool_choice: 'required',
    })
  })

  it('omits empty tools and tool choice from both approval and final bytes', async () => {
    const request: InferenceRequest = {
      messages: [{ role: 'user', content: 'Nur eine Antwort' }],
      tools: [],
      toolChoice: 'none',
    }
    await OpenRouterService.streamChatWithTools(await approved(request))
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))
    expect(body).toMatchObject({ stream: true, client_id: 'client-1', task_type: 'chat.general' })
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
  })

  it('blocks destination/config changes and arbitrary request mutations after approval before fetch', async () => {
    const request: InferenceRequest = {
      messages: [{ role: 'user', content: 'Freigegebener Text' }],
      projectId: 'project-1',
    }
    const expectedProxyBodySha256 = await hashLaravelProxyBody(request, 'client-1')
    apiMocks.getApiConfig.mockResolvedValueOnce({
      baseUrl: 'https://other.example',
      deviceKey: 'other-device-key',
      clientId: 'client-1',
    })
    await expect(
      OpenRouterService.streamChatWithTools({
        ...request,
        expectedProxyBodySha256,
        expectedProxyConfig: {
          baseUrl: 'https://luczor.example',
          deviceKey: 'device-key',
          clientId: 'client-1',
        },
        expectedProxyApprovalExpiresAt: '2099-01-01T00:00:00Z',
      })
    ).rejects.toThrow(/Server-\/Geräteidentität/)
    expect(fetchMock).not.toHaveBeenCalled()

    apiMocks.getApiConfig.mockResolvedValueOnce({
      baseUrl: 'https://luczor.example',
      deviceKey: 'device-key',
      clientId: 'client-1',
    })
    await expect(
      OpenRouterService.streamChatWithTools({
        ...request,
        messages: [{ role: 'user', content: 'Nachträglich verändert' }],
        expectedProxyBodySha256,
        expectedProxyConfig: {
          baseUrl: 'https://luczor.example',
          deviceKey: 'device-key',
          clientId: 'client-1',
        },
        expectedProxyApprovalExpiresAt: '2099-01-01T00:00:00Z',
      })
    ).rejects.toThrow(/finalen Proxy-Bytes/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects proxy requests without packet-bound approval', async () => {
    await expect(
      OpenRouterService.streamChatWithTools({ messages: [{ role: 'user', content: 'test' }] })
    ).rejects.toThrow(/Server-\/Geräteidentität|paketgebundene Freigabe/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rechecks approval expiry immediately before fetch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T12:30:00Z'))
    const request = await approved({ messages: [{ role: 'user', content: 'test' }] })
    request.expectedProxyApprovalExpiresAt = '2026-08-30T12:31:00Z'
    vi.setSystemTime(new Date('2026-08-30T12:31:01Z'))
    await expect(OpenRouterService.streamChatWithTools(request)).rejects.toThrow(/paketgebundene Freigabe/)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('blocks when approval expires during the asynchronous config lookup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T12:30:00Z'))
    const config = {
      baseUrl: 'https://luczor.example',
      deviceKey: 'device-key',
      clientId: 'client-1',
    }
    apiMocks.getApiConfig.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-08-30T12:31:01Z'))
      return config
    })
    const request = await approved({ messages: [{ role: 'user', content: 'test' }] })
    request.expectedProxyApprovalExpiresAt = '2026-08-30T12:31:00Z'
    await expect(OpenRouterService.streamChatWithTools(request)).rejects.toThrow(/paketgebundene Freigabe/)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
