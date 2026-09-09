import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModelReleaseManifest } from '@/services/inference/modelManifest'
import type { LocalRuntimeRequest } from '@/services/inference/localModelManager'

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  },
}))

import {
  beginNativeManifestAcceptance,
  getNativeHardwareSnapshot,
  prepareNativeLocalModel,
  TauriLocalRuntimeTransport,
  controlLocalReasoning,
} from '@/services/inference/tauriLocalRuntime'

const catalogBinding = {
  acceptanceSessionId: '00000000-0000-4000-8000-000000000001',
  acceptanceGeneration: 7,
  manifestPayloadSha256: 'a'.repeat(64),
} as const

describe('Tauri local runtime catalog boundary', () => {
  it('binds live controls to active catalog and generation, drops late progress, and removes the old implicit 2048 cap', async () => {
    let finish!: (value: unknown) => void
    let channel!: { onmessage: (event: unknown) => void }
    const event = {
      type: 'budget',
      requestId: 'budget-request',
      tier: 'ultra',
      phase: 'thinking',
      generatedTokens: 7200,
      softTargetTokens: 8192,
      thinkingLimitTokens: 16384,
      requestedThinkingLimitTokens: 65536,
      outputLimitTokens: 32700,
      responseReserveTokens: 16384,
      warning: true,
      canExtend: false,
      canAnswer: true,
      answerRequested: false,
      elapsedMs: 4000,
      sequence: 7,
    }
    const onBudget = vi.fn()
    tauri.invoke.mockImplementation((command, args) => {
      if (command === 'local_model_infer') {
        channel = args.onEvent
        channel.onmessage({ ...event, reasoningContent: 'PRIVATE' })
        return new Promise(resolve => {
          finish = resolve
        })
      }
      if (command === 'local_model_reasoning_control')
        return Promise.resolve({ ...event, sequence: 8, answerRequested: true, controlOutcome: 'applied' })
      throw new Error('Unexpected command')
    })
    const running = new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, {
      requestId: 'budget-request',
      modelReleaseId: 'model-1',
      scopeDigest: 'd'.repeat(64),
      catalogBinding,
      messages: [{ role: 'user', content: 'Test' }],
      thinkingTier: 'ultra',
      onBudget,
    })
    expect(tauri.invoke.mock.calls[0]?.[1].request.maxOutputTokens).toBeUndefined()
    expect(tauri.invoke.mock.calls[0]?.[1].request.thinkingTier).toBe('ultra')
    expect(JSON.stringify(onBudget.mock.calls)).not.toContain('PRIVATE')
    channel.onmessage({ ...event, sequence: 6 })
    expect(onBudget).toHaveBeenCalledTimes(1)
    await controlLocalReasoning('budget-request', 'answer', 7)
    expect(tauri.invoke).toHaveBeenLastCalledWith('local_model_reasoning_control', {
      requestId: 'budget-request',
      action: 'answer',
      expectedSequence: 7,
      catalogBinding,
    })
    expect(onBudget).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'thinking', answerRequested: true }))
    finish({ requestId: 'budget-request', content: 'Public', rawToolCalls: [], finishReason: 'stop' })
    await running
    expect(onBudget).toHaveBeenLastCalledWith(null)
    const count = onBudget.mock.calls.length
    channel.onmessage({ ...event, sequence: 100 })
    expect(onBudget).toHaveBeenCalledTimes(count)
    await expect(controlLocalReasoning('budget-request', 'more', 8)).rejects.toThrow('nicht mehr')
  })
  it.each(['off', 'auto', undefined] as const)(
    'serializes local reasoning mode %s into native inference without changing output/context limits',
    async reasoningMode => {
      await new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, {
        requestId: 'request-1',
        modelReleaseId: 'model-1',
        scopeDigest: 'd'.repeat(64),
        catalogBinding,
        messages: [{ role: 'user', content: 'Plane drei kurze, überprüfbare Schritte.' }],
        reasoningMode,
        maxOutputTokens: 2048,
        contextLimit: 32768,
      })
      expect(tauri.invoke).toHaveBeenCalledWith(
        'local_model_infer',
        expect.objectContaining({
          request: expect.objectContaining({
            reasoningMode: reasoningMode ?? 'auto',
            maxOutputTokens: 2048,
            contextLimit: 32768,
          }),
        })
      )
      expect(tauri.invoke.mock.calls.map(([command]) => command)).toEqual(['local_model_infer'])
    }
  )
  it('connects public stream and final reported telemetry to the analysis without retaining private channels', async () => {
    localModelDiagnostics.clear()
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      args.onEvent.onmessage({ type: 'delta', requestId: 'different-request', content: 'wrong run' })
      args.onEvent.onmessage({ type: 'delta', requestId: 'request-1', content: '<think>private</think>Public' })
      expect(localModelDiagnostics.state.runs[0]?.output).toBe('Public')
      return {
        content: '<think>private</think>Public answer',
        rawToolCalls: [],
        finishReason: 'stop',
        requestId: 'request-1',
        usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
        diagnostics: { cachedTokens: 0, outputTokensPerSecond: 12.5 },
      }
    })
    await new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, {
      requestId: 'request-1',
      modelReleaseId: 'model-1',
      scopeDigest: 'd'.repeat(64),
      catalogBinding,
      messages: [{ role: 'user', content: 'private input' }],
    })
    expect(localModelDiagnostics.state.runs[0]).toMatchObject({
      output: 'Public answer',
      state: 'done',
      usage: { inputTokens: 40, outputTokens: 8 },
      runtime: { cachedTokens: 0, outputTokensPerSecond: 12.5 },
    })
    expect(JSON.stringify(localModelDiagnostics.state)).not.toContain('private')
  })

  it('shares concurrent hardware scans, isolates results, and refreshes on the next call', async () => {
    let complete!: (value: unknown) => void
    tauri.invoke.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve
        })
    )
    const first = getNativeHardwareSnapshot()
    const second = getNativeHardwareSnapshot()
    expect(tauri.invoke).toHaveBeenCalledOnce()
    complete({ snapshotId: 'first', memory: { availableBytes: 1 } })
    const [left, right] = await Promise.all([first, second])
    left.memory.availableBytes = 2
    expect(right.memory.availableBytes).toBe(1)
    tauri.invoke.mockResolvedValueOnce({ snapshotId: 'next' })
    await expect(getNativeHardwareSnapshot()).resolves.toMatchObject({ snapshotId: 'next' })
    expect(tauri.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not keep a rejected hardware scan for subsequent requests', async () => {
    tauri.invoke.mockRejectedValueOnce(new Error('scan failed'))
    const first = getNativeHardwareSnapshot()
    const second = getNativeHardwareSnapshot()
    await expect(first).rejects.toThrow('scan failed')
    await expect(second).rejects.toThrow('scan failed')
    tauri.invoke.mockResolvedValueOnce({ snapshotId: 'recovered' })
    await expect(getNativeHardwareSnapshot()).resolves.toMatchObject({ snapshotId: 'recovered' })
    expect(tauri.invoke).toHaveBeenCalledTimes(2)
  })

  it('renews only a resident runtime within a turn without enabling a cold prepare', async () => {
    tauri.invoke.mockResolvedValueOnce({ ready: true })
    await new TauriLocalRuntimeTransport().prepare('model-1', catalogBinding)
    expect(tauri.invoke).toHaveBeenCalledWith('local_model_prepare', {
      modelReleaseId: 'model-1',
      catalogBinding,
      residentOnly: true,
      resourceRevision: 0,
    })
  })

  it.each([true, false])('classifies tool contract rejection without losing residency (event: %s)', async withEvent => {
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      if (withEvent) {
        args.onEvent.onmessage({ type: 'error', code: 'runtime_tool_contract_rejected', retryable: false })
        throw 'private raw tool arguments'
      }
      throw 'Local llama.cpp rejected the tool contract (HTTP 500).'
    })
    await expect(
      new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, {
        requestId: 'request-1',
        modelReleaseId: 'model-1',
        scopeDigest: 'd'.repeat(64),
        catalogBinding,
        messages: [{ role: 'user', content: 'test' }],
      })
    ).rejects.toMatchObject({
      code: 'runtime_tool_contract_rejected',
      retryable: false,
      message: expect.stringContaining('Modell bleibt geladen'),
    })
  })

  it.each([true, false])('classifies role rejection without exposing native text (event: %s)', async withEvent => {
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      if (withEvent) {
        args.onEvent.onmessage({ type: 'error', code: 'runtime_chat_history_rejected', retryable: false })
        throw 'sensitive template and prompt text'
      }
      throw 'Local llama.cpp rejected the conversation role order in its chat template (HTTP 500).'
    })
    await expect(
      new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, {
        requestId: 'request-1',
        modelReleaseId: 'model-1',
        scopeDigest: 'd'.repeat(64),
        catalogBinding,
        messages: [{ role: 'user', content: 'test' }],
      })
    ).rejects.toMatchObject({
      code: 'runtime_chat_history_rejected',
      retryable: false,
      message: expect.stringContaining('Modell bleibt geladen'),
    })
  })

  it('preserves measured context usage and classifies oversized input without leaking native errors', async () => {
    const request: LocalRuntimeRequest = {
      requestId: 'request-1',
      modelReleaseId: 'model-1',
      scopeDigest: 'd'.repeat(64),
      catalogBinding,
      messages: [{ role: 'user', content: 'test' }],
    }
    const transport = new TauriLocalRuntimeTransport()
    const contextUsage = {
      inputTokens: 1234,
      contextTokens: 32768,
      outputTokens: 2048,
      omittedMessages: 2,
      shortenedToolResults: 0,
    }
    tauri.invoke.mockResolvedValueOnce({
      content: 'ok',
      rawToolCalls: [],
      finishReason: 'stop',
      requestId: 'request-1',
      contextUsage,
      usage: { inputTokens: 1234, outputTokens: 7, totalTokens: 1241 },
    })
    await expect(transport.stream({} as LocalModelReleaseManifest, request)).resolves.toMatchObject({
      contextUsage,
      usage: { inputTokens: 1234, outputTokens: 7, totalTokens: 1241 },
    })
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      args.onEvent.onmessage({ type: 'error', code: 'runtime_context_exceeded', retryable: false })
      throw 'sensitive raw native text'
    })
    await expect(transport.stream({} as LocalModelReleaseManifest, request)).rejects.toMatchObject({
      code: 'runtime_context_exceeded',
      retryable: false,
      message: expect.stringContaining('Modell bleibt geladen'),
    })
  })

  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.invoke.mockImplementation(async command => {
      if (command === 'local_model_get_resource_config') {
        return { appliedRevision: 4, revision: 4, pending: false }
      }
      if (command === 'local_model_prepare') {
        return {
          modelReleaseId: 'model-1',
          manifestPayloadSha256: catalogBinding.manifestPayloadSha256,
          artifactSha256: 'b'.repeat(64),
          runtimeSha256: 'c'.repeat(64),
          ready: true,
          verifiedAtMs: 1,
          validUntilMs: 2,
        }
      }
      if (command === 'local_model_infer') {
        return {
          content: 'ok',
          rawToolCalls: [],
          finishReason: 'stop',
          requestId: 'request-1',
        }
      }
      return undefined
    })
  })

  it('registers before generation reset and binds every mutating runtime command', async () => {
    const sessionId = await beginNativeManifestAcceptance(7)
    expect(sessionId).toMatch(/^[a-f0-9-]{36}$/)
    expect(tauri.invoke.mock.calls.slice(0, 2)).toEqual([
      ['local_model_register_manifest_session', { sessionId }],
      ['local_model_begin_manifest_acceptance', { sessionId, acceptanceGeneration: 7 }],
    ])
    const binding = { ...catalogBinding, acceptanceSessionId: sessionId }
    const controller = new AbortController()
    const onToken = vi.fn()

    await prepareNativeLocalModel('model-1', binding)
    const transport = new TauriLocalRuntimeTransport()
    let finish!: (value: unknown) => void
    tauri.invoke.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const streaming = transport.stream({} as LocalModelReleaseManifest, {
      requestId: 'request-1',
      modelReleaseId: 'model-1',
      scopeDigest: 'd'.repeat(64),
      catalogBinding: binding,
      messages: [{ role: 'user', content: 'test' }],
      signal: controller.signal,
      onToken,
    })
    const inferCall = tauri.invoke.mock.calls.find(([command]) => command === 'local_model_infer')
    const channel = inferCall?.[1]?.onEvent as
      { onmessage?: (event: { type: 'delta'; content: string }) => void } | undefined
    channel?.onmessage?.({ type: 'delta', content: 'visible' })
    controller.abort()
    channel?.onmessage?.({ type: 'delta', content: '-secret-after-abort' })
    finish({ requestId: 'request-1', content: 'visible', rawToolCalls: [], finishReason: 'stop' })
    await streaming
    await transport.cancel('request-1', binding)
    await transport.stop('model-1', binding)

    expect(onToken).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith('visible')

    expect(tauri.invoke).toHaveBeenCalledWith('local_model_prepare', {
      modelReleaseId: 'model-1',
      catalogBinding: binding,
      resourceRevision: 4,
    })
    expect(tauri.invoke).toHaveBeenCalledWith(
      'local_model_infer',
      expect.objectContaining({ request: expect.objectContaining({ catalogBinding: binding }) })
    )
    expect(tauri.invoke).toHaveBeenCalledWith('local_model_cancel', {
      requestId: 'request-1',
      catalogBinding: binding,
    })
    expect(tauri.invoke).toHaveBeenCalledWith('local_model_stop', {
      modelReleaseId: 'model-1',
      catalogBinding: binding,
    })
  })
})
