import { resolveApiFetchUrl } from './endpoint'

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
