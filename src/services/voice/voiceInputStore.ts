import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Store } from '@tauri-apps/plugin-store'

export const isMiniVoice = () => isTauri() && getCurrentWindow().label === 'luczor-mini'

/** Mini receives only voice preferences, never the general settings/device credentials. */
export async function voiceInputStore(file: 'luczor.settings.json' | 'luczor.audio-triggers.json') {
  if (!isMiniVoice()) return Store.load(file)
  const resource = file === 'luczor.settings.json' ? 'settings' : 'audio'
  const values = await invoke<Record<string, unknown>>('voice_input_store', { resource })
  const changes = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | undefined> {
      if (changes.has(key)) return changes.get(key) as T | undefined
      return Object.entries(values).find(([name]) => name === key)?.[1] as T | undefined
    },
    async set(key: string, value: unknown) {
      changes.set(key, value)
    },
    async save() {
      await invoke('voice_input_store', { resource, values: Object.fromEntries(changes) })
    },
  }
}
