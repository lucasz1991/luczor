/** The configured account URL remains authoritative for identity and signatures. */
export const DEFAULT_API_BASE_URL = 'https://luczor.follow-flow.de'
export const DEV_API_PREFIX = '/__luczor_api'

/** Only Vite's loopback development server may relay this fixed public API. */
export function resolveApiFetchUrl(requestUrl: string, environment: { development: boolean; origin?: string }): string {
  if (!environment.development || !environment.origin) return requestUrl
  try {
    const page = new URL(environment.origin)
    const target = new URL(requestUrl)
    if (
      !['http:', 'https:'].includes(page.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(page.hostname) ||
      target.origin !== DEFAULT_API_BASE_URL ||
      target.username ||
      target.password ||
      !target.pathname.startsWith('/api/v1/')
    )
      return requestUrl
    return `${page.origin}${DEV_API_PREFIX}${target.pathname}${target.search}`
  } catch {
    return requestUrl
  }
}
