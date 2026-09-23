import { getVerifiedAccountSnapshot, type VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { executionGate } from '@/services/executionGate'
import { state } from '@/state/store'
import { luczorMemory, memoryUseServer } from './luczorMemory'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import { getMemoryServerCapabilities, memoryServerRequest } from './memoryServerCapabilities'
import type {
  MemoryChangePage,
  MemoryDeletionReceipt,
  MemoryServerCapabilities,
  MemorySyncIdentity,
  MemorySyncState,
} from './memorySyncState'

export type MemorySyncResult = {
  uploaded: number
  received: number
  pages: number
  pending: number
  hasMore: boolean
  supported: boolean
  errors: string[]
}
type SyncOptions = { force?: boolean; signal?: AbortSignal; maxPagesPerScope?: number }
type Dependencies = {
  enabled(): Promise<boolean>
  account(): Promise<VerifiedAccountSnapshot | null>
  projects(principalId: string): string[]
  pending(): Promise<number>
  flush(options?: { force?: boolean }): Promise<number>
  capabilities(
    snapshot: VerifiedAccountSnapshot,
    options: { signal?: AbortSignal; force?: boolean }
  ): Promise<MemoryServerCapabilities>
  request<T>(
    snapshot: VerifiedAccountSnapshot,
    path: '/memory/changes' | '/memory/deletion-receipt',
    body: unknown,
    signal?: AbortSignal
  ): Promise<T>
  read(identity: MemorySyncIdentity): Promise<MemorySyncState>
  apply(
    input: MemorySyncIdentity & {
      page: MemoryChangePage
      expectedCursor: string | null
      capabilities: MemoryServerCapabilities
    }
  ): Promise<unknown>
  update(
    input: MemorySyncIdentity & {
      capabilities?: MemoryServerCapabilities
      lastError?: string | null
      deletionReceipt?: MemoryDeletionReceipt
    }
  ): Promise<unknown>
}

export function createMemorySyncCoordinator(dependencies: Dependencies) {
  let running: Promise<MemorySyncResult> | undefined
  let nextAttempt = 0
  let failures = 0
  let scopeOffset = 0
  let lastIdentity = ''
  const run = async (options: SyncOptions): Promise<MemorySyncResult> => {
    const result: MemorySyncResult = {
      uploaded: 0,
      received: 0,
      pages: 0,
      pending: 0,
      hasMore: false,
      supported: false,
      errors: [],
    }
    if (!(await dependencies.enabled())) return result
    const snapshot = await dependencies.account()
    if (!snapshot) return result
    const identityKey = JSON.stringify([snapshot.principalId, snapshot.serverInstance])
    if (lastIdentity !== identityKey) {
      lastIdentity = identityKey
      nextAttempt = 0
      failures = 0
      scopeOffset = 0
    }
    if (!options.force && Date.now() < nextAttempt) return result
    const assertCurrent = async () => {
      options.signal?.throwIfAborted()
      if (!(await dependencies.enabled())) throw new Error('memory_server_disabled')
      const current = await dependencies.account()
      if (
        current?.principalId !== snapshot.principalId ||
        current.serverInstance !== snapshot.serverInstance ||
        current.config.deviceKey !== snapshot.config.deviceKey
      )
        throw new Error('memory_sync_identity_changed')
    }
    try {
      await assertCurrent()
      result.uploaded = await dependencies.flush({ force: options.force })
      await assertCurrent()
      result.pending = await dependencies.pending()
      const capabilities = await dependencies.capabilities(snapshot, { signal: options.signal })
      await assertCurrent()
      result.supported = capabilities.memory_change_feed === 1
      if (!result.supported) return result
      const scopes: MemorySyncIdentity[] = [
        { expectedPrincipalId: snapshot.principalId, serverInstance: snapshot.serverInstance, scope: 'user' as const },
        ...dependencies.projects(snapshot.principalId).map(projectId => ({
          expectedPrincipalId: snapshot.principalId,
          serverInstance: snapshot.serverInstance,
          scope: 'project' as const,
          projectId,
        })),
      ].filter(identity => capabilities.memory_change_scopes?.includes(identity.scope))
      // Rotate bounded background batches so a large first project never starves later ones.
      const rotated = [
        ...scopes.slice(scopeOffset % Math.max(1, scopes.length)),
        ...scopes.slice(0, scopeOffset % Math.max(1, scopes.length)),
      ]
      const selected = options.force ? rotated : rotated.slice(0, 4)
      scopeOffset += selected.length
      for (const identity of selected) {
        try {
          let sync = await dependencies.read(identity)
          await dependencies.update({ ...identity, capabilities })
          for (let i = 0; i < Math.min(100, Math.max(1, options.maxPagesPerScope ?? (options.force ? 20 : 2))); i++) {
            await assertCurrent()
            const page = await dependencies.request<MemoryChangePage>(
              snapshot,
              '/memory/changes',
              {
                scope: identity.scope,
                project_id: identity.projectId,
                cursor: sync.cursor ?? undefined,
                limit: 100,
              },
              options.signal
            )
            await assertCurrent()
            if (
              page.version !== 1 ||
              typeof page.cursor !== 'string' ||
              !Array.isArray(page.changes) ||
              typeof page.has_more !== 'boolean' ||
              typeof page.reset !== 'boolean' ||
              (page.reset && sync.cursor !== null) ||
              (page.has_more && page.cursor === sync.cursor)
            )
              throw new Error('invalid_memory_change_page')
            await dependencies.apply({ ...identity, page, expectedCursor: sync.cursor, capabilities })
            result.received += page.changes.length
            result.pages++
            sync = await dependencies.read(identity)
            if (!page.has_more) break
            if (i === Math.min(100, Math.max(1, options.maxPagesPerScope ?? (options.force ? 20 : 2))) - 1)
              result.hasMore = true
          }
          if (capabilities.memory_deletion_receipts === 1) {
            for (const receipt of sync.deletionReceipts.filter(item => item.status !== 'complete').slice(0, 8)) {
              await assertCurrent()
              const response = await dependencies.request<{ data: MemoryDeletionReceipt }>(
                snapshot,
                '/memory/deletion-receipt',
                { receipt_id: receipt.id },
                options.signal
              )
              await assertCurrent()
              if (
                response.data?.id !== receipt.id ||
                !['canonical_erased', 'projection_pending', 'complete', 'blocked'].includes(response.data.status)
              )
                throw new Error('invalid_memory_deletion_receipt')
              await dependencies.update({ ...identity, deletionReceipt: response.data })
            }
          }
          await dependencies.update({ ...identity, lastError: null })
        } catch (error) {
          await assertCurrent()
          const message = error instanceof Error ? error.message : 'memory_sync_failed'
          result.errors.push(message)
          await dependencies.update({ ...identity, lastError: message })
        }
      }
      result.hasMore ||= selected.length < scopes.length
      failures = result.errors.length ? failures + 1 : 0
      nextAttempt = result.errors.length ? Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(failures, 6)) : 0
      return result
    } catch (error) {
      failures++
      nextAttempt = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(failures, 6))
      throw error
    }
  }
  return {
    async synchronize(options: SyncOptions = {}): Promise<MemorySyncResult> {
      if (running) {
        if (!options.force) return running
      }
      const operation = running ? running.catch(() => undefined).then(() => run(options)) : run(options)
      running = operation
      try {
        return await operation
      } finally {
        if (running === operation) running = undefined
      }
    },
  }
}

export const memorySyncCoordinator = createMemorySyncCoordinator({
  enabled: memoryUseServer,
  account: getVerifiedAccountSnapshot,
  projects: principalId =>
    state.projects
      .filter(
        project =>
          project.kind !== 'standalone-chat' &&
          !project.archivedAt &&
          (!project.cloud || project.cloud.principalId === principalId)
      )
      .map(project => projectExternalIdForServer(project.id, principalId)!),
  pending: () => luczorMemory.pendingSyncCount(),
  flush: options => luczorMemory.flushPendingSync(options),
  capabilities: getMemoryServerCapabilities,
  request: memoryServerRequest,
  read: identity => luczorMemory.syncState(identity),
  apply: input => luczorMemory.applyChangeBatch(input),
  update: input => luczorMemory.updateSyncState(input),
})

/** Heartbeat is best-effort; manual synchronization propagates its explicit result. */
export async function refreshMemorySynchronization(): Promise<void> {
  try {
    await memorySyncCoordinator.synchronize({ signal: executionGate.capture().signal })
  } catch {
    /* Offline/identity changes leave cursor and immutable writes intact. */
  }
}
