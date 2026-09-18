import type { RepositoryGraphPage } from '@/services/repositoryGraph'
import type { LuczorMemoryService } from '@/services/memory/luczorMemory'
import type { AssistantProfile } from '@/services/assistantProfileTypes'
import type { PreparedContextArtifact } from '@/services/memory/maintenance'
export type MemoryInventory = Awaited<ReturnType<LuczorMemoryService['inspectLocal']>>
export type MemoryNode = {
  id: string
  label: string
  system: string
  kind: string
  detail: string
  /** Transient presentation state set by the explorer while a dream run changes the inventory. */
  state?: 'born' | 'removed'
}
export type MemoryEdge = { from: string; to: string; kind: string; grouping?: boolean }
export type MemoryGraph = { nodes: MemoryNode[]; edges: MemoryEdge[] }
export const MEMORY_SYSTEMS = ['Erinnerungen', 'Persönlichkeit', 'Repo-Graph', 'SQL / Cognee', 'Kontextpakete']
/** The local model sits at the centre of the knowledge space; every system hub hangs off it. */
export const MODEL_NODE_ID = 'model:local'
export type MemoryGraphModel = { label: string; detail: string }
export function buildMemoryGraph(
  inventory: MemoryInventory | null,
  repo: RepositoryGraphPage | null,
  profile: AssistantProfile,
  artifacts: PreparedContextArtifact[] = [],
  model?: MemoryGraphModel
): MemoryGraph {
  const nodes: MemoryNode[] = MEMORY_SYSTEMS.map((system, index) => ({
    id: `system:${index}`,
    label: system,
    system,
    kind: 'System',
    detail:
      index === 3
        ? 'SQL ist der kanonische Server-Speicher. Cognee ist ein abgeleiteter Suchindex; synchronisiert bedeutet nicht nachweislich indexiert. Interne Cognee-Kanten sind über die Desktop-API nicht verfügbar.'
        : 'Gestrichelte Linien zeigen die Zugehörigkeit, keine semantische Beziehung.',
  }))
  const edges: MemoryEdge[] = []
  if (model) {
    nodes.unshift({
      id: MODEL_NODE_ID,
      label: model.label,
      system: 'Modell',
      kind: 'Modell',
      detail: model.detail,
    })
    for (let index = 0; index < MEMORY_SYSTEMS.length; index++)
      edges.push({ from: MODEL_NODE_ID, to: `system:${index}`, kind: 'Zugriff des Modells', grouping: true })
  }
  for (const artifact of artifacts) {
    const id = `artifact:${artifact.id}`
    nodes.push({
      id,
      label: artifact.content.slice(0, 72),
      system: 'Kontextpakete',
      kind: 'Geprüfte KI-Ableitung',
      detail: `${artifact.content}\n\nNur lokal · Modell: ${artifact.modelId}\nErstellt: ${new Date(artifact.createdAt).toLocaleString('de-DE')}\nDie Quellen werden vor Chat-Nutzung erneut geprüft; diese Ansicht ist ein Speicherauszug.`,
    })
    edges.push({ from: 'system:4', to: id, kind: 'Kontextzuordnung', grouping: true })
    for (const source of artifact.sources) {
      const from =
        source.kind === 'memory'
          ? `memory:${source.id}`
          : source.kind === 'repository'
            ? `file:${source.id}`
            : `source:${source.kind}:${source.id}`
      if (!nodes.some(node => node.id === from) && source.kind !== 'memory' && source.kind !== 'repository') {
        nodes.push({
          id: from,
          label: source.id,
          system: 'Kontextpakete',
          kind: `Quelle (${source.kind})`,
          detail: 'Quellenreferenz, kein gespeicherter Originalvolltext.',
        })
      }
      edges.push({ from, to: id, kind: 'Belegte Ableitung' })
    }
  }
  const visibleMemoryIds = new Set((inventory?.records ?? []).map(record => record.id))
  for (const record of inventory?.records ?? []) {
    const id = `memory:${record.id}`
    nodes.push({
      id,
      label: record.content.slice(0, 72),
      system: 'Erinnerungen',
      kind: record.type,
      detail: `${record.content}${record.truncated ? '\n[Auszug: erste 4.000 Zeichen]' : ''}\n\nBereich: ${record.scope} · Status: ${record.status}\nQuelle: ${record.source} · Sichtbarkeit: ${record.visibility}\nAufbewahrung: ${record.retention} · Vertrauen: ${record.confidence}\n${record.projectId ? `Projekt: ${record.projectId}\n` : ''}Geändert: ${new Date(record.updatedAt).toLocaleString('de-DE')}${record.expiresAt ? `\nAblauf: ${new Date(record.expiresAt).toLocaleString('de-DE')}` : ''}\nGespeicherte Erinnerungsquellen: ${record.sourceIds?.length ?? 0} (Kanten nur zu Einträgen dieser Seite).`,
    })
    edges.push({ from: 'system:0', to: id, kind: 'Zugehörigkeit', grouping: true })
    for (const source of record.sourceIds ?? []) {
      if (visibleMemoryIds.has(source)) edges.push({ from: `memory:${source}`, to: id, kind: 'Gespeicherte Herkunft' })
    }
    if (record.synced)
      edges.push({ from: id, to: 'system:3', kind: 'Lokal als synchronisiert markiert', grouping: true })
  }
  const profileItems = [
    ...(profile.persona
      ? [
          {
            id: 'persona',
            name: profile.persona.name,
            description: 'Administriertes Persönlichkeitsprofil; keine automatisch gelernte Erinnerung.',
          },
        ]
      : []),
    ...profile.skills.map(skill => ({ id: `skill:${skill.id}`, name: skill.name, description: skill.description })),
  ]
  for (const item of profileItems) {
    nodes.push({
      id: item.id,
      label: item.name,
      system: 'Persönlichkeit',
      kind: item.id === 'persona' ? 'Persönlichkeit' : 'Skill',
      detail: item.description,
    })
    edges.push({ from: 'system:1', to: item.id, kind: 'Profilzuordnung', grouping: true })
  }
  for (const file of repo?.files ?? []) {
    const id = `file:${file.id}`
    nodes.push({
      id,
      label: file.path,
      system: 'Repo-Graph',
      kind: file.language,
      detail: `${file.path}\nIndex-Snapshot; Dateien werden hier nicht erneut gelesen.\n${file.symbols.map(symbol => `${symbol.kind}: ${symbol.name} (${symbol.start_line}–${symbol.end_line})`).join('\n')}${file.truncated ? '\nWeitere Symbole/Beziehungen im Index; je Datei werden maximal 12 angezeigt.' : ''}`,
    })
    edges.push({ from: 'system:2', to: id, kind: 'Indexzuordnung', grouping: true })
    file.symbols.forEach((symbol, index) => {
      const symbolId = `${id}:symbol:${index}`
      nodes.push({
        id: symbolId,
        label: symbol.name,
        system: 'Repo-Graph',
        kind: symbol.kind,
        detail: `Indexiertes Symbol: ${symbol.name}\n${file.path}:${symbol.start_line}–${symbol.end_line}\nArt: ${symbol.kind}`,
      })
      edges.push({ from: id, to: symbolId, kind: 'Definiert' })
    })
    file.relations.forEach((relation, index) => {
      let target = relation.target
      if (relation.kind === 'lsp_reference') {
        try {
          const parsed = JSON.parse(target)
          target = `${parsed.relation.target}:${parsed.relation.target_line} (${parsed.relation.symbol})`
        } catch {
          target = 'LSP-Verweis (Details nicht verfügbar)'
        }
      }
      const targetId = `${id}:relation:${index}`
      nodes.push({
        id: targetId,
        label: target,
        system: 'Repo-Graph',
        kind: relation.kind,
        detail: `Gespeicherte ${relation.kind}-Beziehung aus ${file.path}\nZiel: ${target}\nIndex-Evidenz, keine erneute Prüfung des aktuellen Dateiinhalts.`,
      })
      edges.push({ from: id, to: targetId, kind: relation.kind })
    })
  }
  return { nodes, edges }
}

/** Deterministic spatial layout. Coordinates express grouping, never semantic similarity. */
export function projectMemoryGraph(nodes: MemoryNode[], yaw: number, pitch: number, zoom: number) {
  const groups = new Map<string, number>()
  return nodes
    .map(node => {
      const isModel = node.kind === 'Modell'
      const group = Math.max(0, MEMORY_SYSTEMS.indexOf(node.system))
      const index = groups.get(node.system) ?? 0
      groups.set(node.system, index + 1)
      const angle = index * 2.399963
      const radius = node.kind === 'System' || isModel ? 0 : Math.min(130, 24 + Math.sqrt(index) * 13)
      // Five system hubs orbit the model core on a ring; their members spread around each hub.
      const hubAngle = (group / MEMORY_SYSTEMS.length) * Math.PI * 2 - Math.PI / 2
      const hubX = Math.cos(hubAngle) * 205
      const hubY = Math.sin(hubAngle) * 118
      const hubZ = Math.sin(hubAngle * 2) * 70
      const xx = isModel ? 0 : hubX + Math.cos(angle) * radius
      const yy = isModel ? 0 : hubY + Math.sin(angle) * radius * 0.62
      const zz = isModel ? 0 : hubZ + Math.sin(index * 1.7) * radius
      const rx = xx * Math.cos(yaw) - zz * Math.sin(yaw)
      const rz = xx * Math.sin(yaw) + zz * Math.cos(yaw)
      const ry = yy * Math.cos(pitch) - rz * Math.sin(pitch)
      const depth = yy * Math.sin(pitch) + rz * Math.cos(pitch)
      const scale = (650 / (650 + depth)) * zoom
      return {
        ...node,
        left: 400 + rx * scale,
        top: 250 + ry * scale,
        depth,
        radius: (isModel ? 16 : node.kind === 'System' ? 10 : 4) * scale,
      }
    })
    .sort((left, right) => right.depth - left.depth)
}
