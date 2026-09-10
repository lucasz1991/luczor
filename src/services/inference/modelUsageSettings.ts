import { shallowRef } from 'vue'
import type { TeamPresetChoice } from '@/services/agents/teamPolicy'

export type ModelUsageSettings = {
  localModelId: string | null
  externalEnabled: boolean
  agentsByDefault: boolean
  teamPreset: TeamPresetChoice
}
const KEY = 'luczor.device.model-usage.v1'
export const DEFAULT_MODEL_USAGE: ModelUsageSettings = {
  localModelId: null,
  externalEnabled: false,
  agentsByDefault: false,
  teamPreset: 'local',
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
export function saveModelUsageSettings(value: ModelUsageSettings): void {
  const next = parseModelUsage(value)
  localStorage.setItem(KEY, JSON.stringify(next))
  modelUsageSettings.value = next
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === null) modelUsageSettings.value = read()
  })
}
