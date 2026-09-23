import { fetchBoundedResponseWithTimeout } from '@/services/api/luczorApi'
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import type { MemoryServerCapabilities } from './memorySyncState'

export class MemorySyncHttpError extends Error {
  constructor(readonly status: number) {
    super(`memory_sync_http_${status}`)
  }
}

/** Frozen verified destination for the complete request; never re-read credentials midway. */
export async function memoryServerRequest<T>(
  snapshot: VerifiedAccountSnapshot,
  path: '/memory/capabilities' | '/memory/changes' | '/memory/deletion-receipt',
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const { response, text } = await fetchBoundedResponseWithTimeout(
    `${snapshot.config.baseUrl.replace(/\/+$/u, '')}/api/v1${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${snapshot.config.deviceKey}`,
        'X-Client-ID': snapshot.config.clientId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: 'error',
      credentials: 'omit',
    },
    10_000,
    4 * 1024 * 1024
  )
  if (!response.ok) throw new MemorySyncHttpError(response.status)
  return JSON.parse(text) as T
}

type CacheEntry = { expiresAt: number; value?: MemoryServerCapabilities; pending?: Promise<MemoryServerCapabilities> }
const cache = new Map<string, CacheEntry>()
export function clearMemoryCapabilitiesCache(): void {
  cache.clear()
}
if (typeof window !== 'undefined') {
  window.addEventListener('luczor:api-identity-changing', clearMemoryCapabilitiesCache)
  window.addEventListener('luczor:api-identity-changed', clearMemoryCapabilitiesCache)
}

export async function getMemoryServerCapabilities(
  snapshot: VerifiedAccountSnapshot,
  options: { signal?: AbortSignal; force?: boolean } = {}
): Promise<MemoryServerCapabilities> {
  const key = JSON.stringify([snapshot.principalId, snapshot.serverInstance, snapshot.config.clientId])
  const existing = cache.get(key)
  if (existing?.pending) return existing.pending
  if (!options.force && existing?.value && existing.expiresAt > Date.now()) return { ...existing.value }
  const entry: CacheEntry = { expiresAt: 0 }
  const pending = (async () => {
    let value: MemoryServerCapabilities
    try {
      const result = await memoryServerRequest<{ capabilities?: MemoryServerCapabilities }>(
        snapshot,
        '/memory/capabilities',
        undefined,
        options.signal
      )
      value = result.capabilities ?? {}
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_memory_capabilities')
    } catch (error) {
      // Older servers retain local annotations; do not hammer their maintenance throttle.
      if (!(error instanceof MemorySyncHttpError) || ![404, 405].includes(error.status)) throw error
      value = {}
    }
    entry.value = structuredClone(value)
    entry.expiresAt = Date.now() + 5 * 60_000
    return structuredClone(value)
  })()
  entry.pending = pending
  cache.set(key, entry)
  try {
    return await pending
  } finally {
    entry.pending = undefined
    if (!entry.value && cache.get(key) === entry) cache.delete(key)
  }
}
