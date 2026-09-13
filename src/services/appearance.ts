// src/services/appearance.ts
//
// Client-side personalization: accent theme, HUD position,
// reduced motion, background grid and the assistant's display name.
// Applied by writing CSS custom properties / data-attributes on <html>.

import { reactive } from 'vue'
import { Store } from '@tauri-apps/plugin-store'

const FILE = 'luczor.settings.json'

export type AccentName = 'cyan' | 'emerald' | 'violet' | 'amber' | 'rose'
export type HudPosition = 'br' | 'bl' | 'tr' | 'tl'
export type ThemeName = 'dark' | 'light' | 'system'

type Accent = { base: [number, number, number]; bright: string; soft: string; deep: string }

// Desaturated accents for the Liquid-Glass surfaces: `bright` is the text/ring tone,
// `base` the fill; `light` overrides keep contrast on the light theme.
const ACCENTS: Record<AccentName, Accent> = {
  cyan: { base: [79, 134, 171], bright: '#7aa7c7', soft: '#a9c8de', deep: '#2f5f80' },
  emerald: { base: [95, 179, 161], bright: '#6cb98a', soft: '#8fd3c4', deep: '#2f7d5f' },
  violet: { base: [143, 123, 216], bright: '#b3a3ec', soft: '#c9bdf4', deep: '#5a47ad' },
  amber: { base: [212, 160, 84], bright: '#ecc27a', soft: '#f3d9a6', deep: '#8f6528' },
  rose: { base: [224, 123, 138], bright: '#f2a3ae', soft: '#f7c6cd', deep: '#a3475a' },
}

const ACCENTS_LIGHT: Record<AccentName, Pick<Accent, 'bright' | 'deep'>> = {
  cyan: { bright: '#2f5f80', deep: '#1f4660' },
  emerald: { bright: '#2f7d5f', deep: '#1f5a44' },
  violet: { bright: '#6f5bc4', deep: '#5a47ad' },
  amber: { bright: '#8f6528', deep: '#6d4b1c' },
  rose: { bright: '#a3475a', deep: '#7f3546' },
}

export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[]
export const THEME_NAMES: ThemeName[] = ['dark', 'light', 'system']

export function appearanceAccentColor(): string {
  return ACCENTS[appearance.accent].bright
}

export const appearance = reactive({
  accent: 'violet' as AccentName,
  theme: 'dark' as ThemeName,
  hudVisible: true,
  hudPosition: 'br' as HudPosition,
  reduceMotion: false,
  showGrid: true,
  uiScale: 1.0,
  assistantName: 'Luczor',
})

function rgba(rgb: [number, number, number], a: number) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
}
function rgbHex(rgb: [number, number, number]) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

function resolveTheme(theme: ThemeName): 'dark' | 'light' {
  if (theme === 'system') {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
  }
  return theme
}

function applyAccent(name: AccentName, light: boolean) {
  const a = ACCENTS[name] ?? ACCENTS.violet
  const l = ACCENTS_LIGHT[name] ?? ACCENTS_LIGHT.violet
  const r = document.documentElement.style
  r.setProperty('--cy', rgbHex(a.base))
  r.setProperty('--cy-bright', light ? l.bright : a.bright)
  r.setProperty('--cy-soft', a.soft)
  r.setProperty('--cy-deep', light ? l.deep : a.deep)
  r.setProperty('--cy-04', rgba(a.base, 0.04))
  r.setProperty('--cy-08', rgba(a.base, 0.08))
  r.setProperty('--cy-12', rgba(a.base, 0.12))
  r.setProperty('--cy-16', rgba(a.base, 0.16))
  r.setProperty('--cy-22', rgba(a.base, 0.22))
  r.setProperty('--border-soft', rgba(a.base, 0.14))
  r.setProperty('--border', rgba(a.base, 0.26))
  r.setProperty('--border-strong', rgba(a.base, 0.42))
  r.setProperty('--glass-wash', rgba(a.base, 0.06))
  // Liquid Glass: no neon halos – accent light only as a soft, wide diffusion.
  r.setProperty('--glow-xs', `0 0 0 1px ${rgba(a.base, 0.22)}`)
  r.setProperty('--glow-sm', `0 8px 20px -12px ${rgba(a.base, 0.45)}`)
  r.setProperty('--glow-md', `0 14px 34px -16px ${rgba(a.base, 0.5)}`)
  r.setProperty('--glow-lg', `0 30px 70px -30px ${rgba(a.base, 0.55)}`)
  r.setProperty('--glow-text', 'none')
  r.setProperty('--focus-ring', `0 0 0 1px ${rgba(a.base, 0.7)}, 0 0 0 4px ${rgba(a.base, 0.16)}`)
}

let systemThemeMedia: MediaQueryList | null = null

function applyTheme() {
  const root = document.documentElement
  const resolved = resolveTheme(appearance.theme)
  root.dataset.theme = resolved
  root.dataset.themeMode = appearance.theme
  root.style.colorScheme = resolved
  // Follow the OS while "system" is selected; drop the listener otherwise.
  if (typeof window !== 'undefined' && window.matchMedia) {
    if (!systemThemeMedia) {
      systemThemeMedia = window.matchMedia('(prefers-color-scheme: light)')
      systemThemeMedia.addEventListener?.('change', () => {
        if (appearance.theme === 'system') applyAppearance()
      })
    }
  }
  return resolved
}

export function applyAppearance() {
  const resolved = applyTheme()
  applyAccent(appearance.accent, resolved === 'light')
  const root = document.documentElement
  root.dataset.reduceMotion = appearance.reduceMotion ? '1' : '0'
  root.dataset.grid = appearance.showGrid ? '1' : '0'
  // Chromium (WebView2) supports `zoom` to scale the whole UI.
  ;(root.style as any).zoom = String(appearance.uiScale || 1)
}

export function isThemeName(value: unknown): value is ThemeName {
  return value === 'dark' || value === 'light' || value === 'system'
}

/** Persist the theme for this device and apply it immediately. */
export async function setTheme(theme: ThemeName): Promise<void> {
  appearance.theme = theme
  applyAppearance()
  try {
    const s = await Store.load(FILE)
    await s.set('ui_theme', theme)
    await s.save()
  } catch {
    /* ignore – the choice still applies for this session */
  }
}

/** Cycle dark → light → dark for the header quick toggle (keeps "system" resolvable). */
export async function toggleTheme(): Promise<void> {
  const resolved = resolveTheme(appearance.theme)
  await setTheme(resolved === 'dark' ? 'light' : 'dark')
}

export async function loadAppearance(): Promise<void> {
  try {
    const s = await Store.load(FILE)
    const acc = await s.get<string>('ui_accent')
    if (acc && (ACCENT_NAMES as string[]).includes(acc)) appearance.accent = acc as AccentName
    const theme = await s.get<string>('ui_theme')
    if (isThemeName(theme)) appearance.theme = theme
    appearance.hudVisible = true
    const hp = await s.get<string>('ui_hud_position')
    if (hp === 'br' || hp === 'bl' || hp === 'tr' || hp === 'tl') appearance.hudPosition = hp
    const rm = await s.get<boolean>('ui_reduce_motion')
    if (typeof rm === 'boolean') appearance.reduceMotion = rm
    const sg = await s.get<boolean>('ui_show_grid')
    if (typeof sg === 'boolean') appearance.showGrid = sg
    const sc = await s.get<number>('ui_scale')
    if (typeof sc === 'number' && !Number.isNaN(sc)) appearance.uiScale = Math.max(0.8, Math.min(1.4, sc))
    const an = await s.get<string>('assistant_name')
    if (an && an.trim()) appearance.assistantName = an.trim()
  } catch {
    /* ignore */
  }
  applyAppearance()
}
