import type { MemoryRecord } from './luczorMemory'

export type MemorySyncIdentity = {
  expectedPrincipalId: string
  serverInstance: string
  scope: 'user' | 'project'
  projectId?: string
}
export type MemoryServerCapabilities = {
  memory_metadata_versions?: number[]
  memory_metadata_cas?: boolean
  memory_metadata_scopes?: string[]
  memory_change_feed?: number
  memory_change_scopes?: string[]
  memory_deletion_receipts?: number
  memory_conflicts?: number
}
export type MemoryDeletionReceipt = {
  id: string
  status: 'canonical_erased' | 'projection_pending' | 'complete' | 'blocked'
  canonical_erased: boolean
  projection_outbox_ids?: string[]
}
export type MemoryChangePage = {
  version: 1
  cursor: string
  has_more: boolean
  reset: boolean
  changes: Array<{
    sequence: number
    operation: 'upsert' | 'delete'
    record_id: string
    source_record_id: string
    memory?: Record<string, unknown>
  }>
}
export type MemoryMetadataConflict = {
  recordId: string
  kind: 'remote_update' | 'remote_delete'
  local: MemoryRecord
  remote?: MemoryRecord
  serverVersionId?: number
  at: number
}
export type MemorySyncState = {
  identity: MemorySyncIdentity
  cursor: string | null
  sequence: number
  capabilities: MemoryServerCapabilities | null
  lastError: string | null
  deletionReceipts: MemoryDeletionReceipt[]
  metadataConflicts: MemoryMetadataConflict[]
  updatedAt: number
}
export const memorySyncIdentityKey = (identity: MemorySyncIdentity) =>
  JSON.stringify([identity.expectedPrincipalId, identity.serverInstance, identity.scope, identity.projectId ?? null])
export const emptyMemorySyncState = (identity: MemorySyncIdentity): MemorySyncState => ({
  identity: {
    expectedPrincipalId: identity.expectedPrincipalId,
    serverInstance: identity.serverInstance,
    scope: identity.scope,
    projectId: identity.projectId,
  },
  cursor: null,
  sequence: 0,
  capabilities: null,
  lastError: null,
  deletionReceipts: [],
  metadataConflicts: [],
  updatedAt: 0,
})
