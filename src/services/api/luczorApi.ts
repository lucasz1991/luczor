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
//   GET  /realtime/config             (device.connect)
//   POST /sync/push                   (sync.write)
//   GET  /sync/pull?since=ISO         (sync.read)
//   POST /agent-events                (brain.write)

import { Store } from "@tauri-apps/plugin-store";

const SETTINGS_FILE = "luczor.settings.json";
const API_PREFIX = "/api/v1";

/** Production API. Always used when the user has not set a custom URL. */
export const DEFAULT_BASE_URL = "https://luczor.follow-flow.de";

/* =========================================================
 * Response/request types (match admin_api_app controllers)
 * ========================================================= */
export type RuntimeSettings = {
  api_prefix: string;
  registration_enabled: boolean;
  /** Admin-managed client defaults (Setting::asMap()); consumed by pullServerDefaults. */
  settings?: Record<string, unknown>;
};

export type BootstrapResponse = {
  device: { id: string | null; name: string | null; abilities: string[] };
  user: { id: number | null; name: string | null; email: string | null };
  runtime_settings: RuntimeSettings;
  routing: { managed_by: "server"; client_model_selection: false };
  realtime?: { key: string | null; host: string | null; port: number; scheme: string | null };
};

export type RealtimeConfig = {
  key: string | null;
  host: string | null;
  port: number;
  scheme: string | null;
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

export type VoiceManifestResponse = {
  algorithm: "RSA-SHA256";
  payload_json: string;
  signature: string;
};

export type DeviceSession = { token: string; nonce: string; expires_at: string };
export type DeviceJob = {
  id: string;
  tool_profile: string;
  status: "approval_required" | "queued" | "running" | string;
  risk_level: string;
  requires_local_approval: boolean;
  payload: Record<string, unknown>;
  payload_hash: string;
  signature: string;
  expires_at: string | null;
};

export const APP_NOTIFICATION_CATEGORIES = ["general", "agent", "workflow", "device", "security"] as const;
export type AppNotificationCategory = (typeof APP_NOTIFICATION_CATEGORIES)[number];
export type NotificationCategoryPreferences = Record<AppNotificationCategory, boolean>;
export type NotificationPriority = "low" | "normal" | "high";

export type AppNotification = {
  id: string;
  sequence: number;
  category: AppNotificationCategory;
  title: string;
  body: string;
  action_url: string | null;
  data: Record<string, unknown>;
  priority: NotificationPriority;
  created_at: string;
  expires_at: string | null;
  read_at: string | null;
};

export type NotificationPreferences = {
  enabled: boolean;
  categories: NotificationCategoryPreferences;
  effective_categories: NotificationCategoryPreferences;
};

export type NotificationPreferencesPatch = {
  enabled?: boolean;
  categories?: Partial<NotificationCategoryPreferences>;
};

export type NotificationListOptions = {
  after?: number;
  limit?: number;
  unreadOnly?: boolean;
};

export type NotificationListResponse = {
  data: AppNotification[];
  meta: {
    next_after: number;
    has_more: boolean;
    unread_count: number;
  };
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
  const stored = ((await s.get<string>("luczor_api_base_url")) ?? "").trim().replace(/\/+$/, "");
  const baseUrl = stored || DEFAULT_BASE_URL; // default always applies
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

function emitDebug(level: "warn" | "error", event: string, detail: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("luczor:debug", { detail: { level, event, detail } }));
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  /** Set false for the public /health endpoint. */
  auth?: boolean;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const cfg = await getApiConfig();
  if (!cfg.baseUrl) {
    emitDebug("error", "api_config_missing", { path });
    throw new LuczorApiError(0, "Keine Server-URL konfiguriert (Settings → Server).");
  }

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
    if (!cfg.deviceKey) {
      emitDebug("error", "device_key_missing", { path });
      throw new LuczorApiError(0, "Kein Device-Key konfiguriert (Settings → Server).");
    }
    headers["Authorization"] = `Bearer ${cfg.deviceKey}`;
  }
  Object.assign(headers, opts.headers ?? {});

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e: any) {
    emitDebug("error", "api_network_error", { path, message: e?.message ?? String(e) });
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
    emitDebug(res.status >= 500 ? "error" : "warn", "api_http_error", { path, status: res.status, message: json?.message ?? (text || res.statusText) });
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
  realtimeConfig: () => request<{ data: RealtimeConfig }>("/realtime/config"),
  runtimeSettings: () =>
    request<{ data: RuntimeSettings; routing: { managed_by: "server"; client_model_selection: false } }>("/runtime-settings"),
  voiceManifest: () => request<VoiceManifestResponse>("/voice/manifest"),
  pollDebugRequest: async () => {
    const cfg = await getApiConfig();
    return request<{ data: { id: string; requested_at: string } | null }>("/devices/debug/poll", { query: { client_id: cfg.clientId } });
  },
  completeDebugRequest: async (id: string, report: Record<string, unknown>) => {
    const cfg = await getApiConfig();
    return request<{ ok: boolean }>(`/devices/debug/${encodeURIComponent(id)}/complete`, { method: "POST", body: { client_id: cfg.clientId, report } });
  },

  registerDevice: (clientId: string, name: string) =>
    request<{ data: unknown; session: DeviceSession }>("/devices/register", {
      method: "POST",
      body: { client_id: clientId, name },
    }),
  nextDeviceJob: (clientId: string) => request<{ data: DeviceJob | null }>("/devices/jobs/next", { query: { client_id: clientId } }),
  approveDeviceJob: (id: string, clientId: string, approved: boolean, reason?: string) =>
    request<{ data: DeviceJob }>(`/devices/jobs/${encodeURIComponent(id)}/approve`, {
      method: "POST", body: { client_id: clientId, approved, reason },
    }),
  startDeviceJob: (id: string, clientId: string) =>
    request<{ data: DeviceJob }>(`/devices/jobs/${encodeURIComponent(id)}/start`, { method: "POST", body: { client_id: clientId } }),
  completeDeviceJob: (id: string, clientId: string, ok: boolean, result?: Record<string, unknown>, error?: string) =>
    request<{ data: DeviceJob }>(`/devices/jobs/${encodeURIComponent(id)}/complete`, {
      method: "POST", body: { client_id: clientId, ok, result, error },
    }),
  reverbAuth: (socketId: string, channelName: string, clientId: string, sessionToken: string) =>
    request<{ auth: string }>("/reverb/auth", {
      method: "POST", body: { socket_id: socketId, channel_name: channelName, client_id: clientId },
      headers: { "X-Device-Session": sessionToken },
    }),

  getNotificationPreferences: (clientId: string) =>
    request<{ data: NotificationPreferences }>("/notification-preferences", {
      query: { client_id: clientId },
    }),
  updateNotificationPreferences: (clientId: string, patch: NotificationPreferencesPatch) =>
    request<{ data: NotificationPreferences }>("/notification-preferences", {
      method: "PUT",
      body: { client_id: clientId, ...patch },
    }),
  listNotifications: (clientId: string, options: NotificationListOptions = {}) =>
    request<NotificationListResponse>("/notifications", {
      query: {
        client_id: clientId,
        after: String(options.after ?? 0),
        limit: String(options.limit ?? 50),
        unread_only: options.unreadOnly ? "1" : "0",
      },
    }),
  markNotificationRead: (id: string, clientId: string) => request<{ data: AppNotification; meta: { unread_count: number } }>(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: { client_id: clientId } }),
  markAllNotificationsRead: (clientId: string, through?: number) =>
    request<{ data: { updated: number; read_at: string }; meta: { unread_count: number } }>("/notifications/read-all", {
      method: "POST",
      body: { client_id: clientId, ...(through == null ? {} : { through }) },
    }),

  syncPush: (batch: SyncBatch) =>
    request<SyncPushResponse>("/sync/push", { method: "POST", body: batch }),
  syncPull: (since?: string) =>
    request<SyncPullResponse>("/sync/pull", { query: { since } }),

  getPreferences: () =>
    request<{ preferences: Record<string, { value: unknown; updated_at: string | null }> }>("/preferences"),
  putPreferences: (preferences: Array<{ key: string; value: unknown; updated_at?: string }>) =>
    request<{ applied: string[]; skipped: string[] }>("/preferences", { method: "PUT", body: { preferences } }),

  // Projects / conversations / tasks (agent-tool backing, server is SoR).
  createProject: (externalId: string, name: string) =>
    request<{ data: unknown }>("/projects", { method: "POST", body: { external_id: externalId, name } }),
  listProjects: () => request<{ data: unknown[] }>("/projects"),
  createConversation: (body: { title?: string; project_id?: string; client_id?: string }) =>
    request<{ data: { external_id: string; title: string | null } }>("/conversations", { method: "POST", body }),
  listConversations: (projectId?: string) =>
    request<{ data: unknown[] }>("/conversations", { query: { project_id: projectId } }),
  createTask: (body: { title: string; description?: string; priority?: string; project_id?: string; conversation_id?: string; due_at?: string; client_id?: string }) =>
    request<{ data: { external_id: string } }>("/tasks", { method: "POST", body }),
  listTasks: (query?: { status?: string; project_id?: string; conversation_id?: string }) =>
    request<{ data: unknown[] }>("/tasks", { query }),
  updateTask: (externalId: string, body: Record<string, unknown>) =>
    request<{ data: unknown }>(`/tasks/${encodeURIComponent(externalId)}`, { method: "PATCH", body }),

  agentEvent: (evt: AgentEventInput, clientId: string) =>
    request<{ ok: boolean; id: number }>("/agent-events", {
      method: "POST",
      body: { client_id: clientId, ...evt },
    }),

  evaluateLlmRun: (requestId: string, evaluation: Record<string, unknown>) =>
    request<{ data: unknown }>(`/llm/runs/request/${encodeURIComponent(requestId)}/evaluate`, {
      method: "POST",
      body: evaluation,
    }),

};
