import { invoke } from '@tauri-apps/api/core'

export type DesktopControlConfig = {
  revision: number
  monitor: { id: number; name: string } | null
  inputMode: 'isolated' | 'shared'
  preferInternalBrowser: boolean
  showCursor: boolean
}
export type ControlMonitor = {
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  scale_factor: number
  primary: boolean
}
export type DesktopControlStatus = {
  config: DesktopControlConfig
  monitors: ControlMonitor[]
  selectedAvailable: boolean
  isolatedBackend: 'win32_window_messages' | 'at_spi' | 'internal_browser_only'
  internalBrowserIndependent: boolean
}
export const loadDesktopControl = () => invoke<DesktopControlStatus>('desktop_control_status')
export const saveDesktopControl = (payload: DesktopControlConfig) =>
  invoke<DesktopControlConfig>('desktop_control_save', { payload })
export const previewDesktopControl = () => invoke<void>('desktop_control_preview')

export function desktopControlError(error: unknown): string {
  const code = String(error)
  const messages: Record<string, string> = {
    desktop_control_config_changed: 'Die Einstellung wurde inzwischen geändert. Bitte neu laden.',
    desktop_control_monitor_required: 'Bitte zuerst einen Bildschirm wählen und speichern.',
    desktop_control_monitor_unavailable: 'Der gewählte Bildschirm ist nicht mehr verbunden. Bitte neu auswählen.',
    desktop_control_window_outside_selected_monitor:
      'Das Zielfenster muss vollständig auf dem gewählten Luczor-Bildschirm liegen.',
    desktop_control_wayland_overlay_unavailable_use_internal_browser:
      'Wayland erlaubt hier keine freie Platzierung der Bildschirmmarkierung. Bitte den internen Luczor-Browser verwenden.',
  }
  return messages[code] ?? `Bildschirmsteuerung nicht verfügbar: ${code}`
}
