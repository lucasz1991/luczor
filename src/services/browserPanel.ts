import { reactive } from 'vue'
import { getChatPlaygroundState } from '@/services/chatPlayground'

/** Local presentation only. Page contents and URLs are never persisted. */
export const browserPanel = reactive({
  expanded: false,
  projectId: '',
  conversationId: '',
  viewMode: 'mini' as 'mini' | 'window',
  detached: false,
  detachedSessionId: '',
  error: '',
})

export function revealBrowserPanel(projectId: string, conversationId = ''): void {
  browserPanel.projectId = projectId
  browserPanel.conversationId = conversationId
  const playground = getChatPlaygroundState(projectId, conversationId)
  const browserTab = playground.tabs.find(tab => tab.kind === 'browser')
  if (browserTab) playground.activeTabId = browserTab.id
  browserPanel.expanded = true
}

export function browserFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  const messages: Record<string, string> = {
    browser_outside_selected_monitor_move_luczor_window:
      'Bitte das Luczor-Fenster vollständig auf den unter Einstellungen → Bildschirmsteuerung gewählten Bildschirm verschieben.',
    browser_monitor_position_unavailable:
      'Die Position des Luczor-Browsers kann auf diesem System nicht sicher einem Bildschirm zugeordnet werden.',
    workflow_execution_identity_required:
      'Die Browser-Ausführung besitzt keine gültige Sitzungs-ID. Bitte Luczor aktualisieren.',
    workflow_browser_host_boundary_required: 'Bitte beim Öffnen die erlaubten Zielhosts in allowed_hosts angeben.',
    workflow_browser_allowed_hosts_invalid:
      'Die Zielhosts müssen ohne Protokoll oder Pfad angegeben werden, z. B. example.com.',
    workflow_browser_host_not_allowed:
      'Diese Adresse liegt außerhalb der bestätigten Hosts. browser_status mit {} zeigt die Bindung. Zum Wechseln browser_close mit {} und anschließend browser_open mit den bestätigten Zielhosts verwenden. Keine Hosts raten.',
    workflow_browser_url_invalid:
      'Eine HTTP(S)-Adresse, file://-URL oder einen absoluten Dateipfad ohne eingebettete Zugangsdaten verwenden.',
    workflow_browser_host_boundary_unavailable: 'Die sichere Browser-Steuerung ist auf diesem System nicht verfügbar.',
    workflow_browser_requires_windows_webview2: 'Diese Browser-Funktion benötigt Windows/WebView2.',
    workflow_browser_session_unavailable: 'Bitte zuerst browser_open mit der gewünschten Adresse oder Datei ausführen.',
    browser_ref_stale:
      'Das beobachtete Element hat sich geändert. Mit browser_dom_scan neu erfassen und die neue Referenz verwenden.',
    browser_target_ambiguous: 'Mehrere Elemente passen. Mit browser_dom_scan das genaue Ziel auswählen.',
    browser_target_not_actionable:
      'Das Ziel ist verdeckt, deaktiviert oder bewegt sich noch. DOM erneut prüfen; keine unklare Eingabe wiederholen.',
    browser_selector_invalid: 'Ungültiges Elementziel. Eine beobachtete Referenz aus browser_dom_scan verwenden.',
    workflow_browser_owned_by_another_run:
      'Ein anderer Auftrag verwendet den Browser. Dessen Abschluss abwarten; eigene Hostlisten oder browser_close können seine Sitzung nicht übernehmen.',
    workflow_browser_cleanup_pending:
      'Die eigene Browser-Sitzung wird noch geschlossen. Den Abschluss abwarten; noch keine neue Sitzung öffnen.',
    workflow_browser_cleanup_failed:
      'Die eigene Browser-Sitzung konnte nicht geschlossen werden. browser_close mit {} kann die Bereinigung erneut versuchen.',
    workflow_browser_url_changed:
      'Die Seite hat sich seit dem letzten Aufruf geändert. Bitte den aktuellen Seitenstand erneut lesen.',
    workflow_browser_navigation_timeout:
      'Die Seite wurde nicht rechtzeitig geladen. Adresse und Verbindung prüfen, bevor erneut navigiert wird.',
    workflow_browser_session_busy: 'Der Browser führt gerade eine andere Aktion aus. Deren Abschluss abwarten.',
  }
  const message = Object.hasOwn(messages, code) ? Reflect.get(messages, code) : undefined
  return message ? `${message} (${code})` : code
}
