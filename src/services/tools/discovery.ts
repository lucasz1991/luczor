/** Discovery metadata is independent of authorization categories and never grants access. */
export type ToolDescriptor = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
type Branch = { id: string; label: string; keywords: string[] }
const branch = (id: string, label: string, words: string): Branch => ({ id, label, keywords: words.split(' ') })
export const TOOL_BRANCHES: Branch[] = [
  branch('project', 'Projekte', 'projekt project workspace arbeitsbereich vorhaben'),
  branch('project/state', 'Projektverwaltung', 'zustand status zusammenfassung summary ziele goals erstellen anlegen'),
  branch('project/chats', 'Unterhaltungen', 'chat conversation unterhaltung verlauf nachrichten dialog'),
  branch('project/tasks', 'Aufgaben und Planung', 'task aufgabe plan schritte todo checklist ziel goal'),
  branch('files', 'Dateien', 'datei file dokument document ordner folder verzeichnis directory quellcode source repo'),
  branch('files/local', 'Lokaler Projektordner', 'lokal local dateisystem filesystem pfad path lesen speichern suchen'),
  branch('files/cloud', 'Cloud-Projektdateien', 'cloud server global synchronisieren sync dateipool'),
  branch('computer', 'Computer', 'computer desktop bildschirm screen bedienung control'),
  branch(
    'computer/browser',
    'Luczor-Browser',
    'browser web internet website seite webpage intern internal dom formular form surfen'
  ),
  branch('computer/external-browser', 'Externer Browser', 'extern external chrome firefox edge fremd url link öffnen'),
  branch(
    'computer/input',
    'Maus und Tastatur',
    'maus mouse zeiger cursor tastatur keyboard taste key tippen eingabe klicken scroll'
  ),
  branch(
    'computer/observation',
    'Bildschirm und Fenster',
    'fenster window screenshot bildschirm capture beobachten observe zwischenablage clipboard bild image vision'
  ),
  branch(
    'computer/system',
    'Systemdiagnose',
    'hardware ram gpu cpu speicher memory leistung performance sicherheit security umgebung environment linux windows'
  ),
  branch(
    'computer/terminal',
    'Terminal und Programme',
    'terminal shell befehl command skript script ausführen execute programm build test kompilieren'
  ),
  branch('knowledge', 'Wissen', 'wissen knowledge kontext context erinnerung gedächtnis memory'),
  branch('knowledge/memory', 'Erinnerungen', 'erinnern recall remember merken notiz notizen erfahrung wissen'),
  branch('knowledge/history', 'Kontextarchiv', 'history verlauf archiv nachlesen original context'),
  branch('agents', 'Agenten', 'agent agenten assistenz assistance delegation mitarbeiter helfer parallel'),
  branch('agents/jobs', 'Einzelagenten', 'job auftrag teilauftrag delegieren worker spezialist codex claude'),
  branch('agents/teams', 'Agententeams', 'team teams orchestrierung zusammenarbeit koordination'),
  branch('models', 'Modelle', 'modell model ki ai inference lokal local llm'),
  branch(
    'models/runtime',
    'Modellbetrieb',
    'runtime bereitschaft readiness status laden steuerung parameter fähigkeit capability'
  ),
  branch('workflows', 'Workflows', 'workflow ablauf automation automatisierung prozess routine'),
  branch(
    'workflows/definitions',
    'Definitionen',
    'definition vorlage version knoten node erstellen konfigurieren validieren'
  ),
  branch('workflows/runs', 'Ausführungen', 'run lauf ausführen starten testen ergebnis stoppen'),
  branch('workflows/triggers', 'Auslöser', 'trigger zeitplan schedule timer ereignis event automatisch'),
  branch('devices', 'Geräteverbund', 'gerät device laptop rechner master koordinator netzwerk remote fernsteuerung'),
  branch('devices/jobs', 'Geräteaufträge', 'delegieren dispatch auftrag ergebnis status stoppen'),
  branch('tools', 'Werkzeuge', 'tool werkzeug funktion function hilfsmittel katalog catalog entdecken discovery'),
  branch(
    'tools/catalog',
    'Werkzeugsuche',
    'suche search auswählen select finden find kategorie category map synonym keyword'
  ),
  branch('tools/other', 'Weitere Werkzeuge', 'weitere other custom spezial erweitert'),
]
const operations = [
  {
    ...branch('forms', 'Formulare', 'formular form ausfüllen fill select eingabefeld option dropdown'),
    match: /^browser_(fill|select)$/,
  },
  { ...branch('search', 'Suchen', 'suche suchen search find finden durchsuchen lookup'), match: /search/ },
  {
    ...branch('stop', 'Beenden', 'stop cancel close abbrechen stoppen schließen beenden'),
    match: /(?:cancel|stop|close)$/,
  },
  { ...branch('delete', 'Entfernen', 'delete remove löschen entfernen'), match: /delete/ },
  {
    ...branch(
      'write',
      'Ändern und Speichern',
      'write save create update move remember schreiben speichern erstellen anlegen ändern verschieben'
    ),
    match: /write|save|create|update|move|remember|upsert|set_summary|complete|configure/,
  },
  {
    ...branch(
      'execute',
      'Starten und Steuern',
      'start execute run dispatch prepare click type key hotkey scroll öffnen starten ausführen klicken tippen'
    ),
    match: /dispatch|prepare|start|open|navigate|click|type|press|hotkey|scroll|terminal_run/,
  },
  {
    ...branch(
      'read',
      'Lesen und Prüfen',
      'read list get status inspect observe check lesen lies auflisten liste prüfen prüfe abrufen anzeigen analysieren auslesen'
    ),
    match: /.*/,
  },
]
function branchFor(name: string): string {
  if (name === 'tools_select') return 'tools/catalog'
  if (name.startsWith('context_')) return 'knowledge/history'
  if (name.startsWith('project_cloud_')) return 'files/cloud'
  if (name.startsWith('fs_') || name === 'workspace_get') return 'files/local'
  if (name === 'project_terminal_run') return 'computer/terminal'
  if (name === 'os_open_url') return 'computer/external-browser'
  if (name.startsWith('browser_')) return 'computer/browser'
  if (/^os_(move_mouse|click|type_text|press_key|scroll|hotkey)$/.test(name)) return 'computer/input'
  if (/^os_(environment|system_diagnostics|control_status)$/.test(name)) return 'computer/system'
  if (name.startsWith('os_') || name === 'image_analyze') return 'computer/observation'
  if (name.startsWith('memory_')) return 'knowledge/memory'
  if (/^(local_model_|model_)/.test(name)) return 'models/runtime'
  if (name.startsWith('agent_team_')) return 'agents/teams'
  if (/^(agent_|workspace_agent_)/.test(name)) return 'agents/jobs'
  if (name.startsWith('device_')) return 'devices/jobs'
  if (/^workflow_(trigger|automation)/.test(name)) return 'workflows/triggers'
  if (name.startsWith('workflow_run_')) return 'workflows/runs'
  if (name.startsWith('workflow_')) return 'workflows/definitions'
  if (/^(chat_|workspace_chat_)/.test(name)) return 'project/chats'
  if (/^(task_|plan_|goal_)/.test(name)) return 'project/tasks'
  if (/^(project_|workspace_)/.test(name)) return 'project/state'
  return 'tools/other'
}
export function normalizeToolSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
export function toolDiscovery(tool: ToolDescriptor) {
  const id = branchFor(tool.function.name)
  const operation = operations.find(item => item.match.test(tool.function.name))!
  const path = [
    ...TOOL_BRANCHES.filter(item => item.id === id.split('/')[0] || item.id === id),
    { id: `${id}/${operation.id}`, label: operation.label, keywords: operation.keywords },
  ]
  return {
    name: tool.function.name,
    description: (tool.function.description ?? '').slice(0, 160),
    category: `${id}/${operation.id}`,
    path: path.map(item => item.label),
    keywords: [...new Set(path.flatMap(item => item.keywords))],
    nodes: path,
  }
}
export function searchToolCatalog(pool: ToolDescriptor[], query = '', category = '') {
  const stopWords = new Set([
    'die',
    'der',
    'das',
    'den',
    'dem',
    'ein',
    'eine',
    'einen',
    'und',
    'oder',
    'mit',
    'von',
    'im',
    'in',
    'am',
    'auf',
    'bitte',
    'mir',
    'ich',
    'du',
    'the',
    'a',
    'an',
    'and',
    'or',
    'with',
    'please',
    'for',
    'to',
    'me',
  ])
  const tokens = normalizeToolSearch(query)
    .split(' ')
    .filter(word => word && !stopWords.has(word))
  return pool
    .map(tool => {
      const meta = toolDiscovery(tool)
      const words = normalizeToolSearch(
        `${meta.name} ${meta.description} ${meta.keywords.join(' ')} ${meta.path.join(' ')}`
      ).split(' ')
      const score = tokens.reduce(
        (sum, token) =>
          sum + (words.some(word => word === token || (token.length >= 4 && word.startsWith(token))) ? 1 : 0),
        0
      )
      return { tool, meta, score }
    })
    .filter(
      item =>
        (!category || item.meta.category === category || item.meta.category.startsWith(`${category}/`)) &&
        (!tokens.length || item.score > 0)
    )
    .sort((left, right) => right.score - left.score)
}
/** Only branches containing currently eligible tools; parents retain searchable aliases. */
export function toolCategoryMap(pool: ToolDescriptor[]) {
  const nodes = new Map<string, Branch & { parent: string | null; tools: number }>()
  for (const tool of pool)
    for (const node of toolDiscovery(tool).nodes) {
      const current = nodes.get(node.id)
      if (current) current.tools++
      else
        nodes.set(node.id, {
          ...node,
          parent: node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : null,
          tools: 1,
        })
    }
  return [...nodes.values()]
}
