import { Store } from '@tauri-apps/plugin-store'

const SETTINGS_FILE = 'luczor.settings.json'
const CONTROLLED_SETTINGS = [
  'active_mode',
  'default_mode',
  'allow_unrestricted',
  'auto_execute_mutating_tools',
  'memory_inject',
  'memory_inject_count',
  'memory_auto_remember',
  'memory_use_server',
  'sync_auto',
  'local_model_flash_experiment',
  'client_history_token_budget',
  'chat_auto_speech',
  'luczor_api_base_url',
] as const

export type LocalModelE2eSettingsSnapshot = Array<{
  key: (typeof CONTROLLED_SETTINGS)[number]
  present: boolean
  value?: unknown
}>

const EXPECTED_TEST_SETTINGS = {
  active_mode: 'observe',
  default_mode: 'observe',
  allow_unrestricted: false,
  auto_execute_mutating_tools: false,
  memory_inject: false,
  memory_inject_count: 0,
  memory_auto_remember: false,
  memory_use_server: false,
  sync_auto: false,
  local_model_flash_experiment: false,
  client_history_token_budget: 2_400,
  chat_auto_speech: false,
} as const

function normalizedLoopbackBaseUrl(rawValue: string): string {
  const value = rawValue.trim().replace(/\/+$/, '')
  const parsed = new URL(value)
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('The local-model E2E profile accepts only a loopback control plane.')
  }
  return parsed.origin
}

/**
 * Snapshot persistent settings before the CDP harness applies its isolated
 * profile. Production startup never imports or calls this module.
 */
export async function snapshotLocalModelE2eSettings(): Promise<LocalModelE2eSettingsSnapshot> {
  const store = await Store.load(SETTINGS_FILE)
  const snapshot: LocalModelE2eSettingsSnapshot = []
  for (const key of CONTROLLED_SETTINGS) {
    const value = await store.get(key)
    snapshot.push({ key, present: value !== undefined, value })
  }
  return snapshot
}

export async function applyLocalModelE2eSettings(controlPlaneBaseUrl: string): Promise<void> {
  const store = await Store.load(SETTINGS_FILE)
  for (const [key, value] of Object.entries(EXPECTED_TEST_SETTINGS)) await store.set(key, value)
  await store.set('luczor_api_base_url', normalizedLoopbackBaseUrl(controlPlaneBaseUrl))
  await store.save()
}

export async function verifyLocalModelE2eSettings(controlPlaneBaseUrl: string): Promise<boolean> {
  const store = await Store.load(SETTINGS_FILE)
  for (const [key, value] of Object.entries(EXPECTED_TEST_SETTINGS)) {
    if ((await store.get(key)) !== value) return false
  }
  return (await store.get('luczor_api_base_url')) === normalizedLoopbackBaseUrl(controlPlaneBaseUrl)
}

export async function restoreLocalModelE2eSettings(snapshot: LocalModelE2eSettingsSnapshot): Promise<void> {
  const store = await Store.load(SETTINGS_FILE)
  for (const entry of snapshot) {
    if (!CONTROLLED_SETTINGS.includes(entry.key)) throw new Error('Unexpected E2E settings key.')
    if (entry.present) await store.set(entry.key, entry.value)
    else await store.delete(entry.key)
  }
  await store.save()
}

export async function matchesLocalModelE2eSettingsSnapshot(snapshot: LocalModelE2eSettingsSnapshot): Promise<boolean> {
  const store = await Store.load(SETTINGS_FILE)
  for (const entry of snapshot) {
    if (!CONTROLLED_SETTINGS.includes(entry.key)) return false
    const value = await store.get(entry.key)
    const present = value !== undefined
    if (present !== entry.present) return false
    if (entry.present && value !== entry.value) return false
  }
  return true
}
