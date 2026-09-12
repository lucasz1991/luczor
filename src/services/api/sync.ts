// src/services/api/sync.ts
//
// Sync bridge: pushes the local Luczor state (projects, messages, memories,
// summaries) to the Laravel archive, and offers a connection test that also
// validates the device key via /bootstrap.
//
// Laravel is the v1 "sync/archive" backend — the desktop app remains the
// source of truth and works fully offline; this just mirrors state upstream.

import { Store } from '@tauri-apps/plugin-store'
import { LuczorApi, type SyncPushResponse } from './luczorApi'
import { state } from '@/state/store'
import type { Message } from '@/state/types'

/** Strip Vue reactivity / proxies into a plain JSON-serializable value. */
function plain<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

export type ConnectionResult = { ok: boolean; message: string }

/** Explicit allowlist: native repository paths/graph metadata must never sync. */
export function projectsForSync(projects: unknown[]): Array<Record<string, unknown>> {
  return projects
    .filter(project => !(project as { cloud?: unknown } | null)?.cloud)
    .map(project => {
      const value = (project ?? {}) as Record<string, unknown>
      return plain({
        id: value.id,
        name: value.name,
        goal: value.goal,
        goals: value.goals,
        summary: value.summary,
        defaults: value.defaults,
        focus: value.focus,
        archivedAt: value.archivedAt,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      })
    })
}

/**
 * Tool observations such as clipboard text, local file contents and coding
 * agent output are usable only inside their approved provider round. They must
 * never become part of the server-side archive.
 */
export function messagesForSync(messages: Message[]): Message[] {
  return plain(messages.filter(message => message.meta?.dataHandling !== 'ephemeral' && !message.meta?.isLoading))
}

/** Verify the server is reachable and the device key is valid. */
export async function testConnection(): Promise<ConnectionResult> {
  try {
    await LuczorApi.health()
    const boot = await LuczorApi.bootstrap()
    const who = boot.user?.name ?? boot.device?.name ?? 'Gerät'
    return {
      ok: true,
      message: `Verbunden als ${who} · Modellrouting wird zentral vom Server verwaltet.`,
    }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) }
  }
}

/** Push the entire local state as an idempotent batch. */
export async function pushAllToServer(): Promise<SyncPushResponse> {
  const cfg = await LuczorApi.getConfig()
  const cloudIds = new Set(state.projects.filter(project => project.cloud).map(project => project.id))
  return LuczorApi.syncPush({
    client_id: cfg.clientId,
    projects: projectsForSync(state.projects ?? []),
    messages: messagesForSync((state.messages ?? []).filter(message => !cloudIds.has(message.projectId))),
    memories: plain(
      (state.global?.memories ?? []).filter(memory => !memory.projectId || !cloudIds.has(memory.projectId))
    ),
    summaries: plain((state.summaries ?? []).filter(summary => !cloudIds.has(summary.projectId))),
  })
}

/**
 * Pull the admin-managed client defaults (runtime_settings.settings) and write
 * the matching keys into the local settings store. Returns how many applied.
 */
export async function pullServerDefaults(): Promise<number> {
  const boot = await LuczorApi.bootstrap()
  const server = (boot.runtime_settings?.settings ?? {}) as Record<string, unknown>

  // server key -> local settings-store key
  const map: Record<string, string> = {
    assistant_name: 'assistant_name',
    ui_accent: 'ui_accent',
    memory_inject: 'memory_inject',
    memory_inject_count: 'memory_inject_count',
    client_history_token_budget: 'client_history_token_budget',
    sync_auto: 'sync_auto',
    sync_auto_threshold: 'sync_auto_threshold',
    default_mode: 'default_mode',
    allow_unrestricted: 'allow_unrestricted',
    chat_auto_speech: 'chat_auto_speech',
    voice_mode: 'voice_mode',
    voice_wake_word: 'voice_wake_word',
    voice_local_stt_language: 'voice_local_stt_language',
    voice_stt_engine: 'voice_stt_engine',
    hands_free_strategy: 'hands_free_strategy',
    voice_trigger_phrase: 'voice_trigger_phrase',
    voice_end_phrase: 'voice_end_phrase',
    voice_continuous_silence_ms: 'voice_continuous_silence_ms',
    voice_tts_rate: 'voice_tts_rate',
    voice_tts_volume: 'voice_tts_volume',
    voice_interrupt_mode: 'voice_interrupt_mode',
  }

  const s = await Store.load('luczor.settings.json')
  let applied = 0
  for (const [serverKey, localKey] of Object.entries(map)) {
    if (serverKey in server && server[serverKey] != null) {
      await s.set(localKey, server[serverKey])
      applied++
    }
  }
  await s.save()
  return applied
}

/**
 * Best-effort, append-only agent event to the server brain archive.
 * Silently no-ops when the server/device key is not configured, and never
 * throws — telemetry must not break the agent loop.
 */
export async function logAgentEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const cfg = await LuczorApi.getConfig()
    if (!cfg.baseUrl || !cfg.deviceKey) return
    await LuczorApi.agentEvent({ event_type: eventType, payload, occurred_at_client: Date.now() }, cfg.clientId)
  } catch {
    /* ignore */
  }
}
