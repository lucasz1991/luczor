import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/api/luczorApi', () => ({
  getApiConfig: vi.fn().mockResolvedValue({
    baseUrl: 'https://luczor.example',
    deviceKey: 'device-key',
    clientId: 'client-1',
  }),
  createCorrelationId: vi.fn(() => '11111111-1111-4111-8111-111111111111'),
  readBoundedResponseText: vi.fn(),
}))

import { OpenRouterService } from '@/services/openrouter.service'

describe('OpenRouterService tool choice', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
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
    await OpenRouterService.streamChatWithTools({
      messages: [{ role: 'user', content: 'Speichere das Ziel' }],
      tools: [{ type: 'function', function: { name: 'project_upsert_goal' } }],
      toolChoice: 'required',
    })

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
      OpenRouterService.streamChatWithTools({
        messages: [{ role: 'user', content: 'test' }],
      })
    ).rejects.toThrow(/zu großen Datenblock/)
  })

  it('ignores impossible tool indexes instead of allocating sparse untrusted arrays', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1000000,"function":{"name":"x","arguments":"{}"}}]},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    )

    const result = await OpenRouterService.streamChatWithTools({
      messages: [{ role: 'user', content: 'test' }],
    })

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
      OpenRouterService.streamChatWithTools({
        messages: [{ role: 'user', content: 'test' }],
      })
    ).rejects.toThrow(/upstream_stream_too_large.*HTTP 502/)
  })
})
