import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'

let disk: Promise<Store> | undefined
let platform: Promise<string> | undefined
export async function coordinationMetadata(account: VerifiedAccountSnapshot) {
  const store = await (disk ??= Store.load('luczor.device-coordination.json'))
  const rank = await store.get<number>(`${account.principalId}:${account.config.clientId}:rank`)
  const detected = await (platform ??= invoke<{ build: { platform: string } }>('wf_runtime_capabilities')
    .then(value => value.build.platform)
    .catch(() => 'unknown'))
  const active = await invoke<{ activeModelId?: string | null }>('local_model_status').catch(() => null)
  return {
    platform: ['windows', 'linux', 'macos'].includes(detected) ? detected : 'unknown',
    active_model_id: active?.activeModelId ?? null,
    ...(Number.isInteger(rank) && rank! >= 1 && rank! <= 5 ? { model_tier: rank } : {}),
  }
}
export async function setCoordinationRank(account: VerifiedAccountSnapshot, rank: number) {
  if (!Number.isInteger(rank) || rank < 0 || rank > 5)
    throw new Error('Bitte Automatisch oder eine Leistungsstufe von 1 bis 5 wählen.')
  const store = await (disk ??= Store.load('luczor.device-coordination.json'))
  const key = `${account.principalId}:${account.config.clientId}:rank`
  if (rank === 0) await store.delete(key)
  else await store.set(key, rank)
  await store.save()
}
