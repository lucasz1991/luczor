const phases = [
  'validation',
  'admission',
  'navigation_start',
  'navigation',
  'readiness',
  'dom_prepare',
  'dom_effect',
  'dom_observation',
  'operation',
] as const
const operations = [
  'open',
  'navigate',
  'click',
  'fill',
  'select',
  'wait',
  'read',
  'scan',
  'screenshot',
  'download',
  'close',
] as const
const backends = ['webview2', 'webkitgtk', 'unavailable'] as const

/** Content-free native diagnostics. Optional fields are discarded when not safe to retain. */
export type BrowserFailureDiagnostic = Readonly<{
  version: 1
  code: string
  phase: (typeof phases)[number]
  operationId?: string
  operation: (typeof operations)[number]
  sessionId?: string
  navigationGeneration?: number
  navigationId?: number
  backend: (typeof backends)[number]
  backendCode?: number
  backendDomain?: string
  elapsedMs: number
  outcome: 'not_started' | 'unknown'
  lastReadinessCode?: string
}>

type CleanupFailure = { code: string; diagnostic?: BrowserFailureDiagnostic }
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
function code(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && /^(?:workflow_browser_|browser_)[a-z0-9_]+$/u.test(value)
}
function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.includes(value as T)
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,95}$/iu.test(value)
}

export function getBrowserFailure(error: unknown): BrowserFailureDiagnostic | undefined {
  const record = object(error)
  const source = error instanceof BrowserOperationError ? object(error.browserFailure) : record
  if (
    !source ||
    source.version !== 1 ||
    !code(source.code) ||
    !member(source.phase, phases) ||
    !member(source.operation, operations) ||
    !member(source.backend, backends) ||
    !integer(source.elapsedMs) ||
    !member(source.outcome, ['not_started', 'unknown'] as const)
  )
    return undefined
  return {
    version: 1,
    code: source.code,
    phase: source.phase,
    operation: source.operation,
    backend: source.backend,
    elapsedMs: source.elapsedMs,
    outcome: source.outcome,
    ...(identifier(source.operationId) ? { operationId: source.operationId } : {}),
    ...(identifier(source.sessionId) ? { sessionId: source.sessionId } : {}),
    ...(integer(source.navigationGeneration) ? { navigationGeneration: source.navigationGeneration } : {}),
    ...(integer(source.navigationId) ? { navigationId: source.navigationId } : {}),
    ...(integer(source.backendCode, -2147483648) && source.backendCode <= 2147483647
      ? { backendCode: source.backendCode }
      : {}),
    ...(typeof source.backendDomain === 'string' && /^[a-z0-9_.-]{1,80}$/iu.test(source.backendDomain)
      ? { backendDomain: source.backendDomain }
      : {}),
    ...(code(source.lastReadinessCode) ? { lastReadinessCode: source.lastReadinessCode } : {}),
  }
}

const messages: Record<string, string> = {
  browser_outside_selected_monitor_move_luczor_window:
    'Die Browser-Runtime meldet eine veraltete Bildschirmbindung. DOM-Steuerung benötigt keine Bildschirmzuordnung; Kompatibilität der installierten Runtime prüfen.',
  browser_monitor_position_unavailable:
    'Die Browser-Runtime meldet eine veraltete Bildschirmprüfung. DOM-Steuerung benötigt keine Bildschirmzuordnung; Kompatibilität der installierten Runtime prüfen.',
  workflow_execution_identity_required:
    'Die Browser-Ausführung besitzt keine gültige Sitzungs-ID. Bitte Luczor aktualisieren.',
  workflow_browser_host_boundary_required:
    'Die Runtime erwartet eine frühere Hostbegrenzung. Der interne Browser benötigt keine Hostliste; Kompatibilität der installierten Runtime prüfen.',
  workflow_browser_allowed_hosts_invalid:
    'Die Runtime meldet ein früheres Hostlistenformat. Der interne Browser benötigt keine Hostliste; Kompatibilität der installierten Runtime prüfen.',
  workflow_browser_host_not_allowed:
    'Die Runtime meldet eine frühere Hostbegrenzung. HTTP(S)-Domains und lokale Dateien sind zulässig; Kompatibilität der installierten Runtime prüfen.',
  workflow_browser_url_invalid:
    'Eine HTTP(S)-Adresse, file://-URL oder einen absoluten Dateipfad ohne eingebettete Zugangsdaten verwenden.',
  workflow_browser_host_boundary_unavailable: 'Die sichere Browser-Steuerung ist auf diesem System nicht verfügbar.',
  workflow_browser_requires_windows_webview2: 'Diese Browser-Funktion benötigt Windows/WebView2.',
  workflow_browser_session_unavailable:
    'Dieser Auftrag besitzt keine Browsersitzung. Zuerst browser_open mit der Adresse oder Datei aus dem Auftrag ausführen. Für einen angeforderten Grundtest ohne Ziel: browser_open {}. Der Aufruf liefert den DOM unter observation mit. Eine neue leere Seite enthält keine interaktiven Elemente; damit sind nur Öffnen und Lesen, keine Formularaktionen geprüft. Keine Website erfinden.',
  browser_ref_stale:
    'Die Elementreferenz ist ungültig oder veraltet. Einen eindeutigen beobachteten Selektor oder die vollständige Referenz einschließlich Suffix unverändert übernehmen. Bei verändertem Seitenstand mit browser_dom_scan neu erfassen.',
  browser_target_ambiguous: 'Mehrere Elemente passen. Mit browser_dom_scan das genaue Ziel auswählen.',
  browser_target_not_actionable:
    'Das Ziel ist verdeckt, deaktiviert oder bewegt sich noch. DOM erneut prüfen; keine unklare Eingabe wiederholen.',
  browser_selector_invalid: 'Ungültiges Elementziel. Eine beobachtete Referenz aus browser_dom_scan verwenden.',
  browser_target_missing:
    'Das Element ist nicht mehr vorhanden. Mit browser_dom_scan neu erfassen und ein beobachtetes Ziel verwenden.',
  browser_target_missing_or_ambiguous:
    'Das Element fehlt oder ist nicht eindeutig. Mit browser_dom_scan neu erfassen und eine beobachtete Referenz verwenden.',
  browser_target_type_invalid:
    'Das Ziel unterstützt diese Eingabe nicht. Mit browser_dom_scan das passende Eingabefeld oder Auswahlfeld bestimmen.',
  workflow_browser_selector_required: 'Das Elementziel fehlt. Mit browser_dom_scan eine gültige Referenz ermitteln.',
  workflow_browser_owned_by_another_run:
    'Ein anderer Auftrag verwendet den Browser. Dessen Abschluss abwarten; browser_close kann seine Sitzung nicht übernehmen.',
  workflow_browser_cleanup_pending:
    'Die eigene Browser-Sitzung wird noch geschlossen. Den Abschluss abwarten; noch keine neue Sitzung öffnen.',
  workflow_browser_cleanup_failed:
    'Die eigene Browser-Sitzung konnte nicht geschlossen werden. browser_close mit {} kann die Bereinigung erneut versuchen.',
  workflow_browser_url_changed:
    'Die Seite hat sich seit dem letzten Aufruf geändert. Bitte den aktuellen Seitenstand erneut lesen.',
  browser_url_changed:
    'Die Dokumentadresse stimmt nicht mit dem erwarteten Seitenstand überein. Mit browser_dom_scan den aktuellen Inhalt prüfen; die vorherige Aktion nicht unverändert wiederholen.',
  workflow_browser_navigation_changed:
    'Ein anderer Seitenwechsel hat diesen Vorgang überholt. Bitte den aktuellen Seitenstand mit browser_dom_scan erneut lesen.',
  workflow_browser_navigation_superseded:
    'Der Seitenwechsel wurde durch einen neueren Vorgang ersetzt. Bitte den aktuellen Seitenstand mit browser_dom_scan erneut lesen.',
  workflow_browser_navigation_failed:
    'Der native Browser hat den Seitenwechsel als fehlgeschlagen gemeldet. Mit browser_dom_scan den aktuellen Seitenstand prüfen; browser_status zeigt nur Sitzungsmetadaten.',
  workflow_browser_navigation_timeout:
    'Das Laden der Seite wurde nicht rechtzeitig bestätigt. Mit browser_dom_scan den aktuellen Seitenstand der eigenen Sitzung prüfen; browser_status zeigt nur Sitzungsmetadaten.',
  workflow_browser_action_failed_outcome_unknown: 'Die Browseraktion wurde nicht bestätigt.',
  workflow_browser_protocol_failed_outcome_unknown: 'Die native Rückmeldung zur Browseraktion ist ausgeblieben.',
  workflow_browser_session_busy: 'Der Browser führt gerade eine andere Aktion aus. Deren Abschluss abwarten.',
}

function failureCode(error: unknown): string | undefined {
  const diagnostic = getBrowserFailure(error)
  if (diagnostic) return diagnostic.code
  if (error instanceof BrowserOperationError) return error.code
  const legacy = error instanceof Error ? error.message : error
  return code(legacy) ? legacy : undefined
}

export function browserFailure(error: unknown): string {
  if (error instanceof BrowserOperationError) return error.message
  const diagnostic = getBrowserFailure(error)
  const legacy = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const key = diagnostic?.code ?? legacy
  const message = Object.hasOwn(messages, key) ? (Reflect.get(messages, key) as string) : undefined
  const text = message
    ? `${message} (${key})`
    : key || 'Der interne Browser hat einen Fehler ohne verwertbare Diagnose gemeldet.'
  const unknown = diagnostic?.outcome === 'unknown' || key.endsWith('_outcome_unknown')
  return unknown
    ? `${text} Die Wirkung ist unbekannt: Aktion nicht wiederholen; zuerst den aktuellen Seitenstand prüfen.`
    : text
}

class BrowserOperationError extends Error {
  readonly code?: string
  readonly browserFailure?: BrowserFailureDiagnostic
  readonly cleanupFailure?: CleanupFailure
  constructor(error: unknown, cleanupError?: unknown) {
    super(browserFailure(error))
    this.name = 'BrowserOperationError'
    this.code = failureCode(error)
    this.browserFailure = getBrowserFailure(error)
    const cleanupCode = failureCode(cleanupError)
    if (cleanupCode) {
      const diagnostic = getBrowserFailure(cleanupError)
      this.cleanupFailure = { code: cleanupCode, ...(diagnostic ? { diagnostic } : {}) }
    }
  }
}

/** Do not change the identity of cancellation/authority errors or retain raw native content. */
export function browserFailureError(error: unknown, cleanupError?: unknown): Error {
  if (error instanceof BrowserOperationError) return error
  if (error instanceof Error && !failureCode(error)) return error
  return new BrowserOperationError(error, cleanupError)
}

/** The existing tool.response trace consumes this same allowlisted public result. */
export function browserFailureOutcome(error: unknown): { ok: false; error: string; output?: Record<string, unknown> } {
  const diagnostic = getBrowserFailure(error)
  const primaryCode = failureCode(error)
  const cleanup = error instanceof BrowserOperationError ? error.cleanupFailure : undefined
  return {
    ok: false,
    error: browserFailure(error),
    ...(primaryCode
      ? {
          output: {
            code: primaryCode,
            ...(diagnostic ? { browserFailure: diagnostic } : {}),
            ...(cleanup ? { cleanupFailure: cleanup } : {}),
          },
        }
      : {}),
  }
}
