import { reactive } from 'vue'

/** Local presentation only. Page contents and URLs are never persisted. */
export const browserPanel = reactive({ expanded: false, projectId: '', error: '' })

export function revealBrowserPanel(projectId: string): void {
  browserPanel.projectId = projectId
  browserPanel.expanded = true
}

export function browserFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  const messages: Record<string, string> = {
    workflow_execution_identity_required:
      'Die Browser-Ausführung besitzt keine gültige Sitzungs-ID. Bitte Luczor aktualisieren.',
    workflow_browser_host_boundary_required: 'Bitte beim Öffnen die erlaubten Zielhosts in allowed_hosts angeben.',
    workflow_browser_allowed_hosts_invalid:
      'Die Zielhosts müssen ohne Protokoll oder Pfad angegeben werden, z. B. example.com.',
    workflow_browser_host_not_allowed: 'Diese Adresse gehört nicht zu den bestätigten Hosts der Browser-Sitzung.',
    workflow_browser_host_boundary_unavailable: 'Die sichere Browser-Steuerung ist auf diesem System nicht verfügbar.',
    workflow_browser_requires_windows_webview2: 'Diese Browser-Funktion benötigt Windows/WebView2.',
    workflow_browser_session_unavailable: 'Bitte zuerst browser_open mit den erlaubten Hosts ausführen.',
    workflow_browser_owned_by_another_run:
      'Der Browser wird bereits von einer anderen Sitzung verwendet. Diese zuerst beenden.',
    workflow_browser_url_changed:
      'Die Seite hat sich seit dem letzten Aufruf geändert. Bitte den aktuellen Seitenstand erneut lesen.',
    workflow_browser_navigation_timeout:
      'Die Seite wurde nicht rechtzeitig geladen. Adresse und Verbindung prüfen, bevor erneut navigiert wird.',
    workflow_browser_session_busy: 'Der Browser führt gerade eine andere Aktion aus. Deren Abschluss abwarten.',
  }
  const message = Object.hasOwn(messages, code) ? Reflect.get(messages, code) : undefined
  return message ? `${message} (${code})` : code
}
