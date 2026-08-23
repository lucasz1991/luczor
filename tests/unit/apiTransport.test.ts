import { describe, expect, it } from 'vitest'
import { createCorrelationId, readBoundedResponseText } from '@/services/api/luczorApi'

describe('Luczor API transport boundaries', () => {
  it('creates a Laravel-compatible UUID correlation id', () => {
    expect(createCorrelationId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('accepts an exact response boundary', async () => {
    const response = new Response('12345', {
      headers: { 'Content-Length': '5' },
    })

    await expect(readBoundedResponseText(response, 5)).resolves.toBe('12345')
  })

  it('rejects a declared oversized response before reading it', async () => {
    const response = new Response('123456', {
      headers: { 'Content-Length': '6' },
    })

    await expect(readBoundedResponseText(response, 5)).rejects.toMatchObject({
      name: 'LuczorApiError',
      status: 0,
    })
  })

  it('cancels a chunked response as soon as the byte limit is exceeded', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'))
        controller.enqueue(new TextEncoder().encode('456'))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(readBoundedResponseText(new Response(body), 5)).rejects.toThrow(/überschreitet das Limit/)
    expect(cancelled).toBe(true)
  })
})
