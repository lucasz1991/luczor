import { shallowRef } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'

/** Per-device provider choice. The chat model chooses whether targeted assistance is useful.
 * Enabling external models authorizes automatic, identity-bound provider packets; disabling
 * them revokes new packets. Context tools are an independent opt-in. */
/**
 * `claude_local`: Claude leads, the local model takes over a turn the provider declined.
 * `claude`: Claude leads without an automatic hand-over.
 */
export type ChatRouteMode = 'local' | 'auto' | 'external' | 'claude_local' | 'claude'
export type ClaudeRouteMode = 'claude_local' | 'claude'

export const CHAT_ROUTE_MODES: readonly ChatRouteMode[] = [
  'local',
  'auto',
  'external',
  'claude_local',
  'claude',
] as const

export function isClaudeRouteMode(mode: unknown): mode is ClaudeRouteMode {
  return mode === 'claude_local' || mode === 'claude'
}

/** Device-side mirror of the server-held Claude access. The API key itself never lives here. */
export type ClaudeAccessSettings = {
  /** A server-verified Claude access exists for this account. */
  enabled: boolean
  /** Model picked last in a composer; the default for new chats. */
  lastModel: string | null
}

export type ModelUsageSettings = {
  localModelId: string | null
  externalEnabled: boolean
  externalToolsEnabled?: boolean
  chatRouteMode: ChatRouteMode
  claude: ClaudeAccessSettings
}
const KEY = 'luczor.device.model-usage.v1'
export const DEFAULT_MODEL_USAGE: ModelUsageSettings = {
  localModelId: null,
  externalEnabled: false,
  externalToolsEnabled: false,
  chatRouteMode: 'local',
  claude: { enabled: false, lastModel: null },
}
const MODEL_ID = /^[a-zA-Z0-9._-]{1,160}$/
function parseClaudeAccess(value: unknown): ClaudeAccessSettings {
  const item = (value && typeof value === 'object' ? value : {}) as Partial<ClaudeAccessSettings>
  return {
    enabled: item.enabled === true,
    lastModel: typeof item.lastModel === 'string' && MODEL_ID.test(item.lastModel) ? item.lastModel : null,
  }
}
export function parseModelUsage(value: unknown): ModelUsageSettings {
  const item = (value ?? {}) as Partial<ModelUsageSettings>
  const claude = parseClaudeAccess(item.claude)
  const requested = CHAT_ROUTE_MODES.includes(item.chatRouteMode as ChatRouteMode)
    ? (item.chatRouteMode as ChatRouteMode)
    : 'local'
  // A stored external or Claude choice must never survive switching its access off.
  const allowed = isClaudeRouteMode(requested) ? claude.enabled : requested === 'local' || item.externalEnabled === true
  return {
    localModelId: typeof item.localModelId === 'string' && MODEL_ID.test(item.localModelId) ? item.localModelId : null,
    externalEnabled: item.externalEnabled === true,
    externalToolsEnabled: item.externalEnabled === true && item.externalToolsEnabled === true,
    chatRouteMode: allowed ? requested : 'local',
    claude,
  }
}
function read(): ModelUsageSettings {
  try {
    return parseModelUsage(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return { ...DEFAULT_MODEL_USAGE }
  }
}
export const modelUsageSettings = shallowRef<ModelUsageSettings>(read())
let initialization: Promise<void> | undefined
let deviceStore: Store | undefined
export function initializeModelUsageSettings(): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  return (initialization ??= (async () => {
    deviceStore = await Store.load('luczor.model-usage.json', { autoSave: false, defaults: {} })
    const stored = await deviceStore.get<unknown>('settings')
    const value = stored == null ? read() : parseModelUsage(stored)
    if (stored == null) {
      await deviceStore.set('settings', value)
      await deviceStore.save()
    }
    modelUsageSettings.value = value
  })().catch(error => {
    initialization = undefined
    throw error
  }))
}
let pendingSave: Promise<void> = Promise.resolve()
export function saveModelUsageSettings(value: ModelUsageSettings): Promise<void> {
  const next = parseModelUsage(value)
  const operation = pendingSave
    .catch(() => {})
    .then(async () => {
      if (isTauri()) {
        await initializeModelUsageSettings()
        await deviceStore!.set('settings', next)
        await deviceStore!.save()
      } else {
        localStorage.setItem(KEY, JSON.stringify(next))
      }
      modelUsageSettings.value = next
    })
  pendingSave = operation
  return operation
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (!isTauri() && (event.key === KEY || event.key === null)) modelUsageSettings.value = read()
  })
}
