import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory, memoryUseServer } from '@/services/memory/luczorMemory'
import { syncNow } from '@/services/status'

/** Explicit adapter also lets browser acceptance use synthetic, isolated state. */
export const memorySyncPanelData = {
  account: getVerifiedAccountSnapshot,
  enabled: memoryUseServer,
  capture: luczorMemory.captureStatus.bind(luczorMemory),
  read: luczorMemory.syncState.bind(luczorMemory),
  resolve: luczorMemory.resolveSyncConflict.bind(luczorMemory),
  synchronize: syncNow,
}
