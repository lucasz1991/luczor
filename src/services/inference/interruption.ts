/** Public diagnostics use fixed codes; arbitrary abort reasons may contain private data. */
export const EXECUTION_ABORT_CODES = [
  'user_stop',
  'execution_scope_changed',
  'execution_workspace_changed',
  'execution_mode_changed',
  'execution_kill_switch',
  'execution_session_changed',
] as const
export type ExecutionAbortCode = (typeof EXECUTION_ABORT_CODES)[number]

export function executionAbortReason(code: ExecutionAbortCode): DOMException {
  return new DOMException(code, 'AbortError')
}

export function interruptionCode(signal: AbortSignal): ExecutionAbortCode | 'execution_interrupted' {
  const message = signal.reason instanceof Error ? signal.reason.message : ''
  return EXECUTION_ABORT_CODES.find(code => code === message) ?? 'execution_interrupted'
}

export function interruptionMessage(signal: AbortSignal): string {
  switch (interruptionCode(signal)) {
    case 'user_stop':
      return 'Abgebrochen.'
    case 'execution_scope_changed':
      return 'Unterbrochen: Das aktive Projekt wurde gewechselt. Der bisherige Fortschritt bleibt erhalten.'
    case 'execution_workspace_changed':
      return 'Unterbrochen: Die Projektordner-Zuordnung wurde geändert. Der bisherige Fortschritt bleibt erhalten.'
    case 'execution_mode_changed':
      return 'Unterbrochen: Der Zugriffsmodus wurde geändert. Der bisherige Fortschritt bleibt erhalten.'
    case 'execution_kill_switch':
      return 'Durch Not-Aus gestoppt. Der bisherige Fortschritt bleibt erhalten.'
    case 'execution_session_changed':
      return 'Unterbrochen: Die Anwendung oder Benutzerverbindung wurde neu geladen. Der bisherige Fortschritt bleibt erhalten.'
    default:
      return 'Die Ausführung wurde unterbrochen. Der bisherige Fortschritt bleibt erhalten.'
  }
}

/** A transport can reject with AbortError without the user or execution gate stopping it. */
export function unexpectedInferenceInterruption(error: unknown): { code: string; message: string } | null {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined
  if (name === 'AbortError')
    return {
      code: 'runtime_transport_interrupted',
      message:
        'Die Modellverbindung wurde unerwartet unterbrochen. Der bisherige Fortschritt bleibt erhalten. Bitte erneut fortsetzen.',
    }
  if (name === 'TimeoutError')
    return {
      code: 'runtime_timeout',
      message:
        'Die Modellanfrage hat ihr Zeitlimit erreicht. Der bisherige Fortschritt bleibt erhalten. Bitte erneut fortsetzen.',
    }
  return null
}
