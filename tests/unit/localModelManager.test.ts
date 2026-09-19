import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  LocalInferenceError,
  LocalModelManager,
  type LocalReadinessEvidence,
  type LocalRuntimeTransport,
} from '@/services/inference/localModelManager'
import { verifyLocalModelManifest, type LocalModelReleaseManifest } from '@/services/inference/modelManifest'
import type { InferenceResult } from '@/services/inference/types'

const payloadHash = 'a'.repeat(64)
const catalogBinding = {
  acceptanceSessionId: '00000000-0000-4000-8000-000000000001',
  acceptanceGeneration: 1,
  manifestPayloadSha256: payloadHash,
} as const
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/local-model-manifest-v1.json'), 'utf8')) as {
  cases: Record<string, Record<string, unknown>>
}

async function release(): Promise<LocalModelReleaseManifest> {
  const manifest = await verifyLocalModelManifest(
    {
      key_id: 'test-key',
      algorithm: 'RSA-SHA256',
      payload_sha256: payloadHash,
      payload: structuredClone(fixture.cases.explicit_experiment),
      signature: 'test',
    },
    { verify: async () => ({ valid: true, canonicalPayloadSha256: payloadHash }) },
    {
      trustDomain: `server:v1:${'b'.repeat(64)}`,
      acceptanceSessionId: '00000000-0000-4000-8000-000000000001',
      acceptanceGeneration: 1,
      expectedKeyId: 'test-key',
      minimumCatalogVersion: 2026083001,
      minimumPolicyVersion: 2026083001,
      now: new Date('2026-08-30T12:30:00Z'),
    }
  )
  return manifest.models.find(model => model.id.includes('orcarouter'))!
}

function readiness(model: LocalModelReleaseManifest): LocalReadinessEvidence {
  return {
    modelReleaseId: model.id,
    manifestPayloadSha256: payloadHash,
    artifactSha256: model.artifact!.sha256,
    runtimeSha256: model.runtime!.sha256,
    ready: true,
    verifiedAtMs: Date.parse('2026-08-30T12:29:00Z'),
    validUntilMs: Date.parse('2026-08-30T12:40:00Z'),
  }
}

const successfulResult: InferenceResult = {
  content: 'OK',
  toolCalls: [],
  rawToolCalls: [],
  finishReason: 'stop',
}

describe('LocalModelManager runtime safety', () => {
  it.each(['off', 'auto', undefined] as const)(
    'preserves local request reasoning mode %s through the resident gateway',
    async reasoningMode => {
      const model = await release()
      const transport: LocalRuntimeTransport = {
        prepare: vi.fn(),
        stream: vi.fn(async () => successfulResult),
        cancel: vi.fn(),
        stop: vi.fn(),
      }
      const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
      const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
      await gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'Kurzer Arbeitsplan.' }], reasoningMode })
      expect(vi.mocked(transport.stream).mock.calls[0]?.[1].reasoningMode).toBe(reasoningMode)
      expect(transport.prepare).not.toHaveBeenCalled()
    }
  )

  it('bounds idle inference to a tool-free local request and never renews its expired readiness', async () => {
    const model = await release()
    let now = Date.parse('2026-08-30T12:30:00Z')
    const transport: LocalRuntimeTransport = {
      prepare: vi.fn(),
      stream: vi.fn(async () => successfulResult),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport, () => new Date(now))
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64), true)
    await gateway.streamChatWithTools({
      messages: [],
      tools: ['untrusted'],
      toolChoice: 'required',
      taskType: 'chat.general',
      reasoningMode: 'auto',
    })
    expect(transport.stream).toHaveBeenCalledExactlyOnceWith(
      model,
      expect.objectContaining({
        tools: [],
        toolChoice: 'none',
        taskType: 'context.optimize',
        maxOutputTokens: 768,
        reasoningMode: 'off',
      })
    )
    now += 11 * 60_000
    await expect(gateway.streamChatWithTools({ messages: [] })).rejects.toMatchObject({ code: 'readiness_unavailable' })
    expect(transport.prepare).not.toHaveBeenCalled()
    expect(vi.mocked(transport.stream).mock.calls).toHaveLength(1)
  })

  it.each([384, 768, 1200])(
    'preserves a smaller idle output budget and clamps %s at its native maximum',
    async maximum => {
      const model = await release()
      const transport: LocalRuntimeTransport = {
        stream: vi.fn(async () => successfulResult),
        cancel: vi.fn(),
        stop: vi.fn(),
      }
      const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
      const idle = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64), true)
      await idle.streamChatWithTools({ messages: [], maxOutputTokens: maximum })
      expect(transport.stream).toHaveBeenCalledWith(
        model,
        expect.objectContaining({ maxOutputTokens: Math.min(maximum, 768) })
      )
    }
  )

  it.each(['runtime_first_progress_timeout', 'runtime_progress_timeout', 'runtime_total_timeout'])(
    'does not poison model health when an idle portion reaches %s',
    async code => {
      const model = await release()
      const stream = vi.fn().mockRejectedValue(new LocalInferenceError('Bounded idle deadline', code, true, false))
      const transport: LocalRuntimeTransport = { prepare: vi.fn(), stream, cancel: vi.fn(), stop: vi.fn() }
      const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
      const idle = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64), true)
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(idle.streamChatWithTools({ messages: [] })).rejects.toMatchObject({ code })
      }
      expect(manager.getHealth(model)).toMatchObject({ state: 'ready', consecutiveFailures: 0 })
      expect(transport.prepare).not.toHaveBeenCalled()
      expect(transport.stop).not.toHaveBeenCalled()
      const foreground = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
      await expect(foreground.streamChatWithTools({ messages: [] })).rejects.toMatchObject({ code })
      expect(manager.getHealth(model)).toMatchObject({ state: 'degraded', consecutiveFailures: 1 })
    }
  )

  it('still counts genuine idle stream failures as model health failures', async () => {
    const model = await release()
    const transport: LocalRuntimeTransport = {
      stream: vi
        .fn()
        .mockRejectedValue(new LocalInferenceError('Connection failed', 'runtime_stream_failed', true, false)),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
    const idle = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64), true)
    await expect(idle.streamChatWithTools({ messages: [] })).rejects.toMatchObject({ code: 'runtime_stream_failed' })
    expect(manager.getHealth(model)).toMatchObject({ state: 'degraded', consecutiveFailures: 1 })
  })
  it('rejects a readiness renewal from a different resource configuration', async () => {
    const model = await release()
    const old = { ...readiness(model), resourceRevision: 3 }
    const transport: LocalRuntimeTransport = {
      prepare: vi.fn(async () => ({ ...old, resourceRevision: 4, validUntilMs: Date.parse('2026-08-30T12:50:00Z') })),
      stream: vi.fn(async () => successfulResult),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:41:00Z'))
    const gateway = manager.gateway(model, old, catalogBinding, 'b'.repeat(64))
    await expect(
      gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'continue' }] })
    ).rejects.toMatchObject({ code: 'readiness_unavailable' })
    expect(transport.prepare).toHaveBeenCalledWith(model.id, catalogBinding, 3)
    expect(transport.stream).not.toHaveBeenCalled()
  })
  it('renews an expired native lease between rounds and reuses the renewed evidence', async () => {
    const model = await release()
    let clock = Date.parse('2026-08-30T12:30:00Z')
    const prepare = vi.fn(async () => ({ ...readiness(model), verifiedAtMs: clock, validUntilMs: clock + 60_000 }))
    const transport: LocalRuntimeTransport = {
      prepare,
      stream: vi.fn(async () => successfulResult),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport, () => new Date(clock))
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    const request = { messages: [{ role: 'user' as const, content: 'continue the existing task' }] }
    await gateway.streamChatWithTools(request)
    expect(prepare).not.toHaveBeenCalled()
    clock += 11 * 60_000
    await gateway.streamChatWithTools(request)
    await gateway.streamChatWithTools(request)
    expect(prepare).toHaveBeenCalledExactlyOnceWith(model.id, catalogBinding, 0)
    expect(transport.stream).toHaveBeenCalledTimes(3)
    expect(transport.stop).not.toHaveBeenCalled()
  })

  it.each(['catalog', 'abort', 'mismatched', 'expired', 'failure'])(
    'never infers after %s during lease renewal',
    async outcome => {
      const model = await release()
      const controller = new AbortController()
      const clock = Date.parse('2026-08-30T12:41:00Z')
      const prepare = vi.fn(async () => {
        if (outcome === 'catalog') manager.invalidateCatalogBoundary()
        if (outcome === 'abort') controller.abort()
        if (outcome === 'failure') throw new Error('private runtime diagnostics')
        return {
          ...readiness(model),
          validUntilMs: outcome === 'expired' ? clock - 1 : clock + 60_000,
          artifactSha256: outcome === 'mismatched' ? 'c'.repeat(64) : model.artifact!.sha256,
        }
      })
      const transport: LocalRuntimeTransport = { prepare, stream: vi.fn(), cancel: vi.fn(), stop: vi.fn() }
      const manager = new LocalModelManager(transport, () => new Date(clock))
      const turn = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64)).streamChatWithTools({
        messages: [{ role: 'user', content: 'continue' }],
        signal: controller.signal,
      })
      await expect(turn).rejects.toMatchObject(
        outcome === 'abort'
          ? { name: 'AbortError' }
          : {
              code:
                outcome === 'catalog'
                  ? 'catalog_binding_stale'
                  : outcome === 'failure'
                    ? 'readiness_refresh_failed'
                    : 'readiness_unavailable',
            }
      )
      expect(transport.stream).not.toHaveBeenCalled()
      expect(transport.stop).not.toHaveBeenCalled()
      expect(manager.getHealth(model).consecutiveFailures).toBe(0)
    }
  )

  it.each([
    'runtime_context_exceeded',
    'runtime_chat_history_rejected',
    'runtime_chat_template_failed',
    'runtime_tool_contract_rejected',
    'runtime_request_rejected',
    'runtime_reasoning_control_unavailable',
    'runtime_output_repeated',
  ])('keeps the model admissible after %s instead of cooling down or stopping it', async code => {
    const model = await release()
    const stream = vi
      .fn()
      .mockRejectedValue(
        new LocalInferenceError(
          code === 'runtime_request_rejected' ? 'Local llama.cpp rejected the request (HTTP 400).' : 'Input rejected',
          code,
          false,
          false
        )
      )
    const transport: LocalRuntimeTransport = { prepare: vi.fn(), stream, cancel: vi.fn(), stop: vi.fn() }
    const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'long input' }] })
      ).rejects.toMatchObject({ code })
    }
    expect(manager.getHealth(model)).toMatchObject({ state: 'ready', consecutiveFailures: 0 })
    expect(transport.stop).not.toHaveBeenCalled()
    stream.mockResolvedValueOnce(successfulResult)
    await expect(
      gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'short input' }] })
    ).resolves.toMatchObject({ content: 'OK', provider: 'local' })
    expect(stream).toHaveBeenCalledTimes(4)
    expect(transport.prepare).not.toHaveBeenCalled()
    expect(transport.cancel).not.toHaveBeenCalled()
    expect(transport.stop).not.toHaveBeenCalled()
  })

  it.each([
    ['runtime_request_rejected', 'parameter_type', 'ready'],
    ['runtime_auth_failed', 'authentication', 'degraded'],
    ['runtime_capacity_exhausted', 'capacity', 'degraded'],
    ['runtime_server_failed', 'server', 'degraded'],
  ] as const)('preserves the safe diagnostic and partial output for %s', async (code, reason, state) => {
    const model = await release()
    const diagnostic = {
      schemaVersion: 1 as const,
      stage: 'generation' as const,
      httpStatus: reason === 'authentication' ? 401 : reason === 'server' ? 500 : 400,
      code,
      reason,
      contextTokens: 16_384,
      inputTokens: 8_000,
      outputTokens: 2_048,
    }
    const failure = new LocalInferenceError('Geprüfte Diagnose', code, false, false, diagnostic)
    const transport: LocalRuntimeTransport = {
      stream: vi.fn(async (_release, request) => {
        request.onToken?.('Bereits sichtbarer Fortschritt')
        throw failure
      }),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    await expect(
      gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'weiter' }] })
    ).rejects.toMatchObject({
      code,
      partialOutput: true,
      diagnostic,
    })
    expect(manager.getHealth(model)).toMatchObject({
      state,
      consecutiveFailures: state === 'ready' ? 0 : 1,
    })
    expect(transport.stream).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 501])('does not assume a generic request rejection with status %s is healthy', async status => {
    const model = await release()
    const diagnostic = status
      ? {
          schemaVersion: 1 as const,
          stage: 'generation' as const,
          httpStatus: status,
          code: 'runtime_request_rejected' as const,
          reason: 'unclassified' as const,
        }
      : undefined
    const transport: LocalRuntimeTransport = {
      stream: vi
        .fn()
        .mockRejectedValue(
          new LocalInferenceError('Request rejected', 'runtime_request_rejected', false, false, diagnostic)
        ),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
    await expect(
      manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64)).streamChatWithTools({ messages: [] })
    ).rejects.toMatchObject({ code: 'runtime_request_rejected' })
    expect(manager.getHealth(model)).toMatchObject({ state: 'degraded', consecutiveFailures: 1 })
  })

  it('propagates a parent abort to native cancel without counting a model failure', async () => {
    const model = await release()
    const cancel = vi.fn(async () => undefined)
    const transport: LocalRuntimeTransport = {
      stream: vi.fn(
        async (_release, request) =>
          new Promise<InferenceResult>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
              once: true,
            })
          })
      ),
      cancel,
      stop: vi.fn(async () => undefined),
    }
    const manager = new LocalModelManager(
      transport,
      () => new Date('2026-08-30T12:30:00Z'),
      () => 'request-abort'
    )
    const controller = new AbortController()
    const turn = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64)).streamChatWithTools({
      messages: [{ role: 'user', content: 'stop' }],
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledOnce())
    controller.abort()

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledExactlyOnceWith('request-abort', catalogBinding)
    expect(manager.getHealth(model)).toMatchObject({ state: 'ready', consecutiveFailures: 0 })
  })

  it.each(['', 'Bereits sichtbare Antwort'])(
    'classifies an unsignaled transport AbortError and retains partial-output evidence (%s)',
    async partial => {
      const model = await release()
      const controller = new AbortController()
      const transport: LocalRuntimeTransport = {
        stream: vi
          .fn()
          .mockImplementationOnce(async (_model, request) => {
            request.onToken?.(partial)
            throw new DOMException('Private transport diagnostic', 'AbortError')
          })
          .mockResolvedValueOnce(successfulResult),
        cancel: vi.fn(),
        stop: vi.fn(),
      }
      const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
      const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
      const onToken = vi.fn()
      await expect(
        gateway.streamChatWithTools({ messages: [], signal: controller.signal, onToken })
      ).rejects.toMatchObject({
        name: 'LocalInferenceError',
        code: 'runtime_transport_interrupted',
        retryable: true,
        partialOutput: !!partial,
        message: 'Die lokale Modellverbindung wurde unerwartet unterbrochen.',
      })
      expect(controller.signal.aborted).toBe(false)
      expect(transport.cancel).not.toHaveBeenCalled()
      expect(transport.stop).not.toHaveBeenCalled()
      expect(onToken).toHaveBeenCalledWith(partial)
      expect(manager.getHealth(model)).toMatchObject({
        lastErrorCode: 'runtime_transport_interrupted',
        consecutiveFailures: 1,
      })
      await expect(gateway.streamChatWithTools({ messages: [] })).resolves.toMatchObject({ content: 'OK' })
    }
  )

  it('queues concurrent local requests instead of failing with runtime_busy', async () => {
    const model = await release()
    let finishFirst!: () => void
    const firstDone = new Promise<void>(resolve => {
      finishFirst = resolve
    })
    let calls = 0
    const transport: LocalRuntimeTransport = {
      stream: vi.fn(async () => {
        calls += 1
        if (calls === 1) await firstDone
        return successfulResult
      }),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }
    const manager = new LocalModelManager(
      transport,
      () => new Date('2026-08-30T12:30:00Z'),
      () => `request-${calls + 1}`
    )
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    const first = gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'first' }] })
    const second = gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'second' }] })

    await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1))
    finishFirst()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(transport.stream).toHaveBeenCalledTimes(2)
  })

  it('coalesces cancellation and drains the first native IPC before admitting the next stream', async () => {
    const model = await release()
    const events: string[] = []
    let completeCancellation!: () => void
    const cancellation = new Promise<void>(resolve => {
      completeCancellation = resolve
    })
    let cancellationCalls = 0
    let requestSequence = 0
    const transport: LocalRuntimeTransport = {
      stream: vi.fn(async (_model, request) => {
        events.push(`stream:${request.requestId}`)
        if (request.requestId === 'request-1') {
          return new Promise<InferenceResult>((_resolve, reject) => {
            request.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
              once: true,
            })
          })
        }
        return successfulResult
      }),
      cancel: vi.fn(async () => {
        cancellationCalls += 1
        // The old double-dispatch path could await the second (fast) IPC and
        // release the slot while this first native cancellation was still pending.
        if (cancellationCalls === 1) await cancellation
        events.push('cancel:finished')
      }),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(
      transport,
      () => new Date('2026-08-30T12:30:00Z'),
      () => `request-${++requestSequence}`
    )
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    const controller = new AbortController()
    const first = gateway.streamChatWithTools({ messages: [], signal: controller.signal }).catch(error => error)
    await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledOnce())
    controller.abort()
    const sameCancellation = manager.cancel('request-1', catalogBinding)
    const second = gateway.streamChatWithTools({ messages: [] })
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(transport.cancel).toHaveBeenCalledExactlyOnceWith('request-1', catalogBinding)
      expect(transport.stream).toHaveBeenCalledTimes(1)
      expect(events).toEqual(['stream:request-1'])
    } finally {
      completeCancellation()
    }
    await sameCancellation
    await expect(first).resolves.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toMatchObject({ content: 'OK' })
    expect(events).toEqual(['stream:request-1', 'cancel:finished', 'stream:request-2'])
    expect(transport.stop).not.toHaveBeenCalled()
    expect(manager.getHealth(model).consecutiveFailures).toBe(0)
  })

  it('does not redispatch stale cancellation after a request has finished', async () => {
    const model = await release()
    let sequence = 0
    const transport: LocalRuntimeTransport = {
      stream: vi.fn(async () => successfulResult),
      cancel: vi.fn(),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(
      transport,
      () => new Date('2026-08-30T12:30:00Z'),
      () => `request-${++sequence}`
    )
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    await gateway.streamChatWithTools({ messages: [] })
    await manager.cancel('request-1', catalogBinding)
    await gateway.streamChatWithTools({ messages: [] })
    expect(transport.cancel).not.toHaveBeenCalled()
    expect(transport.stream).toHaveBeenCalledTimes(2)
    expect(transport.stop).not.toHaveBeenCalled()
  })

  it('settles a rejected cancel once without deadlocking the next request', async () => {
    const model = await release()
    const controller = new AbortController()
    const transport: LocalRuntimeTransport = {
      stream: vi
        .fn()
        .mockImplementationOnce(
          async (_model, request) =>
            new Promise<InferenceResult>((_resolve, reject) => {
              request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
                once: true,
              })
            })
        )
        .mockResolvedValueOnce(successfulResult),
      cancel: vi.fn(async () => {
        throw new Error('Native cancel rejected')
      }),
      stop: vi.fn(),
    }
    const manager = new LocalModelManager(transport, () => new Date('2026-08-30T12:30:00Z'))
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    const first = gateway.streamChatWithTools({ messages: [], signal: controller.signal }).catch(error => error)
    await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledOnce())
    controller.abort()
    const second = gateway.streamChatWithTools({ messages: [] })
    await expect(first).resolves.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toMatchObject({ content: 'OK' })
    expect(transport.cancel).toHaveBeenCalledOnce()
    expect(transport.stop).not.toHaveBeenCalled()
  })

  it('treats a catalog-boundary abort as ownership invalidation instead of model failure', async () => {
    const model = await release()
    const transport: LocalRuntimeTransport = {
      stream: vi.fn(
        async (_release, request) =>
          new Promise<InferenceResult>((_resolve, reject) => {
            request.onToken?.('visible-before-rotation')
            request.signal?.addEventListener(
              'abort',
              () => {
                request.onToken?.('secret-after-rotation')
                reject(new Error('native boundary cancel'))
              },
              { once: true }
            )
          })
      ),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }
    const manager = new LocalModelManager(
      transport,
      () => new Date('2026-08-30T12:30:00Z'),
      () => 'request-boundary'
    )
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
    const onToken = vi.fn()
    const turn = gateway.streamChatWithTools({
      messages: [{ role: 'user', content: 'rotate' }],
      onToken,
    })

    await vi.waitFor(() => expect(onToken).toHaveBeenCalledWith('visible-before-rotation'))
    manager.invalidateCatalogBoundary()

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.cancel).toHaveBeenCalledExactlyOnceWith('request-boundary', catalogBinding)
    expect(onToken).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith('visible-before-rotation')
    expect(onToken).not.toHaveBeenCalledWith('secret-after-rotation')
    expect(manager.getHealth(model)).toMatchObject({ state: 'stopped', consecutiveFailures: 0 })
    await expect(
      gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'stale gateway' }] })
    ).rejects.toMatchObject({ code: 'catalog_binding_stale' })
    expect(transport.stream).toHaveBeenCalledTimes(1)
    expect(manager.getHealth(model)).toMatchObject({ state: 'stopped', consecutiveFailures: 0 })
  })

  it('enters the signed cooldown only after consecutive runtime failures', async () => {
    const model = await release()
    const transport: LocalRuntimeTransport = {
      prepare: vi.fn(),
      stream: vi.fn(async () => {
        throw new Error('runtime failure')
      }),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }
    let request = 0
    let clock = Date.parse('2026-08-30T12:39:59Z')
    const manager = new LocalModelManager(
      transport,
      () => new Date(clock),
      () => `request-${++request}`
    )
    const gateway = manager.gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))

    for (let failure = 1; failure <= model.healthPolicy.maxConsecutiveFailures; failure += 1) {
      await expect(
        gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'test' }] })
      ).rejects.toBeInstanceOf(LocalInferenceError)
    }
    expect(manager.getHealth(model)).toMatchObject({
      state: 'cooldown',
      consecutiveFailures: model.healthPolicy.maxConsecutiveFailures,
    })
    clock += 2_000
    await expect(
      gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'no retry' }] })
    ).rejects.toMatchObject({ code: 'model_cooldown' })
    expect(transport.stream).toHaveBeenCalledTimes(model.healthPolicy.maxConsecutiveFailures)
    expect(transport.prepare).not.toHaveBeenCalled()
  })

  it('surfaces only allow-listed native runtime diagnostics', async () => {
    const model = await release()
    const nativeFailure: LocalRuntimeTransport = {
      stream: vi.fn(async () => {
        throw 'Local llama.cpp returned HTTP 400.'
      }),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }
    const manager = new LocalModelManager(nativeFailure, () => new Date('2026-08-30T12:30:00Z'))

    await expect(
      manager
        .gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
        .streamChatWithTools({ messages: [{ role: 'user', content: 'test' }] })
    ).rejects.toMatchObject({ message: 'Local llama.cpp returned HTTP 400.', code: 'runtime_failed' })

    const classifiedFailure: LocalRuntimeTransport = {
      ...nativeFailure,
      stream: vi.fn(async () => {
        throw 'Local llama.cpp could not apply the chat template (HTTP 500).'
      }),
    }
    const classifiedManager = new LocalModelManager(classifiedFailure, () => new Date('2026-08-30T12:30:00Z'))
    await expect(
      classifiedManager
        .gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
        .streamChatWithTools({ messages: [{ role: 'user', content: 'test' }] })
    ).rejects.toMatchObject({
      message: 'Local llama.cpp could not apply the chat template (HTTP 500).',
      code: 'runtime_failed',
    })

    const untrustedFailure: LocalRuntimeTransport = {
      ...nativeFailure,
      stream: vi.fn(async () => {
        throw new Error('D:\\private\\secret.gguf')
      }),
    }
    const isolatedManager = new LocalModelManager(untrustedFailure, () => new Date('2026-08-30T12:30:00Z'))

    await expect(
      isolatedManager
        .gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
        .streamChatWithTools({ messages: [{ role: 'user', content: 'test' }] })
    ).rejects.toMatchObject({ message: 'Die lokale Runtime ist fehlgeschlagen.', code: 'runtime_failed' })
  })

  it('keeps a turn fixed to one local runtime and strips reasoning blocks from output', async () => {
    const model = await release()
    const transport: LocalRuntimeTransport = {
      stream: vi.fn(async () => ({ ...successfulResult, content: '<think>private</think>Visible' })),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }
    const manager = new LocalModelManager(
      transport,
      () => new Date('2026-08-30T12:30:00Z'),
      () => 'request-visible'
    )
    const result = await manager
      .gateway(model, readiness(model), catalogBinding, 'b'.repeat(64))
      .streamChatWithTools({ messages: [{ role: 'user', content: 'test' }] })
    expect(result).toMatchObject({ content: 'Visible', target: 'local_llama_cpp', model: model.id })
  })
})
