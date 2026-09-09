import { afterEach, describe, expect, it, vi } from 'vitest'
import { pendingPayloadApproval, requestPayloadApproval, resolvePayloadApproval } from '@/services/payloadApproval'
const request = { title: 'Preview', destination: 'server', hash: 'hash', content: 'full content' }
afterEach(() => {
  if (pendingPayloadApproval.value) resolvePayloadApproval(pendingPayloadApproval.value.id, false)
  vi.useRealTimers()
})
describe('payload approval', () => {
  it('only previews PNG bytes that belong to the exact payload and clears them after approval', async () => {
    const imagePreview = 'data:image/png;base64,aGVsbG8='
    const approved = requestPayloadApproval({
      ...request,
      content: JSON.stringify({ image: imagePreview }),
      imagePreview,
    })
    expect(pendingPayloadApproval.value?.imagePreview).toBe(imagePreview)
    resolvePayloadApproval(pendingPayloadApproval.value!.id, true)
    expect(await approved).toBe(true)
    expect(pendingPayloadApproval.value).toBeNull()
  })
  it.each(['https://example.test/image.png', 'data:image/svg+xml;base64,aGVsbG8=', 'data:image/png;base64,b3RoZXI='])(
    'rejects a remote, executable or different image preview: %s',
    async imagePreview => {
      expect(await requestPayloadApproval({ ...request, content: '{"image":"aGVsbG8="}', imagePreview })).toBe(false)
      expect(pendingPayloadApproval.value).toBeNull()
    }
  )
  it('times out without retaining an execution slot', async () => {
    vi.useFakeTimers()
    const result = requestPayloadApproval(request)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await result).toBe(false)
    expect(pendingPayloadApproval.value).toBeNull()
  })
  it('rejects a request on abort and cannot approve a superseded payload', async () => {
    const first = requestPayloadApproval(request)
    const firstId = pendingPayloadApproval.value!.id
    const abort = new AbortController()
    const second = requestPayloadApproval({ ...request, hash: 'new' }, abort.signal)
    expect(await first).toBe(false)
    resolvePayloadApproval(firstId, true)
    expect(pendingPayloadApproval.value?.hash).toBe('new')
    abort.abort()
    expect(await second).toBe(false)
  })
})
