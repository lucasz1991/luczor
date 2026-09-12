import { shallowRef } from 'vue'

export type PayloadApproval = Readonly<{
  id: string
  title: string
  kind?: 'inference' | 'result'
  destination: string
  hash: string
  content: string
  scopeLabel?: string
  /** Ephemeral exact PNG preview; never a remote image URL or persisted artifact. */
  imagePreview?: string
  expiresAt: number
}>
export const pendingPayloadApproval = shallowRef<PayloadApproval | null>(null)
let finish: ((approved: boolean) => void) | null = null
const queue: Array<() => void> = []
const advance = () => {
  if (!pendingPayloadApproval.value) queue.shift()?.()
}

export function resolvePayloadApproval(id: string, approved: boolean): void {
  if (pendingPayloadApproval.value?.id === id) finish?.(approved)
}

/** Full immutable payload preview. Closing, cancellation and timeout reject the request. */
export function requestPayloadApproval(
  request: Omit<PayloadApproval, 'id' | 'expiresAt'>,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (
    request.imagePreview !== undefined &&
    (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(request.imagePreview) ||
      request.imagePreview.length > 2_800_000 ||
      !request.content.includes(request.imagePreview.slice('data:image/png;base64,'.length)))
  )
    return Promise.resolve(false)
  const captured = { ...request }
  return new Promise(resolve => {
    let preview: PayloadApproval | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const abort = () => complete(false)
    const complete = (approved: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      const queued = queue.indexOf(show)
      if (queued >= 0) queue.splice(queued, 1)
      if (preview && pendingPayloadApproval.value?.id === preview.id) {
        pendingPayloadApproval.value = null
        finish = null
      }
      resolve(!!preview && approved && Date.now() < preview.expiresAt && !signal?.aborted)
      advance()
    }
    const show = () => {
      if (settled) return
      if (signal?.aborted) {
        complete(false)
        return
      }
      preview = Object.freeze({ ...captured, id: crypto.randomUUID(), expiresAt: Date.now() + 120_000 })
      finish = complete
      timer = setTimeout(() => complete(false), 120_000)
      pendingPayloadApproval.value = preview
    }
    signal?.addEventListener('abort', abort, { once: true })
    queue.push(show)
    advance()
  })
}
