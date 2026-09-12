import { beforeEach, describe, expect, it, vi } from 'vitest'
const transport = vi.hoisted(() => vi.fn())
vi.mock('@/services/api/transportTarget', () => ({ apiTransportFetch: transport }))
import { binaryRequest, CHUNK_BYTES, decodeBase64, encodeBase64, sha256 } from '@/services/coordination/binaryTransport'
const config = { baseUrl: 'https://luczor.test', clientId: 'device', deviceKey: 'secret' }
const path = `/projects/1/mirror/chunks/${'a'.repeat(64)}`
beforeEach(() => transport.mockReset())
describe('bounded private binary transport', () => {
  it('preserves every byte including zero bytes and binary values', async () => {
    const input = Uint8Array.from([0, 255, 1, 127, 128])
    expect(decodeBase64(encodeBase64(input))).toEqual(input)
    expect(await sha256(input)).toHaveLength(64)
    transport.mockResolvedValue(new Response(input))
    expect(await binaryRequest(config, path)).toEqual(input)
    expect(transport).toHaveBeenCalledWith(
      `https://luczor.test/api/v1${path}`,
      expect.objectContaining({ redirect: 'error', credentials: 'omit' })
    )
  })
  it('rejects an oversized streamed response without relying on Content-Length', async () => {
    const cancel = vi.fn()
    transport.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(CHUNK_BYTES))
            controller.enqueue(new Uint8Array(1))
          },
          cancel,
        })
      )
    )
    await expect(binaryRequest(config, path)).rejects.toThrow('zu großen Block')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('does not send an aborted request or unsupported path or oversized upload', async () => {
    await expect(binaryRequest(config, path, undefined, AbortSignal.abort())).rejects.toThrow()
    await expect(binaryRequest(config, '/other/api')).rejects.toThrow('Ungültiges')
    await expect(binaryRequest(config, path, new Uint8Array(CHUNK_BYTES + 1))).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
})
