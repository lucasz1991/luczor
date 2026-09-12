import { apiTransportFetch } from '@/services/api/transportTarget'
import type { LuczorApiConfigSnapshot } from '@/services/api/luczorApi'

export const CHUNK_BYTES = 8 * 1024 * 1024
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new Error('Der Übertragungsblock überschreitet acht MiB.')
  const raw = atob(value)
  if (raw.length > CHUNK_BYTES) throw new Error('Der Übertragungsblock überschreitet acht MiB.')
  return Uint8Array.from(raw, character => character.charCodeAt(0))
}
export function encodeBase64(bytes: Uint8Array): string {
  if (bytes.byteLength > CHUNK_BYTES) throw new Error('Der Übertragungsblock überschreitet acht MiB.')
  let raw = ''
  for (let offset = 0; offset < bytes.length; offset += 32768)
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  return btoa(raw)
}
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
export async function hasRemoteChunk(
  config: LuczorApiConfigSnapshot,
  projectId: number,
  hash: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!Number.isSafeInteger(projectId) || projectId < 1 || !/^[a-f0-9]{64}$/.test(hash) || !config.deviceKey)
    throw new Error('Ungültiger Dateiblock.')
  signal?.throwIfAborted()
  const response = await apiTransportFetch(`${config.baseUrl}/api/v1/projects/${projectId}/mirror/chunks/${hash}`, {
    method: 'HEAD',
    redirect: 'error',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${config.deviceKey}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`Dateiblockprüfung fehlgeschlagen (HTTP ${response.status}).`)
  return true
}
/** Binary mirror/artifact transport deliberately does not inherit the legacy text-file limits. */
export async function binaryRequest(
  config: LuczorApiConfigSnapshot,
  path: string,
  body?: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  if (!/^\/(projects\/\d+\/mirror\/chunks|coordination\/jobs\/[a-f0-9-]+\/artifacts)\/[a-f0-9]{64}$/.test(path))
    throw new Error('Ungültiges Übertragungsziel.')
  if (!config.deviceKey || (body && body.byteLength > CHUNK_BYTES)) throw new Error('Übertragung nicht verfügbar.')
  signal?.throwIfAborted()
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(new Error('Die Dateiübertragung hat zu lange gedauert.')), 180000)
  try {
    const response = await apiTransportFetch(`${config.baseUrl}/api/v1${path}`, {
      method: body ? 'PUT' : 'GET',
      body,
      headers: {
        Authorization: `Bearer ${config.deviceKey}`,
        'Content-Type': 'application/octet-stream',
        Accept: 'application/octet-stream',
      },
      redirect: 'error',
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Dateiübertragung fehlgeschlagen (HTTP ${response.status}).`)
    }
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    if (reader)
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > CHUNK_BYTES) {
          await reader.cancel()
          throw new Error('Der Server hat einen zu großen Block geliefert.')
        }
        chunks.push(part.value)
      }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  } finally {
    clearTimeout(timeout)
  }
}
