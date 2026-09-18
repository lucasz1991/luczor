import { shallowRef } from 'vue'

/**
 * Session-local signal of what the local model is doing with the memory right now, for the
 * knowledge space: which records it recalled, which entered the prompt, which were left out,
 * and which it wrote, changed or removed. Identifiers and timestamps only – never content.
 */
export type MemoryLinkState = 'recalled' | 'included' | 'omitted' | 'written' | 'updated' | 'removed'
export type MemoryLinkOrigin = 'chat' | 'idle' | 'inspector' | 'user'
export type MemoryLink = {
  id: string
  state: MemoryLinkState
  origin: MemoryLinkOrigin
  at: number
  kind?: 'memory' | 'artifact'
}
export type ModelPhase = 'idle' | 'recalling' | 'thinking' | 'tools' | 'answering' | 'dreaming'

export type ModelActivity = {
  phase: ModelPhase
  since: number
  /** Newest link per memory id; a later state replaces an earlier one. */
  links: Map<string, MemoryLink>
}

/** How long a link stays visible in the knowledge space after its last update. */
export const MEMORY_LINK_TTL_MS: Record<MemoryLinkState, number> = {
  recalled: 12_000,
  included: 25_000,
  omitted: 12_000,
  written: 20_000,
  updated: 20_000,
  removed: 14_000,
}
const MAX_LINKS = 160

const empty = (): ModelActivity => ({ phase: 'idle', since: Date.now(), links: new Map() })
export const modelActivity = shallowRef<ModelActivity>(empty())

if (typeof window !== 'undefined')
  window.addEventListener('luczor:api-identity-changing', () => {
    modelActivity.value = empty()
  })

function prune(links: Map<string, MemoryLink>, now: number): Map<string, MemoryLink> {
  const kept = [...links.values()].filter(link => now - link.at < MEMORY_LINK_TTL_MS[link.state])
  kept.sort((left, right) => left.at - right.at)
  return new Map(kept.slice(-MAX_LINKS).map(link => [link.kind === 'artifact' ? `artifact:${link.id}` : link.id, link]))
}

export function setModelPhase(phase: ModelPhase): void {
  const current = modelActivity.value
  if (current.phase === phase) return
  modelActivity.value = { ...current, phase, since: Date.now(), links: prune(current.links, Date.now()) }
}

/** Records memory ids the model touched; `removed` wins over everything, `written` over reads. */
export function recordMemoryLinks(
  ids: Iterable<string>,
  state: MemoryLinkState,
  origin: MemoryLinkOrigin,
  kind: 'memory' | 'artifact' = 'memory'
): void {
  const now = Date.now()
  const links = prune(modelActivity.value.links, now)
  let changed = false
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    const key = kind === 'artifact' ? `artifact:${id}` : id
    const previous = links.get(key)
    // A write or removal must not be downgraded by a recall that races in afterwards.
    if (previous && previous.state === 'removed' && state !== 'removed') continue
    if (previous && (previous.state === 'written' || previous.state === 'updated') && state === 'recalled') continue
    links.set(key, { id, state, origin, at: now, ...(kind === 'artifact' ? { kind } : {}) })
    changed = true
  }
  if (changed) modelActivity.value = { ...modelActivity.value, links }
}

/** Live links (unexpired) as a list, newest last. */
export function activeMemoryLinks(now = Date.now()): MemoryLink[] {
  return [...prune(modelActivity.value.links, now).values()]
}

/** Maps a memory record id to the node id used by buildMemoryGraph(). */
export function memoryLinkNodeId(link: MemoryLink): string {
  return `${link.kind ?? 'memory'}:${link.id}`
}

export const MEMORY_LINK_LABELS: Record<MemoryLinkState, string> = {
  recalled: 'abgerufen',
  included: 'an Modellaufruf übergeben',
  omitted: 'nicht übernommen',
  written: 'neu gespeichert',
  updated: 'geändert',
  removed: 'gelöscht',
}

export function resetModelActivityForTests(): void {
  modelActivity.value = empty()
}
