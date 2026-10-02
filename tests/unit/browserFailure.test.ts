import { describe, expect, it } from 'vitest'
import {
  browserFailure,
  browserFailureError,
  browserFailureOutcome,
  getBrowserFailure,
} from '@/services/browserFailure'
import { redactTrace } from '@/services/debugTrace'

const failure = {
  version: 1,
  code: 'workflow_browser_navigation_superseded',
  phase: 'navigation',
  operationId: 'e965c1c9-b415-41a7-b705-6e615a7351e5',
  operation: 'navigate',
  sessionId: 'session-id',
  navigationGeneration: 3,
  navigationId: 9,
  backend: 'webview2',
  backendCode: -1,
  backendDomain: 'WebView2.WebErrorStatus',
  elapsedMs: 41,
  outcome: 'unknown',
  lastReadinessCode: 'browser_page_not_ready',
} as const

describe('safe browser failure diagnostics', () => {
  it('points a navigation timeout at observation rather than restarting the browser', () => {
    const error = browserFailureError({
      ...failure,
      code: 'workflow_browser_navigation_timeout',
      operation: 'open',
      phase: 'readiness',
    })
    expect(browserFailure(error)).toContain('browser_dom_scan')
    expect(browserFailure(error)).toContain('nicht wiederholen')
    expect(getBrowserFailure(error)?.outcome).toBe('unknown')
  })
  it('offers a blank-page basic test only when the task provides no destination', () => {
    const message = browserFailure('workflow_browser_session_unavailable')
    expect(message).toContain('Adresse oder Datei aus dem Auftrag')
    expect(message).toContain('browser_open {}')
    expect(message).toContain('observation')
    expect(message).toContain('keine interaktiven Elemente')
    expect(message).not.toContain('browser_close')
  })
  it('distinguishes invalid references and address mismatches from a failed browser engine', () => {
    expect(browserFailure('browser_ref_stale')).toContain('ungültig oder veraltet')
    expect(browserFailure('browser_ref_stale')).toContain('Suffix')
    expect(browserFailure('browser_url_changed')).toContain('Dokumentadresse')
    expect(browserFailure('browser_url_changed')).toContain('browser_dom_scan')
  })
  it.each([
    'workflow_browser_host_boundary_required',
    'workflow_browser_allowed_hosts_invalid',
    'workflow_browser_host_not_allowed',
  ])('explains legacy %s without requesting host lists', code => {
    const message = browserFailure(code)
    expect(message).toContain('Kompatibilität')
    expect(message).not.toContain('allowed_hosts angeben')
    expect(message).not.toContain('browser_close')
  })
  it('does not require moving a window for DOM browser recovery', () => {
    expect(browserFailure('browser_outside_selected_monitor_move_luczor_window')).toContain('DOM')
    expect(browserFailure('browser_monitor_position_unavailable')).toContain('DOM')
  })
  it('preserves only bounded diagnostic fields and keeps the unknown action outcome visible', () => {
    const raw = { ...failure, url: 'https://PRIVATE.test', cookie: 'PRIVATE', value: 'PRIVATE', reasoning: 'PRIVATE' }
    const error = browserFailureError(raw)
    expect(getBrowserFailure(error)).toEqual(failure)
    expect(browserFailure(error)).toContain('aktuellen Seitenstand')
    expect(browserFailure(error)).toContain('nicht wiederholen')
    expect(browserFailureOutcome(error)).toEqual({
      ok: false,
      error: browserFailure(raw),
      output: { code: failure.code, browserFailure: failure },
    })
    expect(JSON.stringify(browserFailureOutcome(error))).not.toContain('PRIVATE')
  })

  it('keeps legacy browser errors actionable and existing security errors intact', () => {
    expect(browserFailure('browser_selector_invalid')).toContain('browser_dom_scan')
    const security = new Error('Not-Aus aktiv')
    security.name = 'ToolExecutionAuthorityError'
    expect(browserFailureError(security)).toBe(security)
    expect(browserFailure(security)).toBe('Not-Aus aktiv')
    expect(browserFailure(new DOMException('Aborted', 'AbortError'))).toBe('Aborted')
  })

  it('discards unexpected strings, unbounded identifiers and invalid numeric optional metadata', () => {
    const result = getBrowserFailure({
      ...failure,
      sessionId: 'https://PRIVATE.test',
      operationId: 'x'.repeat(3000),
      navigationId: Number.MAX_SAFE_INTEGER + 1,
      navigationGeneration: -1,
      backendCode: Infinity,
      backendDomain: 'PRIVATE\nCookie: value',
      lastReadinessCode: 'https://PRIVATE.test',
    })
    expect(result).toEqual({
      version: 1,
      code: failure.code,
      phase: 'navigation',
      operation: 'navigate',
      backend: 'webview2',
      elapsedMs: 41,
      outcome: 'unknown',
    })
    expect(getBrowserFailure({ ...failure, code: 'workflow_browser_error: PRIVATE' })).toBeUndefined()
    expect(getBrowserFailure({ ...failure, version: 2 })).toBeUndefined()
    expect(getBrowserFailure({ ...failure, phase: 'secret' })).toBeUndefined()
    expect(getBrowserFailure({ ...failure, operation: 'secret' })).toBeUndefined()
    expect(getBrowserFailure({ ...failure, backend: 'secret' })).toBeUndefined()
    expect(getBrowserFailure({ ...failure, elapsedMs: -1 })).toBeUndefined()
    expect(getBrowserFailure({ ...failure, outcome: 'success' })).toBeUndefined()
    expect(browserFailure({ message: 'PRIVATE', url: 'https://PRIVATE.test' })).not.toContain('PRIVATE')
  })

  it('keeps cleanup secondary and redacts session identifiers under the existing debug policy', () => {
    const error = browserFailureError(failure, {
      ...failure,
      code: 'workflow_browser_cleanup_failed',
      operation: 'close',
    })
    const outcome = browserFailureOutcome(error)
    expect(outcome.output).toMatchObject({
      code: failure.code,
      cleanupFailure: { code: 'workflow_browser_cleanup_failed' },
    })
    const debug = redactTrace(outcome)
    expect(debug).toMatchObject({
      output: { browserFailure: { operationId: failure.operationId, sessionId: '[REDACTED]' } },
    })
    expect(browserFailureError(error)).toBe(error)
  })
})

describe('native DOM observation diagnostics', () => {
  it('preserves content-free observation failures without classifying them as effects', () => {
    const diagnostic = {
      version: 1 as const,
      code: 'workflow_browser_url_changed',
      phase: 'dom_observation',
      operation: 'scan',
      backend: 'webview2',
      elapsedMs: 12,
      outcome: 'not_started',
    }
    expect(getBrowserFailure(diagnostic)).toEqual(diagnostic)
    expect(getBrowserFailure({ ...diagnostic, phase: 'arbitrary_page_phase' })).toBeUndefined()
  })
})
