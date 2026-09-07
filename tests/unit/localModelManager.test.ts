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
  it.each(['runtime_context_exceeded', 'runtime_chat_history_rejected', 'runtime_tool_contract_rejected'])(
    'keeps the model admissible after %s instead of cooling down or stopping it',
    async code => {
      const model = await release()
      const stream = vi.fn().mockRejectedValue(new LocalInferenceError('Input rejected', code, false, false))
      const transport: LocalRuntimeTransport = { stream, cancel: vi.fn(), stop: vi.fn() }
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
    }
  )

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
    controller.abort()

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledWith('request-abort', catalogBinding)
    expect(manager.getHealth(model)).toMatchObject({ state: 'ready', consecutiveFailures: 0 })
  })

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

    await Promise.resolve()
    expect(transport.stream).toHaveBeenCalledTimes(1)
    finishFirst()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(transport.stream).toHaveBeenCalledTimes(2)
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

    manager.invalidateCatalogBoundary()

    await expect(turn).rejects.toMatchObject({ name: 'AbortError' })
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
      stream: vi.fn(async () => {
        throw new Error('runtime failure')
      }),
      cancel: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    }
    let request = 0
    const manager = new LocalModelManager(
      transport,
      () => new Date('2026-08-30T12:30:00Z'),
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
    await expect(
      gateway.streamChatWithTools({ messages: [{ role: 'user', content: 'no retry' }] })
    ).rejects.toMatchObject({ code: 'model_cooldown' })
    expect(transport.stream).toHaveBeenCalledTimes(model.healthPolicy.maxConsecutiveFailures)
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
