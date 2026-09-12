import type { LuczorMode } from '@/services/inference/types'
import { canAutoExecuteTool } from '@/services/executionPolicy'
import type { ToolDef } from '@/services/tools/types'

export type ToolCapability = Pick<
  ToolDef,
  'name' | 'description' | 'mutating' | 'requiresApproval' | 'dataHandling' | 'risk' | 'scope' | 'effects'
>
export type CapabilityAccess = 'stopped' | 'observe_locked' | 'approval' | 'automatic'

const titles: Record<string, string> = {
  project_get_state: 'Projektstand lesen',
  project_set_summary: 'Projektzusammenfassung ändern',
  project_upsert_goal: 'Projektziele verwalten',
  project_create: 'Neues Projekt anlegen',
  project_cloud_list_files: 'Cloud-Projektdateien auflisten',
  project_cloud_read_file: 'Cloud-Projektdatei lesen',
  project_cloud_write_file: 'Cloud-Projektdatei speichern',
  workspace_get: 'Projektordner prüfen',
  fs_list: 'Dateien auflisten',
  fs_stat: 'Dateiinformationen lesen',
  fs_read: 'Datei lesen',
  fs_search: 'Dateien durchsuchen',
  fs_write: 'Datei schreiben',
  fs_create_dir: 'Ordner erstellen',
  fs_move: 'Datei verschieben',
  fs_delete: 'Datei löschen',
  os_environment: 'Computerumgebung analysieren',
  os_system_diagnostics: 'Gerätesicherheit und Leistung prüfen',
  local_model_status: 'Lokalen Modellstatus prüfen',
  os_observe_desktop: 'Eingabeziel prüfen',
  agent_team_prepare: 'Agententeam vorbereiten',
  agent_team_status: 'Teamstatus lesen',
  agent_team_cancel: 'Agententeam abbrechen',
  memory_recall: 'Erinnerungen gezielt abrufen',
  memory_analyze: 'Erinnerungen prüfen und ordnen',
  memory_remember: 'Erinnerung mit Priorität speichern',
  os_list_windows: 'Fenster erfassen',
  os_read_clipboard: 'Zwischenablage lesen',
  os_screen_capture: 'Bildschirm aufnehmen',
  os_move_mouse: 'Maus bewegen',
  os_click: 'Maus klicken',
  os_type_text: 'Text eingeben',
  os_press_key: 'Taste drücken',
  os_scroll: 'Scrollen',
  os_hotkey: 'Tastenkombination ausführen',
  os_open_url: 'Webseite öffnen',
  agent_detect: 'Installierte Coding-Agenten erkennen',
  agent_dispatch: 'Coding-Agent beauftragen',
  agent_job_prepare: 'Agentenauftrag vorbereiten',
  agent_job_status: 'Agentenstatus und Ergebnis abrufen',
  agent_job_cancel: 'Agentenauftrag abbrechen',
  agent_bridge_write: 'Agentenübergabe schreiben',
  chat_create: 'Chat anlegen',
  task_create: 'Aufgabe anlegen',
  task_list: 'Aufgaben lesen',
  task_update: 'Aufgabe ändern',
  task_complete: 'Aufgabe abschließen',
  plan_update: 'Arbeitsplan ändern',
  plan_get: 'Arbeitsplan lesen',
  workflow_catalog: 'Workflow-Aufgabenbibliothek lesen',
  workflow_list: 'Workflows auflisten',
  workflow_get: 'Workflow und Versionen lesen',
  workflow_validate: 'Workflow prüfen',
  workflow_create: 'Workflow erstellen',
  workflow_update: 'Workflow verbessern',
  workflow_run_start: 'Workflow starten oder testen',
  workflow_run_get: 'Workflow-Ergebnisse lesen',
  workflow_run_cancel: 'Workflow abbrechen',
  workflow_trigger_list: 'Workflow-Auslöser lesen',
  workflow_trigger_save: 'Workflow-Auslöser konfigurieren',
  workflow_trigger_delete: 'Workflow-Auslöser entfernen',
  workflow_automation_configure: 'Workflow-Automatisierung freigeben',
  browser_open: 'Luczor-Browser öffnen',
  browser_navigate: 'Browser navigieren',
  browser_dom_read: 'DOM lesen',
  browser_screenshot: 'Browser-Screenshot',
  browser_click: 'Browserklick',
  browser_fill: 'Formularfeld füllen',
  browser_select: 'Auswahl treffen',
  browser_download: 'Browser-Download',
  image_analyze: 'Bild analysieren',
  project_terminal_run: 'Projekt-Terminal ausführen',
  model_capabilities: 'Modellfähigkeiten lesen',
  model_control_validate: 'Modellparameter prüfen',
}

export function capabilityTitle(tool: ToolCapability): string {
  return titles[tool.name] ?? tool.name
}

export function capabilityGroup(tool: ToolCapability): string {
  if (tool.name.startsWith('project_cloud_')) return 'Globale Projekte'
  if (tool.name === 'local_model_status') return 'Lokales Modell'
  if (tool.name.startsWith('memory_')) return 'Erinnerungen'
  if (tool.name.startsWith('workflow_')) return 'Workflows'
  if (tool.name.startsWith('os_')) return 'Computer'
  if (tool.name.startsWith('fs_') || tool.name === 'workspace_get') return 'Dateien'
  if (tool.name.startsWith('agent_')) return 'Coding-Agenten'
  if (tool.name.startsWith('browser_')) return 'Interner Browser'
  if (tool.name.startsWith('image_')) return 'Bildanalyse'
  if (tool.name.startsWith('model_')) return 'Modelle'
  if (tool.name.startsWith('project_terminal')) return 'Projekt-Terminal'
  return 'Projekte & Aufgaben'
}

/** Mirrors the agent approval rule; this is not a runtime-readiness assertion. */
export function capabilityAccess(
  tool: ToolCapability,
  mode: LuczorMode,
  autoExecuteMutatingTools: boolean,
  killSwitch: boolean
): CapabilityAccess {
  if (killSwitch) return 'stopped'
  if (mode === 'observe' && tool.mutating) return 'observe_locked'
  if (
    tool.requiresApproval &&
    mode !== 'unrestricted' &&
    !canAutoExecuteTool({ autoExecuteMutatingTools }, { mode, ...tool })
  )
    return 'approval'
  return 'automatic'
}

export const capabilityAccessLabels: Record<CapabilityAccess, string> = {
  stopped: 'Not-Aus aktiv',
  observe_locked: 'Im Beobachten gesperrt',
  approval: 'Einzelbestätigung',
  automatic: 'Ohne Einzelbestätigung',
}
