import { shallowRef } from 'vue'

export type PayloadApproval = Readonly<{
  id: string
  title: string
  kind?: 'inference' | 'result'
  destination: string
  hash: string
  content: string
  /** Ephemeral exact PNG preview; never a remote image URL or persisted artifact. */
  imagePreview?: string
  expiresAt: number
}>
export const pendingPayloadApproval = shallowRef<PayloadApproval | null>(null)
let finish: ((approved: boolean) => void) | null = null

export function resolvePayloadApproval(id: string, approved: boolean): void {
  if (pendingPayloadApproval.value?.id === id) finish?.(approved)
}

/** Full immutable payload preview. Closing, cancellation and timeout reject the request. */
export function requestPayloadApproval(
  request: Omit<PayloadApproval, 'id' | 'expiresAt'>,
  signal?: AbortSignal
): Promise<boolean> {
  finish?.(false)
  if (signal?.aborted) return Promise.resolve(false)
  if (
    request.imagePreview !== undefined &&
    (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(request.imagePreview) ||
      request.imagePreview.length > 2_800_000 ||
      !request.content.includes(request.imagePreview.slice('data:image/png;base64,'.length)))
  )
    return Promise.resolve(false)
  const preview = Object.freeze({ ...request, id: crypto.randomUUID(), expiresAt: Date.now() + 120_000 })
  return new Promise(resolve => {
    const abort = () => complete(false)
    const timer = setTimeout(() => complete(false), 120_000)
    const complete = (approved: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (pendingPayloadApproval.value?.id !== preview.id) return
      pendingPayloadApproval.value = null
      finish = null
      resolve(approved && Date.now() < preview.expiresAt && !signal?.aborted)
    }
    finish = complete
    signal?.addEventListener('abort', abort, { once: true })
    pendingPayloadApproval.value = preview
  })
}
