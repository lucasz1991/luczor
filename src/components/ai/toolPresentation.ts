import type { ActivityStatus, ActivityStep } from './types'

const toolLabels = new Map<string, string>(
  Object.entries({
    browser_open: 'Browser öffnen',
    browser_close: 'Browser beenden',
    browser_status: 'Browser-Sitzung prüfen',
    browser_navigate: 'Seite öffnen',
    browser_dom_read: 'Seiteninhalt lesen',
    browser_screenshot: 'Seite aufnehmen',
    browser_click: 'Element anklicken',
    browser_fill: 'Formular ausfüllen',
    browser_select: 'Auswahl setzen',
    browser_download: 'Datei herunterladen',
    image_analyze: 'Bild analysieren',
    project_terminal_run: 'Projektskript ausführen',
    model_capabilities: 'Modellfähigkeiten prüfen',
    model_control_validate: 'Modelleinstellungen prüfen',
    local_model_status: 'Lokales Modell prüfen',
    agent_detect: 'Agenten prüfen',
    agent_dispatch: 'Agent beauftragen',
    agent_bridge_write: 'Agentenübergabe speichern',
    agent_job_prepare: 'Agentenauftrag vorbereiten',
    agent_job_status: 'Agentenauftrag prüfen',
    agent_job_cancel: 'Agentenauftrag abbrechen',
    agent_team_prepare: 'Agententeam vorbereiten',
    agent_team_status: 'Agententeam prüfen',
    agent_team_cancel: 'Agententeam abbrechen',
    workspace_overview: 'Workspace ansehen',
    workspace_project_update: 'Projekt aktualisieren',
    workspace_chat_read: 'Chat lesen',
    workspace_get: 'Projektordner prüfen',
    fs_list: 'Dateien auflisten',
    fs_stat: 'Datei prüfen',
    fs_read: 'Datei lesen',
    file_read: 'Datei lesen',
    fs_search: 'Dateien durchsuchen',
    fs_write: 'Datei schreiben',
    file_write: 'Datei schreiben',
    fs_create_dir: 'Ordner anlegen',
    fs_move: 'Datei verschieben',
    fs_delete: 'Datei löschen',
    project_cloud_list_files: 'Projektdateien auflisten',
    project_cloud_read_file: 'Projektdatei lesen',
    project_cloud_write_file: 'Projektdatei schreiben',
    project_get_state: 'Projektkontext lesen',
    project_set_summary: 'Zusammenfassung aktualisieren',
    project_upsert_goal: 'Projektziel aktualisieren',
    project_create: 'Projekt anlegen',
    chat_create: 'Chat anlegen',
    chat_list: 'Chats auflisten',
    task_create: 'Aufgabe anlegen',
    task_list: 'Aufgaben auflisten',
    task_update: 'Aufgabe aktualisieren',
    task_complete: 'Aufgabe abschließen',
    plan_get: 'Plan lesen',
    plan_update: 'Plan aktualisieren',
    memory_recall: 'Erinnerungen abrufen',
    memory_analyze: 'Erinnerungen analysieren',
    memory_remember: 'Erinnerung speichern',
    workflow_catalog: 'Workflow-Werkzeuge prüfen',
    workflow_list: 'Workflows auflisten',
    workflow_get: 'Workflow lesen',
    workflow_validate: 'Workflow prüfen',
    workflow_create: 'Workflow anlegen',
    workflow_update: 'Workflow aktualisieren',
    workflow_run_start: 'Workflow starten',
    workflow_run_get: 'Workflow-Lauf prüfen',
    workflow_run_cancel: 'Workflow abbrechen',
    workflow_trigger_list: 'Workflow-Auslöser auflisten',
    workflow_trigger_save: 'Workflow-Auslöser speichern',
    workflow_trigger_delete: 'Workflow-Auslöser löschen',
    workflow_automation_configure: 'Automatisierung konfigurieren',
    os_system_diagnostics: 'System prüfen',
    os_read_clipboard: 'Zwischenablage lesen',
    os_list_windows: 'Fenster auflisten',
    os_screen_capture: 'Bildschirm aufnehmen',
    os_observe_desktop: 'Desktop beobachten',
    os_move_mouse: 'Maus bewegen',
    os_click: 'Auf dem Desktop klicken',
    os_type_text: 'Text eingeben',
    os_press_key: 'Taste drücken',
    os_scroll: 'Ansicht scrollen',
    os_hotkey: 'Tastenkürzel ausführen',
    os_open_url: 'Webadresse öffnen',
    os_environment: 'Umgebung prüfen',
    'node.run': 'Node-Skript ausführen',
    'python.run': 'Python-Skript ausführen',
  })
)

/** Present supplied public metadata only; arguments and results never enter this view. */
export function toolDisplayLabel(label: string): string {
  return toolLabels.get(label) ?? label
}

export function toolDisplayIcon(tool: ActivityStep): string {
  const name = tool.label
  if (name.startsWith('browser_')) return 'panel'
  if (name.startsWith('agent_')) return 'spark'
  if (name.startsWith('fs_') || name.startsWith('project_cloud_') || name === 'workspace_get') return 'folder'
  if (name.startsWith('model_') || name.startsWith('local_model')) return 'settings'
  if (name === 'project_terminal_run' || name.endsWith('.run')) return 'code'
  if (name.startsWith('image_') || name === 'os_screen_capture') return 'grid'
  if (name.startsWith('memory_') || name.endsWith('_search')) return 'search'
  return 'tool'
}

export function activityStatusIcon(status: ActivityStatus): string {
  if (status === 'done') return 'check'
  if (status === 'failed') return 'close'
  if (status === 'canceled') return 'stop'
  if (status === 'waiting') return 'shield'
  if (status === 'pending') return 'clock'
  return 'spark'
}
