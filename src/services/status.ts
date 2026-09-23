// src/services/status.ts
//
// Refreshes the HUD sync/memory telemetry:
//  - pending: syncable local memories plus durable project-create retries
//  - server:  Laravel Admin API reachability (only pinged when configured)
//  - cognee:  whether a Cognee endpoint is configured

import { Store } from '@tauri-apps/plugin-store'
import { setSyncStatus, type ConnState } from '@/state/hud'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { LuczorApi } from '@/services/api/luczorApi'
import { synchronizeAll } from '@/services/syncCoordinator'
import { flushProjectSyncQueue, pendingProjectSyncCount } from '@/services/api/projectSyncQueue'
import { executionGate } from '@/services/executionGate'

const SETTINGS_FILE = 'luczor.settings.json'

let inFlight = false
let autoSyncing = false

export async function refreshStatus(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    let memoryPending = 0
    try {
      memoryPending = await luczorMemory.pendingSyncCount()
    } catch {
      /* ignore */
    }
    let projectPending = await pendingProjectSyncCount().catch(() => 0)

    let server: ConnState = 'disabled'
    try {
      const cfg = await LuczorApi.getConfig()
      if (cfg.baseUrl && cfg.deviceKey) {
        try {
          await LuczorApi.health()
          server = 'online'
        } catch {
          server = 'offline'
        }
      }
    } catch {
      /* ignore */
    }

    if (server === 'online' && projectPending > 0) {
      await flushProjectSyncQueue({ signal: executionGate.capture().signal }).catch(() => undefined)
      projectPending = await pendingProjectSyncCount().catch(() => projectPending)
    }

    let cognee: ConnState = 'disabled'
    try {
      const ch = await luczorMemory.memoryHealth()
      cognee = ch === null ? 'disabled' : ch ? 'online' : 'offline'
    } catch {
      /* ignore */
    }

    setSyncStatus({ pending: memoryPending + projectPending, server, cognee })

    // Auto-sync: when enabled, the server is reachable and enough records piled
    // up, push in the background (once at a time).
    if (server === 'online' && memoryPending > 0 && !autoSyncing) {
      const s = await Store.load(SETTINGS_FILE)
      const auto = (await s.get<boolean>('sync_auto')) ?? false
      const threshold = (await s.get<number>('sync_auto_threshold')) ?? 20
      if (auto && memoryPending >= threshold) {
        autoSyncing = true
        try {
          await synchronizeAll()
          const now = await luczorMemory.pendingSyncCount().catch(() => memoryPending)
          setSyncStatus({ pending: now + projectPending, server, cognee })
        } catch {
          /* best-effort */
        } finally {
          autoSyncing = false
        }
      }
    }
  } finally {
    inFlight = false
  }
}

/** Manual sync trigger (e.g. clicking the HUD ⇅). Returns pushed count. */
export async function syncNow(): Promise<number> {
  try {
    const result = await synchronizeAll({ force: true })
    if (result.memory.errors.length)
      throw new Error('Ein Teil des Gedächtnisabgleichs ist noch offen. Details stehen im Gedächtnisinspektor.')
    return result.total
  } finally {
    await refreshStatus()
  }
}
