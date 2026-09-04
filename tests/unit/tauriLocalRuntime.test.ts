import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalModelReleaseManifest } from '@/services/inference/modelManifest'

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  Channel: class<T> {
    onmessage?: (message: T) => void
  },
}))

import {
  beginNativeManifestAcceptance,
  prepareNativeLocalModel,
  TauriLocalRuntimeTransport,
} from '@/services/inference/tauriLocalRuntime'

const catalogBinding = {
  acceptanceSessionId: '00000000-0000-4000-8000-000000000001',
  acceptanceGeneration: 7,
  manifestPayloadSha256: 'a'.repeat(64),
} as const

describe('Tauri local runtime catalog boundary', () => {
  beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.invoke.mockImplementation(async command => {
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
    await transport.stream({} as LocalModelReleaseManifest, {
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
    await transport.cancel('request-1', binding)
    await transport.stop('model-1', binding)

    expect(onToken).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith('visible')

    expect(tauri.invoke).toHaveBeenCalledWith('local_model_prepare', {
      modelReleaseId: 'model-1',
      catalogBinding: binding,
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
