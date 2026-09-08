import { resolveApiFetchUrl } from './endpoint'
import { fetchWithActivity } from '@/services/networkActivity'

/** Preserve request data and the configured identity; replace only the development transport URL. */
export function apiTransportInput(input: RequestInfo | URL): RequestInfo | URL {
  const original = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const target = resolveApiFetchUrl(original, {
    development: import.meta.env.DEV,
    origin: typeof location === 'undefined' ? undefined : location.origin,
  })
  if (target === original) return input
  return typeof input === 'string' || input instanceof URL ? target : new Request(target, input)
}

/** Classify the configured target before Vite rewrites a remote API to its loopback relay. */
export function apiTransportFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetchWithActivity(apiTransportInput(input), init, input)
}
