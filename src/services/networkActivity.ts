/** Session-only HTTP payload counters. URLs, headers and contents are never retained. */
export type NetworkCounters = { sentBytes: number; receivedBytes: number; requests: number; activeRequests: number; failedRequests: number; unmeasuredBodies: number }
export type NetworkScope = 'local' | 'external' | 'unknown'
const empty = (): NetworkCounters => ({ sentBytes: 0, receivedBytes: 0, requests: 0, activeRequests: 0, failedRequests: 0, unmeasuredBodies: 0 })

export function networkScope(input: RequestInfo | URL): NetworkScope {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!['http:', 'https:'].includes(url.protocol)) return 'unknown'
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const ipv4 = host.split('.').map(Number)
    const privateV4 = ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
      && (ipv4[0] === 127 || ipv4[0] === 10 || (ipv4[0] === 192 && ipv4[1] === 168)
        || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) || (ipv4[0] === 169 && ipv4[1] === 254))
    const privateV6 = host.includes(':') && (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host))
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateV4 || privateV6) return 'local'
    // A bare intranet hostname has no reliable public/private classification without DNS.
    return host.includes('.') || host.includes(':') ? 'external' : 'unknown'
  } catch { return 'unknown' }
}

function bodySize(body: BodyInit | null | undefined): number | null {
  if (body == null) return 0
  if (typeof body === 'string') return new TextEncoder().encode(body).byteLength
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  return null
}

export function createNetworkActivity() {
  const totals = { local: empty(), external: empty(), unknown: empty() }
  const snapshot = () => ({ local: { ...totals.local }, external: { ...totals.external }, unknown: { ...totals.unknown } })
  async function fetchWithActivity(input: RequestInfo | URL, init: RequestInit = {}, logicalTarget: RequestInfo | URL = input): Promise<Response> {
    const scope = networkScope(logicalTarget)
    const counter = scope === 'local' ? totals.local : scope === 'external' ? totals.external : totals.unknown
    if (init.signal?.aborted) return globalThis.fetch(input, init)
    counter.requests++
    counter.activeRequests++
    const bytes = bodySize(init.body)
    if (bytes === null || (typeof Request !== 'undefined' && input instanceof Request && input.body && init.body === undefined)) counter.unmeasuredBodies++
    else counter.sentBytes += bytes
    let finished = false
    const finish = (failed = false) => {
      if (finished) return
      finished = true
      counter.activeRequests--
      if (failed) counter.failedRequests++
      init.signal?.removeEventListener('abort', abort)
    }
    const abort = () => finish(true)
    init.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await globalThis.fetch(input, init)
      if (!response.body || response.status === 0) { finish(!response.ok); return response }
      const reader = response.body.getReader()
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) { finish(!response.ok); controller.close(); return }
            counter.receivedBytes += next.value.byteLength
            controller.enqueue(next.value)
          } catch (error) { finish(true); controller.error(error) }
        },
        async cancel(reason) { finish(!response.ok); await reader.cancel(reason) },
      }, { highWaterMark: 0 })
      const observed = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperties(observed, { url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type } })
      return observed
    } catch (error) { finish(true); throw error }
  }
  return { snapshot, fetch: fetchWithActivity }
}
const activity = createNetworkActivity()
export const snapshotNetworkActivity = activity.snapshot
export const fetchWithActivity = activity.fetch
