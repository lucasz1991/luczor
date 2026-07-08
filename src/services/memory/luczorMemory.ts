// src/services/memory/luczorMemory.ts
//
// LuczorMemoryService — the single memory facade for the whole app.
//
// Agents/UI NEVER call Cognee directly; they call this facade. Internally it
// talks to Cognee (local sidecar or, later, the server via Laravel). When no
// Cognee endpoint is configured it degrades gracefully to a persisted local
// queue so `remember()` never loses data and `recall()` simply returns [].
//
// Core operations mirror Cognee's model: remember / recall / forget / improve,
// plus Luczor helpers: classify / score / sync / getContextForPrompt.

import { Store } from "@tauri-apps/plugin-store";

const SETTINGS_FILE = "luczor.settings.json";
const QUEUE_FILE = "luczor.memory.json";
const QUEUE_KEY = "records_v1";

/* Cognee REST endpoints are version-specific — override via settings if needed. */
const COGNEE = {
  add: "/api/v1/add",
  search: "/api/v1/search",
  cognify: "/api/v1/cognify",
  delete: "/api/v1/delete",
};

export type MemoryScope = "private" | "project" | "skill" | "agent" | "global";
export type MemoryVisibility = "private" | "syncable" | "public";

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  dataset: string;
  content: string;
  type: string; // project_memory | fact | preference | skill | error | note
  visibility: MemoryVisibility;
  importance: number; // 0..1
  source: string; // chat | tool | screen | user
  tags: string[];
  createdAt: number;
  meta?: Record<string, unknown>;
  synced?: boolean;
};

export type RememberInput = {
  content: string;
  scope?: MemoryScope;
  projectId?: string;
  agentId?: string;
  userId?: string;
  type?: string;
  source?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  /** Override auto-classification. */
  visibility?: MemoryVisibility;
  importance?: number;
};

export type RecallQuery = {
  query: string;
  scope?: MemoryScope;
  projectId?: string;
  agentId?: string;
  userId?: string;
  limit?: number;
};

/* =========================================================
 * Dataset namespacing (per the memory architecture plan)
 * ========================================================= */
export function datasetFor(
  scope: MemoryScope,
  ids: { userId?: string; projectId?: string; agentId?: string }
): string {
  const u = ids.userId || "local";
  switch (scope) {
    case "project":
      return `user:${u}:projects:${ids.projectId || "default"}`;
    case "skill":
      return `user:${u}:skills`;
    case "agent":
      return `agent:${ids.agentId || "default"}:runs`;
    case "global":
      return "global:knowledge";
    case "private":
    default:
      return `user:${u}:private`;
  }
}

/* =========================================================
 * Classification + scoring (local heuristics)
 * ========================================================= */
const SECRET_RE = /\b(passwor[dt]|api[_-]?key|token|secret|geheim|kennwort|iban|kreditkart)\b/i;

export function classify(content: string): { visibility: MemoryVisibility; type: string } {
  const t = content.trim();
  if (SECRET_RE.test(t)) return { visibility: "private", type: "fact" };
  if (/\b(fehler|error|exception|stack ?trace|bug)\b/i.test(t)) return { visibility: "syncable", type: "error" };
  if (/\b(skill|workflow|ablauf|vorgehen|anleitung)\b/i.test(t)) return { visibility: "syncable", type: "skill" };
  return { visibility: "syncable", type: "note" };
}

export function score(content: string): number {
  const t = content.trim();
  let s = 0.3;
  if (t.length > 80) s += 0.2;
  if (t.length > 240) s += 0.1;
  if (/\b(wichtig|immer|nie|merke|regel|bevorzug|prefer)\b/i.test(t)) s += 0.25;
  if (SECRET_RE.test(t)) s += 0.1;
  return Math.max(0, Math.min(1, s));
}

/* =========================================================
 * Backends
 * ========================================================= */
interface MemoryBackend {
  remember(rec: MemoryRecord): Promise<void>;
  recall(dataset: string, query: string, limit: number): Promise<MemoryRecord[]>;
  forget(dataset: string, id: string): Promise<void>;
  improve(dataset: string): Promise<void>;
}

/** Persisted local queue — the always-available fallback. */
class OfflineBackend implements MemoryBackend {
  private async load(): Promise<MemoryRecord[]> {
    try {
      const s = await Store.load(QUEUE_FILE);
      return (await s.get<MemoryRecord[]>(QUEUE_KEY)) ?? [];
    } catch {
      return [];
    }
  }
  private async save(records: MemoryRecord[]): Promise<void> {
    const s = await Store.load(QUEUE_FILE);
    await s.set(QUEUE_KEY, records);
    await s.save();
  }
  async remember(rec: MemoryRecord): Promise<void> {
    const all = await this.load();
    all.push(rec);
    await this.save(all.slice(-2000));
  }
  async recall(dataset: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const all = await this.load();
    const q = query.toLowerCase();
    return all
      .filter((r) => r.dataset === dataset)
      .map((r) => ({ r, hit: r.content.toLowerCase().includes(q) ? 1 : 0 }))
      .sort((a, b) => b.hit - a.hit || b.r.importance - a.r.importance || b.r.createdAt - a.r.createdAt)
      .slice(0, limit)
      .map((x) => x.r);
  }
  async forget(dataset: string, id: string): Promise<void> {
    const all = await this.load();
    await this.save(all.filter((r) => !(r.dataset === dataset && r.id === id)));
  }
  async improve(): Promise<void> {
    /* no-op offline */
  }
  async listSyncable(): Promise<MemoryRecord[]> {
    return (await this.load()).filter((r) => r.visibility !== "private" && !r.synced);
  }
  async markSynced(ids: string[]): Promise<void> {
    const set = new Set(ids);
    const all = await this.load();
    for (const r of all) if (set.has(r.id)) r.synced = true;
    await this.save(all);
  }
}

/** Cognee HTTP backend (local sidecar or server). */
class CogneeBackend implements MemoryBackend {
  constructor(private baseUrl: string) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Cognee HTTP ${res.status}`);
    return (await res.json().catch(() => ({}))) as T;
  }

  async remember(rec: MemoryRecord): Promise<void> {
    await this.call(COGNEE.add, { dataset: rec.dataset, data: rec.content, metadata: rec });
  }
  async recall(dataset: string, query: string, limit: number): Promise<MemoryRecord[]> {
    const r = await this.call<{ results?: any[] }>(COGNEE.search, { dataset, query, top_k: limit });
    return (r.results ?? []).map((x: any, i: number) => ({
      id: String(x.id ?? `r_${i}`),
      scope: (x.metadata?.scope ?? "project") as MemoryScope,
      dataset,
      content: String(x.text ?? x.content ?? x.metadata?.content ?? ""),
      type: String(x.metadata?.type ?? "note"),
      visibility: (x.metadata?.visibility ?? "syncable") as MemoryVisibility,
      importance: Number(x.metadata?.importance ?? x.score ?? 0.5),
      source: String(x.metadata?.source ?? "cognee"),
      tags: Array.isArray(x.metadata?.tags) ? x.metadata.tags : [],
      createdAt: Number(x.metadata?.createdAt ?? Date.now()),
    }));
  }
  async forget(dataset: string, id: string): Promise<void> {
    await this.call(COGNEE.delete, { dataset, id });
  }
  async improve(dataset: string): Promise<void> {
    await this.call(COGNEE.cognify, { dataset });
  }
}

/* =========================================================
 * Config + facade
 * ========================================================= */
async function cogneeBaseUrl(): Promise<string> {
  try {
    const s = await Store.load(SETTINGS_FILE);
    return ((await s.get<string>("cognee_base_url")) ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

export class LuczorMemoryService {
  private offline = new OfflineBackend();

  private async backend(): Promise<MemoryBackend> {
    const url = await cogneeBaseUrl();
    return url ? new CogneeBackend(url) : this.offline;
  }

  /** Store a memory. Always persists locally; also to Cognee when available. */
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const scope = input.scope ?? "project";
    const auto = classify(input.content);
    const rec: MemoryRecord = {
      id: uid(),
      scope,
      dataset: datasetFor(scope, input),
      content: input.content.trim(),
      type: input.type ?? auto.type,
      visibility: input.visibility ?? auto.visibility,
      importance: input.importance ?? score(input.content),
      source: input.source ?? "chat",
      tags: input.tags ?? [],
      createdAt: Date.now(),
      meta: input.meta,
    };

    // Local persistence is the source of truth; Cognee is best-effort.
    await this.offline.remember(rec);
    try {
      const be = await this.backend();
      if (be !== this.offline) await be.remember(rec);
    } catch (e) {
      console.warn("[memory] Cognee remember failed, kept locally:", e);
    }
    return rec;
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    const scope = q.scope ?? "project";
    const dataset = datasetFor(scope, q);
    const limit = q.limit ?? 6;
    try {
      const be = await this.backend();
      const hits = await be.recall(dataset, q.query, limit);
      if (hits.length || be === this.offline) return hits;
    } catch (e) {
      console.warn("[memory] Cognee recall failed, using local:", e);
    }
    return this.offline.recall(dataset, q.query, limit);
  }

  async forget(scope: MemoryScope, id: string, ids: { userId?: string; projectId?: string; agentId?: string } = {}): Promise<void> {
    const dataset = datasetFor(scope, ids);
    await this.offline.forget(dataset, id);
    try {
      const be = await this.backend();
      if (be !== this.offline) await be.forget(dataset, id);
    } catch {
      /* ignore */
    }
  }

  /** Trigger Cognee's graph/ontology build for a dataset. */
  async improve(scope: MemoryScope, ids: { userId?: string; projectId?: string; agentId?: string } = {}): Promise<void> {
    try {
      const be = await this.backend();
      if (be !== this.offline) await be.improve(datasetFor(scope, ids));
    } catch (e) {
      console.warn("[memory] improve failed:", e);
    }
  }

  classify = classify;
  score = score;

  /**
   * Convenience for the agent: compact memory context to inject into a prompt.
   * Returns a short German block or "" when nothing relevant / no backend.
   */
  async getContextForPrompt(projectId: string, query: string, limit = 5): Promise<string> {
    const hits = await this.recall({ scope: "project", projectId, query, limit });
    if (!hits.length) return "";
    const lines = hits.map((h) => `- ${h.content}`).join("\n");
    return `Relevante Erinnerungen:\n${lines}`;
  }

  /** Number of syncable, not-yet-synced local records. */
  async pendingSyncCount(): Promise<number> {
    return (await this.offline.listSyncable()).length;
  }

  /**
   * Reachability of the Cognee endpoint.
   * null = not configured, true = reachable (any HTTP response), false = network error.
   */
  async cogneeHealth(): Promise<boolean | null> {
    const url = await cogneeBaseUrl();
    if (!url) return null;
    try {
      await fetch(`${url}/health`, { method: "GET" });
      return true; // any response (even 404) means the service is up
    } catch {
      return false;
    }
  }
}

export const luczorMemory = new LuczorMemoryService();

/** User memory preferences (Settings). */
export async function getMemoryPrefs(): Promise<{
  inject: boolean;
  injectCount: number;
  autoRemember: boolean;
}> {
  try {
    const s = await Store.load(SETTINGS_FILE);
    return {
      inject: (await s.get<boolean>("memory_inject")) ?? true,
      injectCount: (await s.get<number>("memory_inject_count")) ?? 5,
      autoRemember: (await s.get<boolean>("memory_auto_remember")) ?? true,
    };
  } catch {
    return { inject: true, injectCount: 5, autoRemember: true };
  }
}
