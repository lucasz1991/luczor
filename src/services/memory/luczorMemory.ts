// src/services/memory/luczorMemory.ts
//
// LuczorMemoryService — the single memory facade for the whole app.
//
// Architecture (Masterplan v3 + "Server-Cognee via Laravel proxy"):
//   Agent/UI -> LuczorMemoryService -> ServerBackend (Laravel /api/v1/memory/*)
//                                       -> internal Cognee + memory_links (SoR)
// Cognee is NEVER contacted directly from the client. When the server is not
// configured/reachable, an OfflineBackend keeps a local queue so remember()
// never loses data and recall() still returns something.

import { Store } from '@tauri-apps/plugin-store'
import { getApiConfig } from '@/services/api/luczorApi'

const SETTINGS_FILE = 'luczor.settings.json'
const QUEUE_FILE = 'luczor.memory.json'
const QUEUE_KEY = 'records_v1'

export type MemoryScope = 'private' | 'project' | 'skill' | 'agent' | 'global'
export type MemoryVisibility = 'private' | 'syncable' | 'public'

export type MemoryRecord = {
  id: string
  scope: MemoryScope
  dataset: string
  content: string
  type: string // project_memory | fact | preference | skill | error | note
  visibility: MemoryVisibility
  importance: number // 0..1
  source: string // chat | tool | screen | user
  tags: string[]
  createdAt: number
  projectId?: string
  featureKey?: string
  meta?: Record<string, unknown>
  synced?: boolean
}

export type RememberInput = {
  content: string
  scope?: MemoryScope
  projectId?: string
  agentId?: string
  userId?: string
  featureKey?: string
  type?: string
  source?: string
  tags?: string[]
  meta?: Record<string, unknown>
  visibility?: MemoryVisibility
  importance?: number
}

export type RecallQuery = {
  query: string
  scope?: MemoryScope
  projectId?: string
  agentId?: string
  userId?: string
  limit?: number
}

type MemCtx = { scope: MemoryScope; dataset: string; projectId?: string; agentId?: string; userId?: string }

/* =========================================================
 * Dataset namespacing (must match the Laravel side)
 * ========================================================= */
export function datasetFor(scope: MemoryScope, ids: { userId?: string; projectId?: string; agentId?: string }): string {
  const u = ids.userId || 'server'
  switch (scope) {
    case 'project':
      return `user:${u}:projects:${ids.projectId || 'default'}`
    case 'skill':
      return `user:${u}:skills`
    case 'agent':
      return `agent:${ids.agentId || 'default'}:runs`
    case 'global':
      return 'global:knowledge'
    case 'private':
    default:
      return `user:${u}:private`
  }
}

/* =========================================================
 * Classification + scoring (local heuristics)
 * ========================================================= */
const SECRET_RE = /\b(passwor[dt]|api[_-]?key|token|secret|geheim|kennwort|iban|kreditkart)\b/i

export function classify(content: string): { visibility: MemoryVisibility; type: string } {
  const t = content.trim()
  if (SECRET_RE.test(t)) return { visibility: 'private', type: 'fact' }
  if (/\b(fehler|error|exception|stack ?trace|bug)\b/i.test(t)) return { visibility: 'syncable', type: 'error' }
  if (/\b(skill|workflow|ablauf|vorgehen|anleitung)\b/i.test(t)) return { visibility: 'syncable', type: 'skill' }
  return { visibility: 'syncable', type: 'note' }
}

export function score(content: string): number {
  const t = content.trim()
  let s = 0.3
  if (t.length > 80) s += 0.2
  if (t.length > 240) s += 0.1
  if (/\b(wichtig|immer|nie|merke|regel|bevorzug|prefer)\b/i.test(t)) s += 0.25
  if (SECRET_RE.test(t)) s += 0.1
  return Math.max(0, Math.min(1, s))
}

/* =========================================================
 * Backends
 * ========================================================= */
interface MemoryBackend {
  remember(rec: MemoryRecord): Promise<void>
  recall(ctx: MemCtx, query: string, limit: number): Promise<MemoryRecord[]>
  forget(ctx: MemCtx, id: string): Promise<void>
  improve(ctx: MemCtx): Promise<void>
}

/** Persisted local queue — the always-available fallback. */
class OfflineBackend {
  async load(): Promise<MemoryRecord[]> {
    try {
      const s = await Store.load(QUEUE_FILE)
      return (await s.get<MemoryRecord[]>(QUEUE_KEY)) ?? []
    } catch {
      return []
    }
  }
  async save(records: MemoryRecord[]): Promise<void> {
    const s = await Store.load(QUEUE_FILE)
    await s.set(QUEUE_KEY, records)
    await s.save()
  }
  async remember(rec: MemoryRecord): Promise<void> {
    const all = await this.load()
    const idx = all.findIndex(r => r.id === rec.id)
    if (idx >= 0) all[idx] = rec
    else all.push(rec)
    await this.save(all.slice(-2000))
  }
  async recall(ctx: MemCtx, query: string, limit: number): Promise<MemoryRecord[]> {
    const all = await this.load()
    const q = query.toLowerCase()
    return (
      all
        // Private memories are deliberately local-only, but must remain
        // recallable by their owner from the matching local dataset.
        .filter(r => r.dataset === ctx.dataset)
        .map(r => ({ r, hit: q && r.content.toLowerCase().includes(q) ? 1 : 0 }))
        .sort((a, b) => b.hit - a.hit || b.r.importance - a.r.importance || b.r.createdAt - a.r.createdAt)
        .slice(0, limit)
        .map(x => x.r)
    )
  }
  async forget(ctx: MemCtx, id: string): Promise<void> {
    const all = await this.load()
    await this.save(all.filter(r => !(r.dataset === ctx.dataset && r.id === id)))
  }
  async improve(): Promise<void> {
    /* no-op offline */
  }
  async markSynced(id: string): Promise<void> {
    const all = await this.load()
    const r = all.find(x => x.id === id)
    if (r) {
      r.synced = true
      await this.save(all)
    }
  }
  async pending(): Promise<number> {
    return (await this.load()).filter(r => r.visibility !== 'private' && !r.synced).length
  }
}

/** Server memory via the Laravel proxy (Cognee + memory_links stay internal). */
class ServerBackend implements MemoryBackend {
  constructor(
    private baseUrl: string,
    private deviceKey: string,
    private clientId: string
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.deviceKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Memory HTTP ${res.status}`)
    return (await res.json().catch(() => ({}))) as T
  }

  async remember(rec: MemoryRecord): Promise<void> {
    await this.call('/memory/remember', {
      content: rec.content,
      scope: rec.scope,
      project_id: rec.projectId,
      feature_key: rec.featureKey,
      type: rec.type,
      visibility: rec.visibility,
      importance: rec.importance,
      external_id: rec.id,
      client_id: this.clientId,
      tags: rec.tags,
    })
  }
  async recall(ctx: MemCtx, query: string, limit: number): Promise<MemoryRecord[]> {
    const r = await this.call<{ data?: any[] }>('/memory/recall', {
      query,
      scope: ctx.scope,
      project_id: ctx.projectId,
      agent_id: ctx.agentId,
      limit,
    })
    return (r.data ?? []).map((x: any, i: number) => ({
      id: String(x.id ?? `r_${i}`),
      scope: ctx.scope,
      dataset: ctx.dataset,
      content: String(x.content ?? ''),
      type: String(x.type ?? 'note'),
      visibility: 'syncable' as MemoryVisibility,
      importance: Number(x.importance ?? 0.5),
      source: String(x.source ?? 'server'),
      tags: [],
      createdAt: Date.now(),
      featureKey: x.feature_key ?? undefined,
    }))
  }
  async forget(ctx: MemCtx, id: string): Promise<void> {
    await this.call('/memory/forget', {
      external_id: id,
      scope: ctx.scope,
      project_id: ctx.projectId,
      client_id: this.clientId,
    })
  }
  async improve(ctx: MemCtx): Promise<void> {
    await this.call('/memory/improve', { scope: ctx.scope, project_id: ctx.projectId })
  }
}

/* =========================================================
 * Facade
 * ========================================================= */
async function memoryUseServer(): Promise<boolean> {
  try {
    const s = await Store.load(SETTINGS_FILE)
    return (await s.get<boolean>('memory_use_server')) ?? true
  } catch {
    return true
  }
}

function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

export class LuczorMemoryService {
  private offline = new OfflineBackend()

  private async server(): Promise<ServerBackend | null> {
    if (!(await memoryUseServer())) return null
    const cfg = await getApiConfig()
    if (!cfg.deviceKey) return null
    return new ServerBackend(cfg.baseUrl, cfg.deviceKey, cfg.clientId)
  }

  private ctx(scope: MemoryScope, input: { projectId?: string; agentId?: string; userId?: string }): MemCtx {
    return {
      scope,
      dataset: datasetFor(scope, input),
      projectId: input.projectId,
      agentId: input.agentId,
      userId: input.userId,
    }
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const scope = input.scope ?? 'project'
    const auto = classify(input.content)
    const rec: MemoryRecord = {
      id: uid(),
      scope,
      dataset: datasetFor(scope, input),
      content: input.content.trim(),
      type: input.type ?? auto.type,
      visibility: input.visibility ?? auto.visibility,
      importance: input.importance ?? score(input.content),
      source: input.source ?? 'chat',
      tags: input.tags ?? [],
      createdAt: Date.now(),
      projectId: input.projectId,
      featureKey: input.featureKey,
      meta: input.meta,
    }

    // Local persistence is always kept (offline-first / pending count).
    await this.offline.remember(rec)

    // Push to the server (best-effort). Private memories stay local only.
    if (rec.visibility !== 'private') {
      try {
        const be = await this.server()
        if (be) {
          await be.remember(rec)
          await this.offline.markSynced(rec.id)
        }
      } catch (e) {
        console.warn('[memory] server remember failed, kept locally:', e)
      }
    }
    return rec
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    const scope = q.scope ?? 'project'
    const ctx = this.ctx(scope, q)
    const limit = q.limit ?? 6
    try {
      const be = await this.server()
      if (be) {
        const hits = await be.recall(ctx, q.query, limit)
        if (hits.length) return hits
      }
    } catch (e) {
      console.warn('[memory] server recall failed, using local:', e)
    }
    return this.offline.recall(ctx, q.query, limit)
  }

  async forget(
    scope: MemoryScope,
    id: string,
    ids: { userId?: string; projectId?: string; agentId?: string } = {}
  ): Promise<void> {
    const ctx = this.ctx(scope, ids)
    await this.offline.forget(ctx, id)
    try {
      const be = await this.server()
      if (be) await be.forget(ctx, id)
    } catch {
      /* ignore */
    }
  }

  async improve(
    scope: MemoryScope,
    ids: { userId?: string; projectId?: string; agentId?: string } = {}
  ): Promise<void> {
    try {
      const be = await this.server()
      if (be) await be.improve(this.ctx(scope, ids))
    } catch (e) {
      console.warn('[memory] improve failed:', e)
    }
  }

  classify = classify
  score = score

  /** Compact project-memory context for prompt injection (small budget). */
  async getContextForPrompt(projectId: string, query: string, limit = 5): Promise<string> {
    const hits = await this.recall({ scope: 'project', projectId, query, limit })
    if (!hits.length) return ''
    const lines = hits.map(h => `- ${h.content}`).join('\n')
    return `Relevante Erinnerungen:\n${lines}`
  }

  /** Not-yet-synced local syncable records. */
  async pendingSyncCount(): Promise<number> {
    return this.offline.pending()
  }

  /**
   * Server-memory reachability for the HUD.
   * null = not using server, true = server reachable, false = configured but down.
   */
  async memoryHealth(): Promise<boolean | null> {
    if (!(await memoryUseServer())) return null
    const cfg = await getApiConfig()
    if (!cfg.deviceKey) return null
    try {
      const res = await fetch(`${cfg.baseUrl}/api/v1/health`)
      return res.ok
    } catch {
      return false
    }
  }
}

export const luczorMemory = new LuczorMemoryService()

/** User memory preferences (Settings). */
export async function getMemoryPrefs(): Promise<{
  inject: boolean
  injectCount: number
  autoRemember: boolean
}> {
  try {
    const s = await Store.load(SETTINGS_FILE)
    return {
      inject: (await s.get<boolean>('memory_inject')) ?? true,
      injectCount: (await s.get<number>('memory_inject_count')) ?? 5,
      autoRemember: (await s.get<boolean>('memory_auto_remember')) ?? true,
    }
  } catch {
    return { inject: true, injectCount: 5, autoRemember: true }
  }
}
