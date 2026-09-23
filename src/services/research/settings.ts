import { Store } from '@tauri-apps/plugin-store'
import { isTauri } from '@tauri-apps/api/core'
const preview = new Map<string, string>()
export async function getResearchRoot(principalId: string): Promise<string | undefined> {
  if (!isTauri()) return preview.get(principalId)
  const store = await Store.load('luczor.research-settings.json')
  const value = await store.get<unknown>(`root:${principalId}`)
  return typeof value === 'string' && value.trim() ? value : undefined
}
export async function setResearchRoot(principalId: string, path: string): Promise<void> {
  if (!path.trim() || path.length > 4096 || /[\u0000-\u001f]/u.test(path))
    throw new Error('Ungültiger Rechercheordner.')
  if (!isTauri()) {
    preview.set(principalId, path)
    return
  }
  const store = await Store.load('luczor.research-settings.json')
  await store.set(`root:${principalId}`, path)
  await store.save()
}
