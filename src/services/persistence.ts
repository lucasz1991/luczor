import type { AppState } from '@/state/types'
import { Store } from '@tauri-apps/plugin-store'
import { DEFAULT_STATE } from '@/state/defaults'
import { getTool } from '@/services/tools/registry'

const STORE_FILE = 'luczor.app.json'
const KEY = 'app_state_v1'

let store: Store | null = null
let timer: number | null = null

async function getStore() {
  if (!store) store = await Store.load(STORE_FILE)
  return store
}

/** Redact archive copies without changing the arguments shown by live approvals. */
export function stateForPersistence(state: AppState): AppState {
  const plain = JSON.parse(JSON.stringify(state)) as AppState
  for (const bucket of Object.values(plain.pending?.toolCallsByProject ?? {})) {
    if (!Array.isArray(bucket)) continue
    for (const call of bucket) {
      if (!call || typeof call !== 'object') continue
      const definition = getTool(call.name)
      // Unknown/removed tools cannot supply a trustworthy retention policy.
      if (
        !definition ||
        call.dataHandling === 'ephemeral' ||
        definition.dataHandling === 'ephemeral' ||
        definition.risk === 'sensitive' ||
        definition.risk === 'critical'
      ) {
        call.dataHandling = 'ephemeral'
        call.args = { redacted: true }
        if (call.result) {
          call.result = {
            toolCallId: call.id,
            name: call.name,
            ok: call.result.ok,
            ts: call.result.ts,
            output: { redacted: true },
            ...(call.result.ok ? {} : { error: 'Lokale Tool-Details wurden nicht archiviert.' }),
          }
        }
        // A restored redacted proposal no longer has executable arguments or
        // an active approval promise. Its live counterpart is left untouched.
        if (['proposed', 'approved', 'executing'].includes(call.status)) call.status = 'canceled'
      }
    }
  }
  return plain
}

export async function loadAppState(): Promise<AppState> {
  try {
    const s = await getStore()
    const loaded = await s.get<AppState>(KEY)
    if (loaded && typeof loaded === 'object') {
      const safe = stateForPersistence(loaded)
      if (JSON.stringify(safe) !== JSON.stringify(loaded)) {
        // Remove historical raw arguments from the stored snapshot as well;
        // a failed cleanup write must not restore raw data into the UI.
        try {
          await s.set(KEY, safe)
          await s.save()
        } catch {
          // The next ordinary save retries persistence of the redacted state.
        }
      }
      return safe
    }
  } catch {
    // ignore
  }
  return structuredClone(DEFAULT_STATE)
}

export function scheduleSave(state: AppState, debounceMs = 300) {
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => void saveAppState(state), debounceMs)
}

export async function saveAppState(state: AppState): Promise<void> {
  try {
    const s = await getStore()
    const plain = stateForPersistence(state)
    await s.set(KEY, plain)
    await s.save()
  } catch {
    // ignore (optional: toast/log)
  }
}
