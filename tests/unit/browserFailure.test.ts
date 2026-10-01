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
