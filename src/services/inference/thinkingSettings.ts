import { shallowRef } from 'vue'
import {
  isThinkingTier,
  resolveThinkingConfig,
  THINKING_TIERS,
  type ThinkingConfig,
  type ThinkingTier,
} from './thinking'

type Settings = Readonly<{ defaultTier: ThinkingTier; overrides: Partial<Record<ThinkingTier, ThinkingConfig>> }>
const KEY = 'luczor.device.thinking.v1'
const defaults = (): Settings => ({ defaultTier: 'balanced', overrides: {} })
function load(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!value || !isThinkingTier(value.defaultTier)) return defaults()
    const overrides: Settings['overrides'] = {}
    for (const tier of THINKING_TIERS)
      if (value.overrides?.[tier]) overrides[tier] = resolveThinkingConfig(tier, value.overrides[tier])
    return { defaultTier: value.defaultTier, overrides }
  } catch {
    return defaults()
  }
}
/** Separate device storage: server defaults/project sync never write these values. */
export const thinkingSettings = shallowRef<Settings>(load())
export function saveThinkingSettings(defaultTier: ThinkingTier, overrides: Settings['overrides']) {
  if (!isThinkingTier(defaultTier)) throw new Error('Unbekannte Denkstufe.')
  const checked: Settings['overrides'] = {}
  for (const tier of THINKING_TIERS) if (overrides[tier]) checked[tier] = resolveThinkingConfig(tier, overrides[tier])
  const next = { defaultTier, overrides: checked }
  localStorage.setItem(KEY, JSON.stringify(next))
  thinkingSettings.value = next
}
export function captureThinking(tier: ThinkingTier) {
  return { thinkingTier: tier, thinkingConfig: resolveThinkingConfig(tier, thinkingSettings.value.overrides[tier]) }
}
