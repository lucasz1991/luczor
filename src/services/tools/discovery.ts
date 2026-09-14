/** Discovery metadata is independent of authorization categories and never grants access. */
export type ToolDescriptor = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
type Branch = { id: string; label: string; keywords: string[] }
const branch = (id: string, label: string, words: string): Branch => ({ id, label, keywords: words.split(' ') })
export const TOOL_BRANCHES: Branch[] = [
  branch('project', 'Projects', 'project projects projekt projekte workspace arbeitsbereich vorhaben'),
  branch(
    'project/state',
    'Project management',
    'state status zustand projektstand summary zusammenfassung goals ziele create erstellen anlegen'
  ),
  branch(
    'project/chats',
    'Conversations',
    'chat conversation conversations unterhaltung unterhaltungen verlauf nachrichten dialog'
  ),
  branch(
    'project/tasks',
    'Tasks and planning',
    'task tasks aufgabe aufgaben plan planning schritte todo checklist goal ziel'
  ),
  branch(
    'files',
    'Files',
    'file files datei dateien dokument document ordner folder verzeichnis directory quellcode source repo'
  ),
  branch(
    'files/local',
    'Local project folder',
    'local lokal dateisystem filesystem pfad path read lesen save speichern search suchen'
  ),
  branch('files/cloud', 'Cloud project files', 'cloud server global synchronisieren sync dateipool'),
  branch('computer', 'Computer', 'computer desktop bildschirm screen bedienung control'),
  branch(
    'computer/browser',
    'Luczor browser',
    'browser web internet website seite webpage intern internal dom formular form surfen'
  ),
  branch('computer/external-browser', 'External browser', 'extern external chrome firefox edge fremd url link öffnen'),
  branch(
    'computer/input',
    'Mouse and keyboard',
    'maus mouse zeiger cursor tastatur keyboard taste key tippen eingabe klicken scroll'
  ),
  branch(
    'computer/observation',
    'Screen and windows',
    'fenster window screenshot bildschirm capture beobachten observe zwischenablage clipboard bild image vision'
  ),
  branch(
    'computer/system',
    'System diagnostics',
    'hardware ram gpu cpu speicher memory leistung performance sicherheit security umgebung environment linux windows'
  ),
  branch(
    'computer/terminal',
    'Terminal and programs',
    'terminal shell befehl command skript script ausführen execute programm build test kompilieren'
  ),
  branch('knowledge', 'Knowledge', 'wissen knowledge kontext context erinnerung gedächtnis memory'),
  branch(
    'knowledge/memory',
    'Memories',
    'memory memories erinnerung erinnerungen erinnern recall remember merken notiz notizen erfahrung wissen'
  ),
  branch('knowledge/history', 'Context archive', 'history verlauf archiv nachlesen original context'),
  branch('agents', 'Agents', 'agent agents agenten assistenz assistance delegation mitarbeiter helfer parallel'),
  branch('agents/jobs', 'Individual agents', 'job auftrag teilauftrag delegieren worker spezialist codex claude'),
  branch(
    'agents/teams',
    'Agent teams',
    'team teams agententeam agententeams orchestrierung zusammenarbeit koordination'
  ),
  branch('models', 'Models', 'modell model modelle ki ai inference lokal local llm'),
  branch(
    'models/runtime',
    'Model runtime',
    'runtime bereitschaft readiness status laden steuerung parameter fähigkeit capability'
  ),
  branch('workflows', 'Workflows', 'workflow ablauf automation automatisierung prozess routine'),
  branch(
    'workflows/definitions',
    'Definitions',
    'definition vorlage version knoten node erstellen konfigurieren validieren'
  ),
  branch('workflows/runs', 'Runs', 'run runs lauf läufe ausführen starten testen ergebnis stoppen'),
  branch('workflows/triggers', 'Triggers', 'trigger auslöser zeitplan schedule timer ereignis event automatisch'),
  branch(
    'devices',
    'Device cluster',
    'gerät geräte device devices laptop rechner master koordinator netzwerk remote fernsteuerung'
  ),
  branch('devices/jobs', 'Device jobs', 'delegieren dispatch auftrag aufträge job ergebnis status stoppen'),
  branch(
    'tools',
    'Tools',
    'tool tools werkzeug werkzeuge funktion function hilfsmittel katalog catalog entdecken discovery'
  ),
  branch(
    'tools/catalog',
    'Tool discovery',
    'suche search auswählen select finden find kategorie category map synonym keyword'
  ),
  branch('tools/other', 'Other tools', 'weitere other custom spezial erweitert'),
]
const operations = [
  {
    ...branch('forms', 'Forms', 'formular formulare form forms ausfüllen fill select eingabefeld option dropdown'),
    match: /^browser_(fill|select)$/,
  },
  { ...branch('search', 'Search', 'suche suchen search find finden durchsuchen lookup'), match: /search/ },
  {
    ...branch('stop', 'Stop and close', 'stop cancel close abbrechen stoppen schließen beenden'),
    match: /(?:cancel|stop|close)$/,
  },
  { ...branch('delete', 'Delete and remove', 'delete remove löschen entfernen'), match: /delete/ },
  {
    ...branch(
      'write',
      'Write and save',
      'write save create update move remember schreiben speichern erstellen anlegen ändern verschieben'
    ),
    match: /write|save|create|update|move|remember|upsert|set_summary|complete|configure/,
  },
  {
    ...branch(
      'execute',
      'Start and control',
      'start execute run dispatch prepare click type key hotkey scroll öffnen starten ausführen klicken tippen'
    ),
    match: /dispatch|prepare|start|open|navigate|click|type|press|hotkey|scroll|terminal_run/,
  },
  {
    ...branch(
      'read',
      'Read and inspect',
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
