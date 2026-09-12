import { shallowRef } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import type { TeamPresetChoice } from '@/services/agents/teamPolicy'

/**
 * Explicit per-chat route choice in the composer.
 * - `local`:    only the signed local model; no external route is offered.
 * - `auto`:     local first; an external model only after an explicit per-turn release.
 * - `external`: skip the local cold start and go to the external route, still only
 *               after the same explicit per-turn release.
 * `external` and `auto` require `externalEnabled`; otherwise the mode degrades to `local`.
 */
export type ChatRouteMode = 'local' | 'auto' | 'external'

export const CHAT_ROUTE_MODES: readonly ChatRouteMode[] = ['local', 'auto', 'external'] as const

export type ModelUsageSettings = {
  localModelId: string | null
  externalEnabled: boolean
  agentsByDefault: boolean
  teamPreset: TeamPresetChoice
  chatRouteMode: ChatRouteMode
}
const KEY = 'luczor.device.model-usage.v1'
export const DEFAULT_MODEL_USAGE: ModelUsageSettings = {
  localModelId: null,
  externalEnabled: false,
  agentsByDefault: false,
  teamPreset: 'local',
  chatRouteMode: 'local',
}
export function parseModelUsage(value: unknown): ModelUsageSettings {
  const item = (value ?? {}) as Partial<ModelUsageSettings>
  return {
    localModelId:
      typeof item.localModelId === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(item.localModelId)
        ? item.localModelId
        : null,
    externalEnabled: item.externalEnabled === true,
    agentsByDefault: item.agentsByDefault === true,
    teamPreset: ['server', 'local', 'free', 'budget'].includes(item.teamPreset ?? '') ? item.teamPreset! : 'local',
    // A stored external choice must never survive switching external models off.
    chatRouteMode:
      item.externalEnabled === true && CHAT_ROUTE_MODES.includes(item.chatRouteMode as ChatRouteMode)
        ? (item.chatRouteMode as ChatRouteMode)
        : 'local',
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
