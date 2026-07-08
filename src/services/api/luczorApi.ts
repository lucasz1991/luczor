// src/services/api/luczorApi.ts
//
// Typed client for the Luczor Admin API (Laravel, admin_api_app).
//
// Auth: a Custom Device Key sent as `Authorization: Bearer <key>`
// (the server also accepts `X-Api-Key`). Base URL + key + a stable client_id
// live in the local settings store (luczor.settings.json).
//
// Endpoints (all under /api/v1):
//   GET  /health                      (no auth)
//   GET  /bootstrap                   (settings.read)
//   GET  /model-profiles              (settings.read)
//   GET  /runtime-settings            (settings.read)
//   POST /sync/push                   (sync.write)
//   GET  /sync/pull?since=ISO         (sync.read)
//   POST /agent-events                (brain.write)

import { Store } from "@tauri-apps/plugin-store";

const SETTINGS_FILE = "luczor.settings.json";
const API_PREFIX = "/api/v1";

/* =========================================================
 * Response/request types (match admin_api_app controllers)
 * ========================================================= */
export type ModelProfile = {
  id: number;
  name: string;
  slug: string;
  provider: string;
  model_id: string;
  temperature: number;
  max_tokens: number;
  purpose: string | null;
  active: boolean;
};

export type ModelUseCaseFallback = {
  order: number;
  model_profile: {
    slug: string;
    name: string;
    provider: string;
    model_id: string;
    temperature: number;
    max_tokens: number;
  };
};

export type ModelUseCase = {
  name: string;
  slug: string;
  description: string | null;
  fallbacks: ModelUseCaseFallback[];
};

export type RuntimeSettings = {
  default_model_profile: string;
  api_prefix: string;
  registration_enabled: boolean;
};

export type BootstrapResponse = {
  device: { id: string | null; name: string | null; abilities: string[] };
  user: { id: number | null; name: string | null; email: string | null };
  runtime_settings: RuntimeSettings;
  model_profiles: ModelProfile[];
  model_use_cases: ModelUseCase[];
};

export type SyncBatch = {
  client_id: string;
  projects?: unknown[];
  messages?: unknown[];
  memories?: unknown[];
  summaries?: unknown[];
};

export type SyncPushResponse = { ok: boolean; counts: Record<string, number>; cursor: string };
export type SyncPullResponse = { data: Record<string, unknown[]>; cursor: string };

export type AgentEventInput = {
  external_id?: string;
  event_type?: string;
  payload: Record<string, unknown>;
  occurred_at_client?: number | string;
};

export type LuczorApiConfig = {
  baseUrl: string;
  deviceKey: string;
  clientId: string;
};

/* =========================================================
 * Config (persisted in the settings store)
 * ========================================================= */
function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `c_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

async function store() {
  return Store.load(SETTINGS_FILE);
}

/** Load config, minting a stable client_id on first use. */
export async function getApiConfig(): Promise<LuczorApiConfig> {
  const s = await store();
  const baseUrl = ((await s.get<string>("luczor_api_base_url")) ?? "").trim().replace(/\/+$/, "");
  const deviceKey = ((await s.get<string>("luczor_device_key")) ?? "").trim();

  let clientId = ((await s.get<string>("luczor_client_id")) ?? "").trim();
  if (!clientId) {
    clientId = `luczor_${randomId()}`;
    await s.set("luczor_client_id", clientId);
    await s.save();
  }
  return { baseUrl, deviceKey, clientId };
}

export async function saveApiConfig(baseUrl: string, deviceKey: string): Promise<void> {
  const s = await store();
  await s.set("luczor_api_base_url", baseUrl.trim().replace(/\/+$/, ""));
  await s.set("luczor_device_key", deviceKey.trim());
  await s.save();
}

export function isConfigured(cfg: LuczorApiConfig): boolean {
  return !!cfg.baseUrl && !!cfg.deviceKey;
}

/* =========================================================
 * Transport
 * ========================================================= */
export class LuczorApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LuczorApiError";
    this.status = status;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Set false for the public /health endpoint. */
  auth?: boolean;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
};

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const cfg = await getApiConfig();
  if (!cfg.baseUrl) throw new LuczorApiError(0, "Keine Server-URL konfiguriert (Settings → Server).");

  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const url = `${cfg.baseUrl}${API_PREFIX}${path}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body != null) headers["Content-Type"] = "application/json";
  if (opts.auth !== false) {
    if (!cfg.deviceKey) throw new LuczorApiError(0, "Kein Device-Key konfiguriert (Settings → Server).");
    headers["Authorization"] = `Bearer ${cfg.deviceKey}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e: any) {
    throw new LuczorApiError(0, `Verbindung fehlgeschlagen: ${e?.message ?? String(e)}`);
  }

  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    throw new LuczorApiError(res.status, json?.message ?? `HTTP ${res.status}: ${text || res.statusText}`);
  }
  return json as T;
}

/* =========================================================
 * Public API
 * ========================================================= */
export const LuczorApi = {
  getConfig: getApiConfig,
  saveConfig: saveApiConfig,
  isConfigured,

  health: () => request<{ status?: string; time?: string }>("/health", { auth: false }),
  bootstrap: (signal?: AbortSignal) => request<BootstrapResponse>("/bootstrap", { signal }),
  modelProfiles: () => request<{ data: ModelProfile[] }>("/model-profiles"),
  runtimeSettings: () =>
    request<{ data: RuntimeSettings; model_use_cases: ModelUseCase[] }>("/runtime-settings"),

  syncPush: (batch: SyncBatch) =>
    request<SyncPushResponse>("/sync/push", { method: "POST", body: batch }),
  syncPull: (since?: string) =>
    request<SyncPullResponse>("/sync/pull", { query: { since } }),

  agentEvent: (evt: AgentEventInput, clientId: string) =>
    request<{ ok: boolean; id: number }>("/agent-events", {
      method: "POST",
      body: { client_id: clientId, ...evt },
    }),
};
