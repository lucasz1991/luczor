import { shallowRef } from 'vue'
import {
  isThinkingTier,
  resolveThinkingConfig,
  THINKING_TIERS,
  type ThinkingConfig,
  type ThinkingTier,
} from './thinking'

type Settings = Readonly<{ defaultTier: ThinkingTier; overrides: Partial<Record<ThinkingTier, ThinkingConfig>> }>
export type Overrides = Settings['overrides']
const KEY = 'luczor.device.thinking.v1'
const defaults = (): Settings => ({ defaultTier: 'balanced', overrides: {} })
/** `tier` is always a member of the closed THINKING_TIERS union — never an arbitrary property name. */
export function readOverride(overrides: Overrides, tier: ThinkingTier): ThinkingConfig | undefined {
  // eslint-disable-next-line security/detect-object-injection
  return overrides[tier]
}
export function writeOverride(overrides: Overrides, tier: ThinkingTier, config: ThinkingConfig) {
  // eslint-disable-next-line security/detect-object-injection
  overrides[tier] = config
}
export function deleteOverride(overrides: Overrides, tier: ThinkingTier) {
  // eslint-disable-next-line security/detect-object-injection
  delete overrides[tier]
}
function load(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!value || !isThinkingTier(value.defaultTier)) return defaults()
    const overrides: Overrides = {}
    for (const tier of THINKING_TIERS) {
      const stored = readOverride(value.overrides ?? {}, tier)
      if (stored) writeOverride(overrides, tier, resolveThinkingConfig(tier, stored))
    }
    return { defaultTier: value.defaultTier, overrides }
  } catch {
    return defaults()
  }
}
/** Separate device storage: server defaults/project sync never write these values. */
export const thinkingSettings = shallowRef<Settings>(load())
export function saveThinkingSettings(defaultTier: ThinkingTier, overrides: Overrides) {
  if (!isThinkingTier(defaultTier)) throw new Error('Unbekannte Denkstufe.')
  const checked: Overrides = {}
  for (const tier of THINKING_TIERS) {
    const candidate = readOverride(overrides, tier)
    if (candidate) writeOverride(checked, tier, resolveThinkingConfig(tier, candidate))
  }
  const next = { defaultTier, overrides: checked }
  localStorage.setItem(KEY, JSON.stringify(next))
  thinkingSettings.value = next
}
export function captureThinking(tier: ThinkingTier) {
  return {
    thinkingTier: tier,
    thinkingConfig: resolveThinkingConfig(tier, readOverride(thinkingSettings.value.overrides, tier)),
  }
}
