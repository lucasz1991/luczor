import type { RepositoryGraphStatus } from './repositoryGraph'

const reasons = new Map<string, string>([
  ['lsp_runtime_missing', 'LSP-Runtime fehlt oder ist unvollständig. Desktop-App reparieren/aktualisieren.'],
  ['lsp_runtime_invalid', 'LSP-Runtime passt nicht zur App-Version. Desktop-App aktualisieren.'],
  ['lsp_integrity_failed', 'Integritätsprüfung fehlgeschlagen. Verwaltete LSP-Runtime neu installieren.'],
  ['lsp_snapshot_failed', 'Geschützter Analyseordner konnte nicht angelegt werden. Freien Speicher und Rechte prüfen.'],
  ['lsp_input_invalid', 'Analysedaten konnten nicht vorbereitet werden.'],
  ['lsp_worker_start_failed', 'Analyseprozess konnte nicht gestartet werden. App-Installation prüfen.'],
  ['lsp_worker_timeout', 'Gesamtes Zeitbudget erreicht. Indexierung erneut starten.'],
  ['lsp_worker_failed', 'Analyseprozess wurde unerwartet beendet. Runtime und freien Arbeitsspeicher prüfen.'],
  ['lsp_response_limit', 'Analyseantwort überschritt das Sicherheitslimit.'],
  ['lsp_protocol_error', 'Ungültige Antwort der LSP-Runtime. Desktop-App aktualisieren.'],
  ['lsp_server_start_failed', 'TypeScript-Sprachserver konnte nicht starten. Runtime prüfen.'],
  ['lsp_server_exited', 'TypeScript-Sprachserver wurde beendet. Runtime und freien Arbeitsspeicher prüfen.'],
  [
    'lsp_request_timeout',
    'Eine Datei benötigte zu lange. Übrige Dateien werden weiter geprüft; erneut indexieren zum Wiederholen.',
  ],
  ['lsp_request_rejected', 'Sprachserver konnte eine Datei nicht analysieren. Vorhandene Ergebnisse bleiben erhalten.'],
  ['lsp_capability_missing', 'Sprachserver unterstützt die benötigte Symbol-/Referenzanalyse nicht.'],
  ['lsp_batch_limit', 'Teilauftrag abgeschlossen. Nächste Indexierung setzt am gespeicherten Fortschritt fort.'],
  ['lsp_source_limit', 'Schutzlimit für Anzahl oder Größe der Quelldateien erreicht; nicht alle Dateien analysiert.'],
  ['lsp_file_failures', 'Einzelne Dateien noch nicht analysiert. Erneut indexieren zum Wiederholen.'],
  ['lsp_analysis_failed', 'LSP-Analyse fehlgeschlagen. Erneut indexieren; bei Wiederholung App-Diagnose prüfen.'],
])
const phases = new Map([
  ['runtime', 'Runtime prüfen/starten'],
  ['initialize', 'Sprachserver initialisieren'],
  ['symbols', 'Symbole lesen'],
  ['references', 'Referenzen ermitteln'],
  ['complete', 'Abgeschlossen'],
])

/** Fixed public labels only: never render arbitrary worker errors or private paths. */
export function repositoryLspDetail(lsp: RepositoryGraphStatus['lsp']): string {
  if (!lsp) return ''
  const reason = lsp.reason ? (reasons.get(lsp.reason) ?? reasons.get('lsp_analysis_failed')) : undefined
  const legacy =
    lsp.status === 'error' && !reason
      ? 'Dieser ältere Lauf enthält keinen Fehlergrund. Mit aktualisierter App erneut indexieren.'
      : undefined
  return [
    phases.get(lsp.phase ?? ''),
    reason ?? legacy,
    lsp.failed_files && Number.isFinite(lsp.failed_files) && lsp.failed_files > 0
      ? `${Math.floor(lsp.failed_files)} Dateien ohne abgeschlossene Analyse`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}
