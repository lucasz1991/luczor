import { describe, expect, it, vi } from 'vitest'
import { createClaudeMainGateway, ProviderRefusalError } from '@/services/inference/claudeGateway'
import { hashLaravelProxyBody } from '@/services/inference/laravelProxyBody'
import { LocalInferenceError } from '@/services/inference/localModelManager'
import type { InferenceRequest, InferenceResult } from '@/services/inference/types'
import { claudeRunOptions, runClaudeLedTurn, type ClaudeTurnInput } from '@/services/agents/claudeTurn'
import type { RunAgentOptions, RunAgentResult } from '@/services/agent'

const apiConfig = Object.freeze({ baseUrl: 'https://luczor.test', deviceKey: 'device-key', clientId: 'client-1' })
const answer = (patch: Partial<InferenceResult> = {}): InferenceResult => ({
  content: 'ok',
  toolCalls: [],
  rawToolCalls: [],
  finishReason: 'stop',
  ...patch,
})
const request: InferenceRequest = {
  messages: [{ role: 'user', content: 'Hallo' }],
  tools: [{ type: 'function', function: { name: 'task_list', description: '', parameters: {} } }],
  toolChoice: 'required',
  taskType: 'chat.general',
  projectId: 'p1',
}

function gateway(transport: (request: InferenceRequest) => Promise<InferenceResult>, patch = {}) {
  return createClaudeMainGateway({
    apiConfig,
    modelProfile: 'claude-opus-5-5',
    effort: 'medium',
    maxRequests: 2,
    expiresAt: 10_000,
    now: () => 1_000,
    transport: { streamChatWithTools: transport },
    ...patch,
  })
}

describe('Claude main gateway', () => {
  it('sends the chosen model, effort and task type and binds the exact bytes', async () => {
    const seen: InferenceRequest[] = []
    const result = await gateway(async value => {
      seen.push(value)
      return answer()
    }).streamChatWithTools(request)
    expect(result.content).toBe('ok')
    const sent = seen[0]!
    expect(sent).toMatchObject({
      taskType: 'chat.main',
      mainModelProfile: 'claude-opus-5-5',
      effort: 'medium',
      toolChoice: 'auto',
      expectedProxyConfig: apiConfig,
    })
    expect(sent.expectedProxyBodySha256).toBe(await hashLaravelProxyBody(sent, 'client-1', true))
    expect(Date.parse(sent.expectedProxyApprovalExpiresAt!)).toBe(10_000)
  })

  it('keeps an explicit "none" tool choice', async () => {
    const seen: InferenceRequest[] = []
    await gateway(async value => (seen.push(value), answer())).streamChatWithTools({ ...request, toolChoice: 'none' })
    expect(seen[0]!.toolChoice).toBe('none')
  })

  it('raises a refusal instead of returning partial text', async () => {
    const declined = gateway(async () =>
      answer({ content: 'Teil', finishReason: 'content_filter', refusal: { category: 'cyber', phase: 'mid_stream' } })
    ).streamChatWithTools(request)
    await expect(declined).rejects.toBeInstanceOf(ProviderRefusalError)
    await expect(declined).rejects.toMatchObject({ code: 'provider_refusal', category: 'cyber', phase: 'mid_stream' })
  })

  it('stops after the turn expired or the request ceiling is reached', async () => {
    const transport = vi.fn(async () => answer())
    await expect(gateway(transport, { now: () => 10_000 }).streamChatWithTools(request)).rejects.toMatchObject({
      code: 'claude_turn_expired',
    })
    const limited = gateway(transport)
    await limited.streamChatWithTools(request)
    await limited.streamChatWithTools(request)
    await expect(limited.streamChatWithTools(request)).rejects.toMatchObject({ code: 'claude_round_limit' })
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('maps proxy failures to fixed messages without echoing the upstream body', async () => {
    const failing = (message: string) =>
      gateway(async () => {
        throw new Error(message)
      }).streamChatWithTools(request)
    await expect(
      failing('OpenRouter HTTP 422: {"error_code":"claude_access_missing","message":"sk-ant-secret"}')
    ).rejects.toMatchObject({ code: 'claude_access_missing' })
    await expect(failing('OpenRouter HTTP 429: slow down sk-ant-secret')).rejects.toMatchObject({
      code: 'claude_rate_limited',
      retryable: true,
    })
    await expect(failing('OpenRouter HTTP 503: upstream sk-ant-secret')).rejects.toMatchObject({
      code: 'claude_unavailable',
    })
    for (const message of [
      'OpenRouter HTTP 422: {"error_code":"claude_access_missing","message":"sk-ant-secret"}',
      'OpenRouter HTTP 400: {"error":"sk-ant-secret"}',
      'OpenRouter HTTP 503: sk-ant-secret',
    ]) {
      const error: unknown = await failing(message).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(LocalInferenceError)
      expect((error as Error).message).not.toContain('sk-ant')
    }
  })
})

const result = (patch: Partial<RunAgentResult> = {}): RunAgentResult => ({
  finalText: 'Antwort',
  toolFailures: 0,
  toolSuccesses: 0,
  ephemeralDataUsed: false,
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, source: 'estimated', rounds: 0 },
  ...patch,
})
const local: RunAgentOptions = {
  projectId: 'p1',
  mode: 'act',
  baseMessages: [{ role: 'user', content: 'lokal mit privatem Kontext' }],
  agentMode: true,
  toolChoice: 'required',
  ephemeralContextUsed: true,
  localOnlyContextUsed: true,
  contextDataPolicy: 'local_only' as never,
  contextEgress: 'local_only',
  routingSettings: { preference: 'local_only', localModelId: 'orca' },
  disabledTools: ['custom_tool'],
}
function turn(patch: Partial<ClaudeTurnInput>): ClaudeTurnInput {
  return {
    local,
    externalBaseMessages: [{ role: 'user', content: 'providersicher' }],
    plan: { mode: 'claude_local', modelProfile: 'claude-opus-5-5', effort: 'high' },
    apiConfig,
    localAvailable: () => true,
    now: () => 1_000,
    ...patch,
  }
}

describe('Claude-led turn', () => {
  it('runs Claude on the provider-safe transcript without local evidence or delegation', () => {
    const options = claudeRunOptions(
      turn({}),
      gateway(async () => answer())
    )
    expect(options.baseMessages).toEqual([{ role: 'user', content: 'providersicher' }])
    expect(options).toMatchObject({
      agentMode: false,
      toolChoice: 'auto',
      ephemeralContextUsed: false,
      localOnlyContextUsed: false,
      contextDataPolicy: 'syncable',
      contextEgress: 'external_allowed',
    })
    expect(options.archivedHistory).toBeUndefined()
    expect(options.disabledTools).toEqual(expect.arrayContaining(['custom_tool', 'fs_read', 'os_screen_capture']))
    expect(options.disabledTools).not.toContain('task_list')
    expect(options.inferenceGateway?.target).toBe('laravel_proxy')
  })

  it('returns a normal Claude answer untouched', async () => {
    const run = vi.fn(async () => result({ inferenceTarget: 'laravel_proxy' }))
    const outcome = await runClaudeLedTurn(turn({ run }))
    expect(outcome).toEqual({ result: result({ inferenceTarget: 'laravel_proxy' }) })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('hands a declined turn to the local model in "Claude + lokal"', async () => {
    const order: string[] = []
    const run = vi
      .fn<(options: RunAgentOptions) => Promise<RunAgentResult>>()
      .mockImplementationOnce(async () => {
        order.push('claude')
        throw new ProviderRefusalError('cyber', 'before_output')
      })
      .mockImplementationOnce(async options => {
        order.push('local')
        expect(options.inferenceGateway).toBeUndefined()
        expect(options.baseMessages).toBe(local.baseMessages)
        expect(options).toMatchObject({ contextEgress: 'local_only', routingSettings: { preference: 'local_only' } })
        return result({ inferenceTarget: 'local_llama_cpp', finalText: 'lokal' })
      })
    const outcome = await runClaudeLedTurn(turn({ run, onLocalTakeover: () => void order.push('takeover') }))
    expect(order).toEqual(['claude', 'takeover', 'local'])
    expect(outcome.handoff).toEqual({ state: 'taken', category: 'cyber' })
    expect(outcome.result.finalText).toBe('lokal')
  })

  it('only offers the hand-over in "Nur Claude" and when no local model is ready', async () => {
    const refuse = async () => {
      throw new ProviderRefusalError(undefined, 'before_output')
    }
    for (const patch of [
      { plan: { mode: 'claude' as const, modelProfile: 'm', effort: 'low' as const } },
      { localAvailable: () => false },
    ]) {
      const run = vi.fn(refuse)
      const takeover = vi.fn()
      const outcome = await runClaudeLedTurn(turn({ run, onLocalTakeover: takeover, ...patch }))
      expect(outcome.handoff).toEqual({ state: 'offered' })
      expect(outcome.result).toMatchObject({ finalText: '', inferenceTarget: 'laravel_proxy' })
      expect(run).toHaveBeenCalledTimes(1)
      expect(takeover).not.toHaveBeenCalled()
    }
  })

  it('does not restart a turn in which Claude already executed tools', async () => {
    const run = vi.fn(async () =>
      result({
        toolSuccesses: 2,
        finalText: 'intern',
        continuation: {} as never,
        interrupted: { code: 'provider_refusal', message: 'x' },
      })
    )
    const outcome = await runClaudeLedTurn(turn({ run }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(outcome.handoff).toBeUndefined()
    expect(outcome.result.continuation).toBeDefined()
    expect(outcome.result.finalText).toContain('Weiterarbeiten')
  })

  it('reports a failed local hand-over as an offer and rethrows other Claude errors', async () => {
    const run = vi
      .fn<(options: RunAgentOptions) => Promise<RunAgentResult>>()
      .mockRejectedValueOnce(new ProviderRefusalError('bio', 'before_output'))
      .mockRejectedValueOnce(new LocalInferenceError('Kein lokales Modell bereit.', 'local_only_blocked', false, false))
    const outcome = await runClaudeLedTurn(turn({ run }))
    expect(outcome.handoff).toEqual({ state: 'offered', category: 'bio', localFailure: 'Kein lokales Modell bereit.' })

    const failure = new LocalInferenceError('Limit', 'claude_rate_limited', true, false)
    await expect(runClaudeLedTurn(turn({ run: vi.fn().mockRejectedValue(failure) }))).rejects.toBe(failure)
  })
})
