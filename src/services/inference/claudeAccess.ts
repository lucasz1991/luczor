import { getApiConfigSnapshot, LuczorApiError, requestWithConfig, type RequestOptions } from '@/services/api/luczorApi'
import type { ClaudeKeySource } from './claudeMain'
import { modelUsageSettings, saveModelUsageSettings } from './modelUsageSettings'

/**
 * Client for the server-held Anthropic key (`/provider-keys/anthropic`, device-key auth, ability
 * `provider.keys`). The key is sent once in a request body and is never stored, logged, echoed in
 * an error or placed in a URL on this device; only the server's masked form is ever read back.
 */
export type ClaudeAccessStatus = Readonly<{
  /** Which key the account currently uses; `null` while nothing is configured. */
  source: ClaudeKeySource | null
  connected: boolean
  /** Server-masked form such as `sk-ant-…4f2a`; never the key itself. */
  maskedKey: string | null
  lastTestedAt: string | null
  lastTestStatus: string | null
  allowedSources: readonly ClaudeKeySource[]
  /** Try Anthropic's server-side fallback model before the local hand-over. */
  providerFallback: boolean
}>

export type ClaudeAccessTestResult = Readonly<{ ok: boolean; errorCode: string | null; message: string }>

export type ClaudeAccessErrorCode =
  | 'claude_key_invalid'
  | 'claude_unreachable'
  | 'claude_key_malformed'
  | 'not_authenticated'
  | 'forbidden'
  | 'unavailable'
  | 'offline'
  | 'unknown'

export const NO_CLAUDE_ACCESS: ClaudeAccessStatus = Object.freeze({
  source: null,
  connected: false,
  maskedKey: null,
  lastTestedAt: null,
  lastTestStatus: null,
  allowedSources: Object.freeze([]),
  providerFallback: false,
})

const MESSAGES: Readonly<Record<ClaudeAccessErrorCode, string>> = Object.freeze({
  claude_key_invalid: 'Der Schlüssel ist ungültig. Bitte prüfe ihn in der Anthropic-Konsole.',
  claude_unreachable: 'Anthropic ist gerade nicht erreichbar. Bitte versuche es später erneut.',
  claude_key_malformed:
    'Bitte gib einen vollständigen API-Schlüssel ohne Leerzeichen oder Zeilenumbrüche ein (höchstens 512 Zeichen).',
  not_authenticated: 'Dieses Gerät ist nicht angemeldet. Bitte verbinde es unter Einstellungen → Server.',
  forbidden: 'Dieses Gerät ist für die Verwaltung des Claude-Zugangs nicht berechtigt.',
  unavailable: 'Die Verwaltung des Claude-Zugangs ist auf diesem Server nicht verfügbar.',
  offline: 'Der Luczor-Server ist nicht erreichbar. Bitte prüfe die Verbindung.',
  unknown: 'Der Claude-Zugang konnte nicht verarbeitet werden. Bitte versuche es erneut.',
})

/** Carries only a fixed German message and a closed code — never server text or request data. */
export class ClaudeAccessError extends Error {
  readonly code: ClaudeAccessErrorCode

  constructor(code: ClaudeAccessErrorCode) {
    // `code` is a member of the closed ClaudeAccessErrorCode union.
    // eslint-disable-next-line security/detect-object-injection
    super(MESSAGES[code])
    this.name = 'ClaudeAccessError'
    this.code = code
  }
}

export function claudeAccessMessage(code: ClaudeAccessErrorCode): string {
  // eslint-disable-next-line security/detect-object-injection
  return MESSAGES[code]
}

const BASE = '/provider-keys/anthropic'
const MAX_KEY_LENGTH = 512
/** Any whitespace, control or invisible formatting character disqualifies a pasted key. */
const UNSAFE_KEY_CHARACTER = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
// The server masks as `sk-a...4f2a`; other mask glyphs are accepted as well.
const MASK_CHARACTER = /…|•|\*|\.{3}/u
const KEY_TEST_TIMEOUT_MS = 30_000

function isSource(value: unknown): value is ClaudeKeySource {
  return value === 'user' || value === 'organization'
}

function shortText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= limit && !/\p{Cc}/u.test(text) ? text : null
}

/** Only a visibly masked value is shown; anything that could be a complete key is dropped. */
function maskedKey(value: unknown): string | null {
  const text = shortText(value, 80)
  return text && MASK_CHARACTER.test(text) && !/\s/.test(text) ? text : null
}

/** Fail-closed parse of the untrusted status body: every doubtful field reads as "not connected". */
export function parseClaudeAccessStatus(value: unknown): ClaudeAccessStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return NO_CLAUDE_ACCESS
  const outer = value as Record<string, unknown>
  // Laravel resources may wrap the payload in `data`.
  const raw = (
    outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data) ? outer.data : outer
  ) as Record<string, unknown>
  const source = isSource(raw.source) ? raw.source : null
  const allowedSources = Object.freeze([
    ...new Set((Array.isArray(raw.allowed_sources) ? raw.allowed_sources : []).filter(isSource)),
  ])
  return Object.freeze({
    source,
    // A connection without a known, permitted source is not a usable access.
    connected: raw.connected === true && source !== null && allowedSources.includes(source),
    maskedKey: maskedKey(raw.masked_key),
    lastTestedAt: shortText(raw.last_tested_at, 40),
    lastTestStatus: shortText(raw.last_test_status, 64),
    allowedSources,
    providerFallback: raw.provider_fallback === true,
  })
}

/** Shape check before the key leaves the input field; returns the trimmed key or throws a fixed message. */
export function validateClaudeKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key || key.length > MAX_KEY_LENGTH || UNSAFE_KEY_CHARACTER.test(key)) {
    throw new ClaudeAccessError('claude_key_malformed')
  }
  return key
}

/** `keyCheck`: the request makes the server contact Anthropic with a key, so 422/5xx describe that key check. */
function errorCode(error: unknown, keyCheck: boolean): ClaudeAccessErrorCode {
  if (error instanceof ClaudeAccessError) return error.code
  if (!(error instanceof LuczorApiError)) return 'unknown'
  if (error.code === 'claude_key_invalid' || error.code === 'claude_unreachable') return error.code
  switch (error.status) {
    case 0:
      return 'offline'
    case 401:
      return 'not_authenticated'
    case 403:
      return 'forbidden'
    case 404:
    case 405:
    case 501:
      return 'unavailable'
    case 422:
      return keyCheck ? 'claude_key_invalid' : 'unknown'
    case 502:
    case 503:
    case 504:
      return keyCheck ? 'claude_unreachable' : 'offline'
    default:
      return 'unknown'
  }
}

/** Replaces every transport error by a fixed message so neither server text nor request data can surface. */
async function call(path: string, options: RequestOptions = {}, keyCheck = false): Promise<unknown> {
  try {
    return await requestWithConfig<unknown>(`${BASE}${path}`, options, await getApiConfigSnapshot())
  } catch (error) {
    throw new ClaudeAccessError(errorCode(error, keyCheck))
  }
}

function looksLikeStatus(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const outer = value as Record<string, unknown>
  const raw = (outer.data && typeof outer.data === 'object' ? outer.data : outer) as Record<string, unknown>
  return typeof raw.connected === 'boolean'
}

/** Mutations answer with the new status; an empty or foreign body is replaced by a fresh read. */
async function statusAfter(response: unknown): Promise<ClaudeAccessStatus> {
  return looksLikeStatus(response) ? parseClaudeAccessStatus(response) : fetchClaudeAccess()
}

export async function fetchClaudeAccess(signal?: AbortSignal): Promise<ClaudeAccessStatus> {
  return parseClaudeAccessStatus(await call('', { signal }))
}

/** Sends the key once over the authenticated API. The server verifies it before storing it encrypted. */
export async function saveClaudeKey(apiKey: string): Promise<ClaudeAccessStatus> {
  const key = validateClaudeKey(apiKey)
  return statusAfter(await call('', { method: 'PUT', body: { api_key: key }, timeoutMs: KEY_TEST_TIMEOUT_MS }, true))
}

/** Asks the server to test the stored access; a failed test is a result, not an exception. */
export async function testClaudeAccess(): Promise<ClaudeAccessTestResult> {
  const response = await call('/test', { method: 'POST', timeoutMs: KEY_TEST_TIMEOUT_MS }, true)
  const raw = (response && typeof response === 'object' ? response : {}) as Record<string, unknown>
  const ok = raw.ok === true
  const errorCodeText =
    typeof raw.error_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw.error_code) ? raw.error_code : null
  if (ok)
    return Object.freeze({ ok: true, errorCode: null, message: 'Verbindung geprüft. Der Claude-Zugang funktioniert.' })
  const known: ClaudeAccessErrorCode =
    errorCodeText === 'claude_key_invalid' || errorCodeText === 'claude_unreachable' ? errorCodeText : 'unknown'
  return Object.freeze({
    ok: false,
    errorCode: errorCodeText,
    message:
      known === 'unknown' ? 'Die Prüfung ist fehlgeschlagen. Bitte versuche es erneut.' : claudeAccessMessage(known),
  })
}

export async function removeClaudeKey(): Promise<ClaudeAccessStatus> {
  return statusAfter(await call('', { method: 'DELETE' }))
}

export async function setClaudeKeySource(source: ClaudeKeySource): Promise<ClaudeAccessStatus> {
  if (!isSource(source)) throw new ClaudeAccessError('unknown')
  return statusAfter(await call('/source', { method: 'PUT', body: { source } }))
}

/** Store the composer's model choice with the account so the user's other devices start with it. */
export async function setClaudePreferredModel(model: string): Promise<void> {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(model)) throw new ClaudeAccessError('unknown')
  await call('/options', { method: 'PUT', body: { preferred_model: model } })
}

export async function setClaudeProviderFallback(value: boolean): Promise<ClaudeAccessStatus> {
  return statusAfter(await call('/options', { method: 'PUT', body: { provider_fallback: value === true } }))
}

/**
 * Mirrors "a verified access exists" into the device settings so the Claude modes unlock or lock.
 * Writes only when the flag changed and keeps every other field. Returns whether it wrote.
 */
export async function syncClaudeAccessEnabled(status: Pick<ClaudeAccessStatus, 'connected'>): Promise<boolean> {
  const current = modelUsageSettings.value
  const enabled = status.connected === true
  if ((current.claude?.enabled === true) === enabled) return false
  await saveModelUsageSettings({
    ...current,
    claude: { lastModel: current.claude?.lastModel ?? null, enabled },
  })
  return true
}
