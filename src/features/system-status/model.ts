export type SystemStatusDisplayMode = 'mini' | 'tabs' | 'dashboard'
export type SystemStatusSection = 'resources' | 'localmodel' | 'memory' | 'network' | 'details'
export type SystemStatusIndicator = 'ok' | 'active' | 'warning' | 'unknown'
export type SystemStatusIndicators = Record<Exclude<SystemStatusSection, 'localmodel'>, SystemStatusIndicator>

export const systemStatusTabs: ReadonlyArray<{ id: SystemStatusSection; label: string }> = [
  { id: 'resources', label: 'Ressourcen' },
  { id: 'localmodel', label: 'LocalModel' },
  { id: 'memory', label: 'Gedächtnis' },
  { id: 'network', label: 'Netzwerk' },
  { id: 'details', label: 'Details' },
]

export const emptySystemStatusIndicators = (): SystemStatusIndicators => ({
  resources: 'unknown',
  memory: 'unknown',
  network: 'unknown',
  details: 'unknown',
})

export function localModelIndicator(latest?: { state: string; endedAt: number | null } | null): SystemStatusIndicator {
  if (!latest) return 'unknown'
  if (latest.state === 'error') return 'warning'
  return latest.endedAt === null ? 'active' : 'ok'
}

export function systemStatusLabel(status: SystemStatusIndicator): string {
  switch (status) {
    case 'ok':
      return 'Aktuell'
    case 'active':
      return 'Aktiv'
    case 'warning':
      return 'Hinweis'
    case 'unknown':
      return 'Status unbekannt'
  }
}

export function systemStatusIcon(status: SystemStatusIndicator): string {
  switch (status) {
    case 'ok':
      return 'm5 12 4 4L19 6'
    case 'active':
      return 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
    case 'warning':
      return 'M12 3 2 21h20ZM12 9v5m0 3v.1'
    case 'unknown':
      return 'M8 12h8M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
  }
}
