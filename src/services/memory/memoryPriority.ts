export const MEMORY_PRIORITIES = {
  background: { label: 'Hintergrund', importance: 0.2 },
  normal: { label: 'Normal', importance: 0.5 },
  high: { label: 'Wichtig', importance: 0.8 },
  critical: { label: 'Kritisch', importance: 1 },
} as const

export type MemoryPriority = keyof typeof MEMORY_PRIORITIES

export function memoryPriority(importance: number): MemoryPriority {
  if (importance >= 0.95) return 'critical'
  if (importance >= 0.7) return 'high'
  if (importance >= 0.35) return 'normal'
  return 'background'
}

export function memoryImportance(priority: MemoryPriority | undefined, fallback: number): number {
  if (priority !== undefined) {
    const entry = Object.entries(MEMORY_PRIORITIES).find(([key]) => key === priority)
    if (!entry) throw new Error('Unknown memory priority.')
    return entry[1].importance
  }
  return Number.isFinite(fallback) ? Math.max(0, Math.min(1, fallback)) : 0.5
}
