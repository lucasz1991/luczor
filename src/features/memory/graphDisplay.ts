import { shallowRef } from 'vue'
import { Store } from '@tauri-apps/plugin-store'

/** Device-local rendering preferences for the 3D knowledge space. Never affects what is stored. */
export type MemoryGraphDisplay = {
  labels: 'hubs' | 'selected' | 'all'
  edges: 'all' | 'stored' | 'none'
  depthFade: boolean
  dreamAnimation: boolean
  autoRotate: boolean
  nodeScale: number
  /** Show the slowly turning knowledge space blurred behind the whole app. */
  ambientBackdrop: boolean
}

export const MEMORY_GRAPH_DISPLAY_KEY = 'memory_graph_display'
const SETTINGS_FILE = 'luczor.settings.json'

export const DEFAULT_MEMORY_GRAPH_DISPLAY: MemoryGraphDisplay = {
  labels: 'hubs',
  edges: 'all',
  depthFade: true,
  dreamAnimation: true,
  autoRotate: false,
  nodeScale: 1,
  ambientBackdrop: true,
}

export const memoryGraphDisplay = shallowRef<MemoryGraphDisplay>({ ...DEFAULT_MEMORY_GRAPH_DISPLAY })

export function normalizeMemoryGraphDisplay(value: unknown): MemoryGraphDisplay {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof MemoryGraphDisplay, unknown>>
  const scale = typeof raw.nodeScale === 'number' && Number.isFinite(raw.nodeScale) ? raw.nodeScale : 1
  return {
    labels: raw.labels === 'selected' || raw.labels === 'all' ? raw.labels : 'hubs',
    edges: raw.edges === 'stored' || raw.edges === 'none' ? raw.edges : 'all',
    depthFade: raw.depthFade !== false,
    dreamAnimation: raw.dreamAnimation !== false,
    autoRotate: raw.autoRotate === true,
    nodeScale: Math.min(1.6, Math.max(0.6, scale)),
    ambientBackdrop: raw.ambientBackdrop !== false,
  }
}

export async function loadMemoryGraphDisplay(): Promise<MemoryGraphDisplay> {
  try {
    const store = await Store.load(SETTINGS_FILE)
    memoryGraphDisplay.value = normalizeMemoryGraphDisplay(await store.get<unknown>(MEMORY_GRAPH_DISPLAY_KEY))
  } catch {
    memoryGraphDisplay.value = { ...DEFAULT_MEMORY_GRAPH_DISPLAY }
  }
  return memoryGraphDisplay.value
}

export async function saveMemoryGraphDisplay(changes: Partial<MemoryGraphDisplay>): Promise<MemoryGraphDisplay> {
  const next = normalizeMemoryGraphDisplay({ ...memoryGraphDisplay.value, ...changes })
  memoryGraphDisplay.value = next
  try {
    const store = await Store.load(SETTINGS_FILE)
    await store.set(MEMORY_GRAPH_DISPLAY_KEY, next)
    await store.save()
  } catch {
    /* Browser preview has no store; the in-memory preference still applies for this session. */
  }
  return next
}
