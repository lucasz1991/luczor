import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModelReleaseManifest } from '@/services/inference/modelManifest'
import type { LocalRuntimeRequest } from '@/services/inference/localModelManager'

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  isTauri: () => true,
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

function diagnosticRequest(signal?: AbortSignal): LocalRuntimeRequest {
  return {
    requestId: 'request-1',
    modelReleaseId: 'model-1',
    scopeDigest: 'd'.repeat(64),
    catalogBinding,
    messages: [{ role: 'user', content: 'private input' }],
    signal,
  }
}

const failureDiagnostic = {
  schemaVersion: 1,
  stage: 'tokenization',
  httpStatus: 400,
  code: 'runtime_request_rejected',
  reason: 'parameter_type',
  parameter: 'reasoning_budget_tokens',
  contextTokens: 18000,
  outputTokens: 2048,
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
        args.onEvent.onmessage({
          type: 'error',
          requestId: 'request-1',
          code: 'runtime_tool_contract_rejected',
          retryable: false,
        })
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

  it.each([true, false])(
    'classifies thinking-control failure without leaking native details (event: %s)',
    async withEvent => {
      tauri.invoke.mockImplementationOnce(async (_command, args) => {
        if (withEvent) {
          args.onEvent.onmessage({
            type: 'error',
            requestId: 'request-1',
            code: 'runtime_reasoning_control_unavailable',
            retryable: false,
          })
          throw 'private control response body'
        }
        throw 'Local thinking control was not confirmed; generation interrupted.'
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
        code: 'runtime_reasoning_control_unavailable',
        retryable: false,
        message: expect.stringContaining('Modell bleibt geladen'),
      })
    }
  )

  it.each([true, false])('classifies role rejection without exposing native text (event: %s)', async withEvent => {
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      if (withEvent) {
        args.onEvent.onmessage({
          type: 'error',
          requestId: 'request-1',
          code: 'runtime_chat_history_rejected',
          retryable: false,
        })
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
      args.onEvent.onmessage({
        type: 'error',
        requestId: 'request-1',
        code: 'runtime_context_exceeded',
        retryable: false,
      })
      throw 'sensitive raw native text'
    })
    await expect(transport.stream({} as LocalModelReleaseManifest, request)).rejects.toMatchObject({
      code: 'runtime_context_exceeded',
      retryable: false,
      message: expect.stringContaining('Modell bleibt geladen'),
    })
  })

  it.each(['tokenization', 'generation', 'preparation'] as const)(
    'preserves reported %s diagnostics and public partial output, projecting away private native fields',
    async stage => {
      localModelDiagnostics.clear()
      const diagnostic = { ...failureDiagnostic, stage }
      tauri.invoke.mockImplementationOnce(async (_command, args) => {
        args.onEvent.onmessage({
          type: 'delta',
          requestId: 'request-1',
          content: '<think>PRIVATE</think>Erstes Ergebnis',
        })
        args.onEvent.onmessage({
          type: 'error',
          requestId: 'request-1',
          code: diagnostic.code,
          retryable: false,
          diagnostic: { ...diagnostic, rawBody: 'PRIVATE', parameterValue: 'PRIVATE' },
        })
        throw 'PRIVATE native exception'
      })
      const error = await new TauriLocalRuntimeTransport()
        .stream({} as LocalModelReleaseManifest, diagnosticRequest())
        .catch(value => value)
      expect(error).toMatchObject({ code: diagnostic.code, retryable: false, partialOutput: true, diagnostic })
      expect(error.message).toContain('HTTP 400')
      expect(error.message).toContain('Parameter: reasoning_budget_tokens')
      expect(error.message).not.toContain('PRIVATE')
      expect(JSON.stringify(error)).not.toContain('PRIVATE')
      expect(localModelDiagnostics.state.runs[0]).toMatchObject({
        state: 'error',
        failure: diagnostic,
        output: 'Erstes Ergebnis',
      })
      expect(localModelDiagnostics.state.runs[0]?.failure?.inputTokens).toBeUndefined()
    }
  )

  it('does not mistake hidden reasoning for a partial public answer', async () => {
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      args.onEvent.onmessage({ type: 'delta', requestId: 'request-1', content: '<think>PRIVATE thinking' })
      args.onEvent.onmessage({
        type: 'error',
        requestId: 'request-1',
        code: failureDiagnostic.code,
        diagnostic: failureDiagnostic,
      })
      throw 'PRIVATE'
    })
    await expect(
      new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, diagnosticRequest())
    ).rejects.toMatchObject({ partialOutput: false })
  })

  it.each(['other-request', undefined])(
    'ignores error diagnostics without the exact owning request ID (%s)',
    async requestId => {
      localModelDiagnostics.clear()
      const failure = new Error('native transport failure')
      tauri.invoke.mockImplementationOnce(async (_command, args) => {
        args.onEvent.onmessage({
          type: 'error',
          requestId,
          code: failureDiagnostic.code,
          diagnostic: failureDiagnostic,
        })
        throw failure
      })
      await expect(
        new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, diagnosticRequest())
      ).rejects.toBe(failure)
      expect(localModelDiagnostics.state.runs[0]?.failure).toBeUndefined()
    }
  )

  it('ignores diagnostics attached to non-error events', async () => {
    localModelDiagnostics.clear()
    const failure = new Error('native transport failure')
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      args.onEvent.onmessage({
        type: 'delta',
        requestId: 'request-1',
        content: 'Public',
        diagnostic: failureDiagnostic,
      })
      throw failure
    })
    await expect(
      new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, diagnosticRequest())
    ).rejects.toBe(failure)
    expect(localModelDiagnostics.state.runs[0]?.failure).toBeUndefined()
  })

  it('keeps aborted requests cancelled even if a late matching error event arrives', async () => {
    localModelDiagnostics.clear()
    const controller = new AbortController()
    const failure = new DOMException('Aborted', 'AbortError')
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      controller.abort()
      args.onEvent.onmessage({
        type: 'error',
        requestId: 'request-1',
        code: failureDiagnostic.code,
        diagnostic: failureDiagnostic,
      })
      throw failure
    })
    await expect(
      new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, diagnosticRequest(controller.signal))
    ).rejects.toBe(failure)
    expect(localModelDiagnostics.state.runs[0]).toMatchObject({ state: 'cancelled' })
    expect(localModelDiagnostics.state.runs[0]?.failure).toBeUndefined()
  })

  it('drops a previous channel error even when a later request reuses its ID', async () => {
    let oldChannel!: { onmessage: (event: unknown) => void }
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      oldChannel = args.onEvent
      return { content: 'done', rawToolCalls: [], requestId: 'request-1', finishReason: 'stop' }
    })
    const transport = new TauriLocalRuntimeTransport()
    await transport.stream({} as LocalModelReleaseManifest, diagnosticRequest())
    const failure = new Error('different request failure')
    tauri.invoke.mockImplementationOnce(async () => {
      oldChannel.onmessage({
        type: 'error',
        requestId: 'request-1',
        code: failureDiagnostic.code,
        diagnostic: failureDiagnostic,
      })
      throw failure
    })
    await expect(transport.stream({} as LocalModelReleaseManifest, diagnosticRequest())).rejects.toBe(failure)
  })

  it.each([
    { ...failureDiagnostic, code: 'runtime_context_exceeded' },
    { ...failureDiagnostic, schemaVersion: 2 },
    { ...failureDiagnostic, reason: 'PRIVATE' },
  ])('rejects mismatched or invalid diagnostics without losing the safe legacy failure code (%j)', async diagnostic => {
    localModelDiagnostics.clear()
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      args.onEvent.onmessage({ type: 'error', requestId: 'request-1', code: failureDiagnostic.code, diagnostic })
      throw 'PRIVATE native exception'
    })
    const error = await new TauriLocalRuntimeTransport()
      .stream({} as LocalModelReleaseManifest, diagnosticRequest())
      .catch(value => value)
    expect(error).toMatchObject({ code: 'runtime_request_rejected' })
    expect(error.diagnostic).toBeUndefined()
    expect(error.message).toContain('Fehlerstufe nicht gemeldet')
    expect(error.message).not.toContain('PRIVATE')
    expect(localModelDiagnostics.state.runs[0]?.failure).toBeUndefined()
  })

  it('preserves the old exact request HTTP 400 contract without fabricating a diagnostic', async () => {
    tauri.invoke.mockImplementationOnce(async (_command, args) => {
      args.onEvent.onmessage({
        type: 'error',
        requestId: 'request-1',
        code: 'runtime_request_rejected',
        retryable: false,
      })
      throw 'Local llama.cpp rejected the request (HTTP 400).'
    })
    await expect(
      new TauriLocalRuntimeTransport().stream({} as LocalModelReleaseManifest, diagnosticRequest())
    ).rejects.toMatchObject({
      code: 'runtime_request_rejected',
      message: 'Local llama.cpp rejected the request (HTTP 400).',
      diagnostic: undefined,
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
