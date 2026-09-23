import { flushProjectSyncQueue } from '@/services/api/projectSyncQueue'
import { pushAllToServer } from '@/services/api/sync'
import { executionGate } from '@/services/executionGate'
import { memorySyncCoordinator } from '@/services/memory/memorySyncCoordinator'

/** Process the same queues represented in the HUD, then the legacy chat archive. */
export async function synchronizeAll(options: { force?: boolean } = {}) {
  const ticket = executionGate.capture()
  const projects = await flushProjectSyncQueue({ force: options.force, signal: ticket.signal })
  executionGate.assert(ticket)
  const memory = await memorySyncCoordinator.synchronize({ force: options.force, signal: ticket.signal })
  executionGate.assert(ticket)
  const archive = await pushAllToServer()
  executionGate.assert(ticket)
  return {
    projects,
    memory,
    archive,
    total: memory.uploaded + memory.received + Object.values(archive.counts).reduce((sum, count) => sum + count, 0),
  }
}
