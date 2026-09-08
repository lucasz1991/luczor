/** Session-only HTTP payload counters. URLs, headers and contents are never retained. */
export type NetworkCounters = {
  sentBytes: number
  receivedBytes: number
  requests: number
  activeRequests: number
  failedRequests: number
  unmeasuredBodies: number
}
export type NetworkScope = 'local' | 'external' | 'unknown'

function privateIpv4(parts: number[]): boolean {
  return (
    parts.length === 4 &&
    parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 169 && parts[1] === 254))
  )
}

function privateIpv6(host: string): boolean {
  if (!host.includes(':')) return false
  // URL has already validated and canonicalized IPv6, including dotted mapped IPv4.
  const halves = host.split('::')
  const left = halves[0] ? halves[0].split(':').map(part => parseInt(part, 16)) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').map(part => parseInt(part, 16)) : []
  const words =
    halves.length === 2 ? [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right] : left
  if (words.length !== 8) return false
  if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80) return true
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff)
    return privateIpv4([words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255])
  return false
}

const empty = (): NetworkCounters => ({
  sentBytes: 0,
  receivedBytes: 0,
  requests: 0,
  activeRequests: 0,
  failedRequests: 0,
  unmeasuredBodies: 0,
})

export function networkScope(input: RequestInfo | URL): NetworkScope {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (!['http:', 'https:'].includes(url.protocol)) return 'unknown'
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      privateIpv4(host.split('.').map(Number)) ||
      privateIpv6(host)
    )
      return 'local'
    // A bare intranet hostname has no reliable public/private classification without DNS.
    return host.includes('.') || host.includes(':') ? 'external' : 'unknown'
  } catch {
    return 'unknown'
  }
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
  const snapshot = () => ({
    local: { ...totals.local },
    external: { ...totals.external },
    unknown: { ...totals.unknown },
  })
  async function fetchWithActivity(
    input: RequestInfo | URL,
    init: RequestInit = {},
    logicalTarget: RequestInfo | URL = input
  ): Promise<Response> {
    const scope = networkScope(logicalTarget)
    const counter = scope === 'local' ? totals.local : scope === 'external' ? totals.external : totals.unknown
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined
    const signal = init.signal === undefined ? request?.signal : init.signal
    if (signal?.aborted) return globalThis.fetch(input, init)
    counter.requests++
    counter.activeRequests++
    const bytes = bodySize(init.body)
    if (bytes === null || (request?.body && init.body == null)) counter.unmeasuredBodies++
    else counter.sentBytes += bytes
    let finished = false
    const finish = (failed = false) => {
      if (finished) return
      finished = true
      counter.activeRequests--
      if (failed) counter.failedRequests++
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => finish(true)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await globalThis.fetch(input, init)
      const responseOk = response.ok
      // Instrumentation must not change custom transports or test doubles into
      // native Responses, consume their data, or infer bytes from their fields.
      if (!(response instanceof Response)) {
        counter.unmeasuredBodies++
        finish(!responseOk)
        return response
      }
      if (!response.body || response.status === 0) {
        finish(!response.ok)
        return response
      }
      if (response.bodyUsed || response.body.locked) {
        counter.unmeasuredBodies++
        finish(!response.ok)
        return response
      }
      // Callers often reject HTTP errors from their headers without consuming
      // the response. Do not leave those requests or abort listeners active.
      if (!response.ok) finish(true)
      const body = response.body
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const releaseReader = () => {
        reader?.releaseLock()
        reader = undefined
      }
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              // Acquire lazily: merely awaiting headers must not lock or pull
              // the original body. Clones share this one counting stream.
              reader ??= body.getReader()
              const next = await reader.read()
              if (next.done) {
                releaseReader()
                finish(!response.ok)
                controller.close()
                return
              }
              counter.receivedBytes += next.value.byteLength
              controller.enqueue(next.value)
            } catch (error) {
              releaseReader()
              finish(true)
              controller.error(error)
            }
          },
          async cancel(reason) {
            try {
              await (reader ? reader.cancel(reason) : body.cancel(reason))
              finish(!response.ok)
            } catch (error) {
              finish(true)
              throw error
            } finally {
              releaseReader()
            }
          },
        },
        { highWaterMark: 0 }
      )
      const observed = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      const preserveIdentity = (result: Response): Response => {
        Object.defineProperties(result, {
          url: { value: response.url },
          redirected: { value: response.redirected },
          type: { value: response.type },
          clone: { value: () => preserveIdentity(Response.prototype.clone.call(result)) },
        })
        return result
      }
      return preserveIdentity(observed)
    } catch (error) {
      finish(true)
      throw error
    }
  }
  return { snapshot, fetch: fetchWithActivity }
}
const activity = createNetworkActivity()
export const snapshotNetworkActivity = activity.snapshot
export const fetchWithActivity = activity.fetch
