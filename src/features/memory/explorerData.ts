import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { inspectRepositoryGraph } from '@/services/repositoryGraph'

/** Explicit boundary allows the UI lab to supply synthetic records without a device or account. */
export const memoryExplorerData = {
  account: getVerifiedAccountSnapshot as () => Promise<{ principalId: string } | null>,
  inventory: luczorMemory.inspectLocal.bind(luczorMemory),
  graph: inspectRepositoryGraph,
  recall: luczorMemory.recall.bind(luczorMemory),
}
