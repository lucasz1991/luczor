// src/services/api/sync.ts
//
// Sync bridge: pushes the local Luczor state (projects, messages, memories,
// summaries) to the Laravel archive, and offers a connection test that also
// validates the device key via /bootstrap.
//
// Laravel is the v1 "sync/archive" backend — the desktop app remains the
// source of truth and works fully offline; this just mirrors state upstream.

import { LuczorApi, type SyncPushResponse } from "./luczorApi";
import { state } from "@/state/store";

/** Strip Vue reactivity / proxies into a plain JSON-serializable value. */
function plain<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export type ConnectionResult = { ok: boolean; message: string };

/** Verify the server is reachable and the device key is valid. */
export async function testConnection(): Promise<ConnectionResult> {
  try {
    await LuczorApi.health();
    const boot = await LuczorApi.bootstrap();
    const who = boot.user?.name ?? boot.device?.name ?? "Gerät";
    return {
      ok: true,
      message: `Verbunden als ${who} · ${boot.model_profiles.length} Modellprofile · ${boot.model_use_cases.length} Use-Cases.`,
    };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

/** Push the entire local state as an idempotent batch. */
export async function pushAllToServer(): Promise<SyncPushResponse> {
  const cfg = await LuczorApi.getConfig();
  return LuczorApi.syncPush({
    client_id: cfg.clientId,
    projects: plain(state.projects ?? []),
    messages: plain(state.messages ?? []),
    memories: plain(state.global?.memories ?? []),
    summaries: plain(state.summaries ?? []),
  });
}

/**
 * Best-effort, append-only agent event to the server brain archive.
 * Silently no-ops when the server/device key is not configured, and never
 * throws — telemetry must not break the agent loop.
 */
export async function logAgentEvent(
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const cfg = await LuczorApi.getConfig();
    if (!cfg.baseUrl || !cfg.deviceKey) return;
    await LuczorApi.agentEvent(
      { event_type: eventType, payload, occurred_at_client: Date.now() },
      cfg.clientId
    );
  } catch {
    /* ignore */
  }
}
