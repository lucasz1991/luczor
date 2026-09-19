import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { inspectRepositoryGraph } from '@/services/repositoryGraph'
import type { MemoryClassification } from '@/services/memory/memoryMetadata'

/** Explicit boundary allows the UI lab to supply synthetic records without a device or account. */
export const memoryExplorerData = {
  account: getVerifiedAccountSnapshot as () => Promise<{ principalId: string } | null>,
  inventory: luczorMemory.inspectLocal.bind(luczorMemory),
  graph: inspectRepositoryGraph,
  recall: luczorMemory.recall.bind(luczorMemory),
  updateMetadata: (id: string, patch: MemoryClassification, expectedRevision: string) =>
    luczorMemory.updateMetadata(id, patch, expectedRevision),
  artifacts: async (principalId: string, projectId: string) =>
    (await luczorMemory.maintenanceSnapshot(principalId)).journal.artifacts
      .filter(artifact => !artifact.projectId || artifact.projectId === projectId)
      .slice(-80),
}
