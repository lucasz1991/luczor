import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => {
  class LuczorApiError extends Error {
    status: number
    code?: string
    constructor(status: number, message: string, _correlationId?: string, code?: string) {
      super(message)
      this.status = status
      this.code = code
    }
  }
  return {
    LuczorApiError,
    requestWithConfig: vi.fn(),
    getApiConfigSnapshot: vi.fn(async () => ({ baseUrl: 'https://luczor.test', deviceKey: 'device', clientId: 'c' })),
  }
})
vi.mock('@/services/api/luczorApi', () => api)

import {
  ClaudeAccessError,
  fetchClaudeAccess,
  NO_CLAUDE_ACCESS,
  parseClaudeAccessStatus,
  removeClaudeKey,
  saveClaudeKey,
  setClaudeKeySource,
  setClaudeProviderFallback,
  syncClaudeAccessEnabled,
  testClaudeAccess,
  validateClaudeKey,
} from '@/services/inference/claudeAccess'
import { DEFAULT_MODEL_USAGE, modelUsageSettings } from '@/services/inference/modelUsageSettings'

// Obviously fake; assembled at runtime so no key-shaped literal lives in the repository.
const TEST_KEY = ['test', 'key', 'NOT', 'REAL', '0123456789'].join('-')
const CONNECTED = {
  source: 'user',
  connected: true,
  masked_key: 'sk-ant-…4f2a',
  last_tested_at: '2026-11-23T14:32:00Z',
  last_test_status: 'ok',
  allowed_sources: ['user', 'organization'],
  provider_fallback: true,
}
const calls = () => api.requestWithConfig.mock.calls.map(([path, options]) => [path, options?.method ?? 'GET'])

beforeEach(() => {
  api.requestWithConfig.mockReset()
  vi.stubGlobal('localStorage', { setItem: vi.fn() })
  modelUsageSettings.value = { ...DEFAULT_MODEL_USAGE }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Claude access status parsing', () => {
  it('reads a complete status', () => {
    expect(parseClaudeAccessStatus(CONNECTED)).toEqual({
      source: 'user',
      connected: true,
      maskedKey: 'sk-ant-…4f2a',
      lastTestedAt: '2026-11-23T14:32:00Z',
      lastTestStatus: 'ok',
      allowedSources: ['user', 'organization'],
      providerFallback: true,
    })
    expect(parseClaudeAccessStatus({ data: CONNECTED }).connected).toBe(true)
  })

  it.each([null, undefined, 'connected', 42, [], [CONNECTED]])('treats %j as no access', value => {
    expect(parseClaudeAccessStatus(value)).toEqual(NO_CLAUDE_ACCESS)
  })

  it('fails closed on doubtful fields', () => {
    expect(parseClaudeAccessStatus({ ...CONNECTED, connected: 'true' }).connected).toBe(false)
    expect(parseClaudeAccessStatus({ ...CONNECTED, connected: 1 }).connected).toBe(false)
    expect(parseClaudeAccessStatus({ ...CONNECTED, source: 'admin' })).toMatchObject({ source: null, connected: false })
    expect(parseClaudeAccessStatus({ ...CONNECTED, allowed_sources: ['organization'] }).connected).toBe(false)
    expect(parseClaudeAccessStatus({ ...CONNECTED, allowed_sources: 'user' }).allowedSources).toEqual([])
    expect(
      parseClaudeAccessStatus({ ...CONNECTED, allowed_sources: ['user', 'root', 'user', 7] }).allowedSources
    ).toEqual(['user'])
    expect(parseClaudeAccessStatus({ ...CONNECTED, provider_fallback: 'yes' }).providerFallback).toBe(false)
    expect(parseClaudeAccessStatus({ ...CONNECTED, last_tested_at: { date: 'x' } }).lastTestedAt).toBeNull()
  })

  it('never passes on a value that is not visibly masked', () => {
    expect(parseClaudeAccessStatus({ ...CONNECTED, masked_key: TEST_KEY }).maskedKey).toBeNull()
    expect(parseClaudeAccessStatus({ ...CONNECTED, masked_key: `${'x'.repeat(90)}…` }).maskedKey).toBeNull()
    expect(parseClaudeAccessStatus({ ...CONNECTED, masked_key: 'sk-ant-••••4f2a' }).maskedKey).toBe('sk-ant-••••4f2a')
  })
})

describe('Claude key validation', () => {
  it('accepts a plain key and trims surrounding whitespace', () => {
    expect(validateClaudeKey(`  ${TEST_KEY}\n`)).toBe(TEST_KEY)
    expect(validateClaudeKey('k'.repeat(512))).toHaveLength(512)
  })

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'k'.repeat(513)],
    ['inner space', 'abc def'],
    ['inner newline', 'abc\ndef'],
    ['tab', 'abc\tdef'],
    ['control character', 'abc\u0000def'],
    ['zero-width character', 'abc​def'],
    ['not a string', 12345 as unknown as string],
  ])('rejects a key that is %s before anything is sent', async (_name, value) => {
    expect(() => validateClaudeKey(value)).toThrow(ClaudeAccessError)
    await expect(saveClaudeKey(value)).rejects.toMatchObject({ code: 'claude_key_malformed' })
    expect(api.requestWithConfig).not.toHaveBeenCalled()
  })
})

describe('Claude access requests', () => {
  it('uses the contract paths and methods and sends the key only in the request body', async () => {
    api.requestWithConfig.mockResolvedValue(CONNECTED)
    await fetchClaudeAccess()
    await saveClaudeKey(TEST_KEY)
    await removeClaudeKey()
    await setClaudeKeySource('organization')
    await setClaudeProviderFallback(false)
    api.requestWithConfig.mockResolvedValueOnce({ ok: true, error_code: null })
    await expect(testClaudeAccess()).resolves.toMatchObject({ ok: true, errorCode: null })

    expect(calls()).toEqual([
      ['/provider-keys/anthropic', 'GET'],
      ['/provider-keys/anthropic', 'PUT'],
      ['/provider-keys/anthropic', 'DELETE'],
      ['/provider-keys/anthropic/source', 'PUT'],
      ['/provider-keys/anthropic/options', 'PUT'],
      ['/provider-keys/anthropic/test', 'POST'],
    ])
    const body = (index: number) => api.requestWithConfig.mock.calls.at(index)?.[1]?.body
    expect(body(1)).toEqual({ api_key: TEST_KEY })
    expect(body(3)).toEqual({ source: 'organization' })
    expect(body(4)).toEqual({ provider_fallback: false })
    for (const [path, opts] of api.requestWithConfig.mock.calls) {
      expect(path).not.toContain(TEST_KEY)
      expect(JSON.stringify({ query: opts.query, headers: opts.headers })).not.toContain(TEST_KEY)
      expect(opts.auth).not.toBe(false)
    }
  })

  it('re-reads the status when a mutation answers without one', async () => {
    api.requestWithConfig.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...CONNECTED, connected: false })
    await expect(removeClaudeKey()).resolves.toMatchObject({ connected: false })
    expect(calls()).toEqual([
      ['/provider-keys/anthropic', 'DELETE'],
      ['/provider-keys/anthropic', 'GET'],
    ])
  })

  it('reports a failed test as a result with a fixed message', async () => {
    api.requestWithConfig.mockResolvedValueOnce({ ok: false, error_code: 'claude_key_invalid' })
    await expect(testClaudeAccess()).resolves.toMatchObject({ ok: false, errorCode: 'claude_key_invalid' })
    api.requestWithConfig.mockResolvedValueOnce({ ok: 'true', error_code: '<b>x</b>' })
    await expect(testClaudeAccess()).resolves.toMatchObject({ ok: false, errorCode: null })
  })

  it.each([
    [422, undefined, 'claude_key_invalid', 'ungültig'],
    [400, 'claude_key_invalid', 'claude_key_invalid', 'ungültig'],
    [502, undefined, 'claude_unreachable', 'Anthropic ist gerade nicht erreichbar'],
    [500, 'claude_unreachable', 'claude_unreachable', 'Anthropic ist gerade nicht erreichbar'],
    [401, undefined, 'not_authenticated', 'nicht angemeldet'],
    [403, undefined, 'forbidden', 'nicht berechtigt'],
    [404, undefined, 'unavailable', 'auf diesem Server nicht verfügbar'],
    [0, undefined, 'offline', 'Luczor-Server ist nicht erreichbar'],
    [500, undefined, 'unknown', 'konnte nicht verarbeitet werden'],
  ])('maps HTTP %s / %s to %s', async (status, serverCode, code, text) => {
    api.requestWithConfig.mockRejectedValue(
      new api.LuczorApiError(status, `server said ${TEST_KEY}`, undefined, serverCode)
    )
    const error = await saveClaudeKey(TEST_KEY).catch(reason => reason)
    expect(error).toBeInstanceOf(ClaudeAccessError)
    expect(error.code).toBe(code)
    expect(error.message).toContain(text)
  })

  it('does not blame the key for a rejected source or option change', async () => {
    api.requestWithConfig.mockRejectedValue(new api.LuczorApiError(422, 'nope'))
    await expect(setClaudeKeySource('user')).rejects.toMatchObject({ code: 'unknown' })
    await expect(setClaudeProviderFallback(true)).rejects.toMatchObject({ code: 'unknown' })
    await expect(setClaudeKeySource('admin' as never)).rejects.toBeInstanceOf(ClaudeAccessError)
  })

  it('never lets the key or server text into a thrown error', async () => {
    const failures = [
      new api.LuczorApiError(422, `invalid key ${TEST_KEY}`),
      new api.LuczorApiError(0, `Verbindung fehlgeschlagen: ${TEST_KEY}`),
      new Error(`boom ${TEST_KEY}`),
      { message: TEST_KEY },
    ]
    for (const failure of failures) {
      api.requestWithConfig.mockRejectedValueOnce(failure)
      const error = await saveClaudeKey(TEST_KEY).catch(reason => reason)
      expect(error).toBeInstanceOf(ClaudeAccessError)
      expect(`${error.message} ${error.stack} ${JSON.stringify(error)} ${String(error.cause ?? '')}`).not.toContain(
        TEST_KEY
      )
      expect(error.message).not.toContain('boom')
    }
  })

  it('writes nothing to the device settings while saving a key', async () => {
    api.requestWithConfig.mockResolvedValue(CONNECTED)
    await saveClaudeKey(TEST_KEY)
    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(JSON.stringify(modelUsageSettings.value)).not.toContain(TEST_KEY)
  })
})

describe('Claude access flag on this device', () => {
  it('persists a changed flag and keeps every other field', async () => {
    modelUsageSettings.value = {
      localModelId: 'local-tier-light',
      externalEnabled: true,
      externalToolsEnabled: true,
      chatRouteMode: 'auto',
      claude: { enabled: false, lastModel: 'model-large' },
    }
    await expect(syncClaudeAccessEnabled(parseClaudeAccessStatus(CONNECTED))).resolves.toBe(true)
    expect(modelUsageSettings.value).toEqual({
      localModelId: 'local-tier-light',
      externalEnabled: true,
      externalToolsEnabled: true,
      chatRouteMode: 'auto',
      claude: { enabled: true, lastModel: 'model-large' },
    })
    expect(localStorage.setItem).toHaveBeenCalledTimes(1)
    const stored = vi.mocked(localStorage.setItem).mock.calls[0]?.[1] ?? ''
    expect(JSON.parse(stored)).toEqual(modelUsageSettings.value)
  })

  it('does not write when nothing changed', async () => {
    await expect(syncClaudeAccessEnabled(NO_CLAUDE_ACCESS)).resolves.toBe(false)
    modelUsageSettings.value = { ...DEFAULT_MODEL_USAGE, claude: { enabled: true, lastModel: null } }
    await expect(syncClaudeAccessEnabled(parseClaudeAccessStatus(CONNECTED))).resolves.toBe(false)
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it('locks a stored Claude mode again when the access is gone', async () => {
    modelUsageSettings.value = {
      ...DEFAULT_MODEL_USAGE,
      chatRouteMode: 'claude_local',
      claude: { enabled: true, lastModel: 'model-large' },
    }
    await expect(syncClaudeAccessEnabled(NO_CLAUDE_ACCESS)).resolves.toBe(true)
    expect(modelUsageSettings.value.claude).toEqual({ enabled: false, lastModel: 'model-large' })
    expect(modelUsageSettings.value.chatRouteMode).toBe('local')
  })
})

describe('Claude API settings section', () => {
  it('renders the access form without a prefilled key and explains a locked server policy', async () => {
    const { createSSRApp } = await import('vue')
    const { renderToString } = await import('vue/server-renderer')
    const { default: ClaudeApiSection } = await import('@/components/settings/ClaudeApiSection.vue')
    const html = await renderToString(createSSRApp(ClaudeApiSection))
    expect(html).toContain('Die Claude-Modi sind auf diesem Server nicht freigeschaltet.')
    expect(html).toMatch(/<input[^>]*type="password"/)
    expect(html).not.toMatch(/<input[^>]*type="password"[^>]* value="[^"]/)
    expect(html).toMatch(/<input[^>]*autocomplete="off"/)
    for (const label of ['Schlüsselquelle', 'Schlüssel prüfen', 'API-Verhalten', 'Wird geladen']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('Bei Ablehnung zuerst ein Claude-Ausweichmodell versuchen')
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/)
    // Nothing is requested during server rendering; the status loads on mount.
    expect(api.requestWithConfig).not.toHaveBeenCalled()
  })
})
