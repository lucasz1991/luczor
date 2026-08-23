import type { AppState } from '@/state/types'
import { Store } from '@tauri-apps/plugin-store'
import { DEFAULT_STATE } from '@/state/defaults'

const STORE_FILE = 'luczor.app.json'
const KEY = 'app_state_v1'

let store: Store | null = null
let timer: number | null = null

async function getStore() {
  if (!store) store = await Store.load(STORE_FILE)
  return store
}

export async function loadAppState(): Promise<AppState> {
  try {
    const s = await getStore()
    const loaded = await s.get<AppState>(KEY)
    if (loaded && typeof loaded === 'object') return loaded
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
    // remove proxies/reactivity safely
    const plain = JSON.parse(JSON.stringify(state)) as AppState
    await s.set(KEY, plain)
    await s.save()
  } catch {
    // ignore (optional: toast/log)
  }
}
