import { describe, expect, it, vi } from 'vitest'
vi.mock('@/services/inference/coordinator', () => ({
  resolveInferenceRouteForTurn: vi.fn(),
  packetBoundLaravelGateway: vi.fn(),
  hashInferenceEgressRequest: vi.fn(),
}))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
import { runWorkflowLlm } from '@/services/workflows/llm'
import type { InferenceRequest, InferenceResult } from '@/services/inference/types'

function fixture(overrides: Partial<InferenceResult> = {}) {
  const controller = new AbortController()
  const gateway = {
    id: 'test',
    target: 'local_llama_cpp' as const,
    streamChatWithTools: vi.fn<(request: InferenceRequest) => Promise<InferenceResult>>(async () => ({
      content: 'Ergebnis',
      toolCalls: [],
      rawToolCalls: [],
      finishReason: 'stop',
      model: 'local-model',
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      ...overrides,
    })),
  }
  const deps = {
    local: vi.fn(async () => gateway),
    external: vi.fn(async () => gateway),
    assert: vi.fn((ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted()),
  }
  return {
    deps,
    gateway,
    controller,
    context: { projectId: 'project-1', ticket: { sessionId: 'session', generation: 1, signal: controller.signal } },
  }
}
describe('bounded workflow inference', () => {
  it('uses one local call without tools or implicit context and returns reported usage', async () => {
    const { deps, gateway, context } = fixture()
    const result = await runWorkflowLlm(
      { instruction: 'Fasse zusammen', input_bindings: { notes: 'Daten' } },
      context,
      deps
    )
    expect(deps.external).not.toHaveBeenCalled()
    expect(gateway.streamChatWithTools).toHaveBeenCalledOnce()
    const request = gateway.streamChatWithTools.mock.calls[0]?.[0]
    expect(request).toMatchObject({ tools: [], toolChoice: 'none', projectId: 'project-1', taskType: 'workflow.llm' })
    expect(result).toMatchObject({ ok: true, text: 'Ergebnis', usage_source: 'reported', tokens: { totalTokens: 10 } })
  })
  it.each([
    [{ content: '' }, 'empty_output'],
    [{ finishReason: 'length' }, 'output_incomplete'],
    [{ toolCalls: [{ id: 'x', name: 'file_write', arguments: {}, rawArguments: '{}' }] }, 'unexpected_tools'],
    [{ content: 'analysis: private notes' }, 'empty_output'],
  ] as const)('rejects unusable output without a repair round', async (override, error) => {
    const { deps, gateway, context } = fixture(override as Partial<InferenceResult>)
    await expect(runWorkflowLlm({ instruction: 'Arbeiten' }, context, deps)).rejects.toThrow(error)
    expect(gateway.streamChatWithTools).toHaveBeenCalledOnce()
  })
  it('validates structured outputs and never treats invalid JSON as successful evidence', async () => {
    const { deps, context } = fixture({ content: '{"decision":"continue"}' })
    await expect(
      runWorkflowLlm(
        {
          instruction: 'Bewerte',
          output_format: 'json',
          output_schema: {
            type: 'object',
            properties: { decision: { type: 'string', enum: ['stop'] } },
            required: ['decision'],
            additionalProperties: false,
          },
        },
        context,
        deps
      )
    ).rejects.toThrow('Wert nicht erlaubt')
  })
  it('discards a late result when cancellation occurs during inference', async () => {
    const { deps, gateway, controller, context } = fixture()
    gateway.streamChatWithTools.mockImplementationOnce(async () => {
      controller.abort()
      return { content: 'late', toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
    })
    await expect(runWorkflowLlm({ instruction: 'Arbeiten' }, context, deps)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
