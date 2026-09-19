import { luczorMemory, containsSensitiveMemoryData } from './luczorMemory'
import { maintenanceHash, partitionMaintenanceSources, type MemoryChangeSet } from './maintenance'
import type { HydratedMaintenanceJob } from './maintenancePlanner'

export type MemoryMaintenanceAdapter = {
  id: string
  capabilities: { scoped: boolean; revisioned: boolean; atomicWrite: boolean }
  jobs(
    principalId: string,
    projectId: string | undefined,
    signal: AbortSignal,
    budget?: { maxBatchChars: number; maxSourceCount: number }
  ): Promise<HydratedMaintenanceJob[]>
  apply?(
    principalId: string,
    job: HydratedMaintenanceJob,
    changes: MemoryChangeSet,
    modelId: string,
    signal: AbortSignal
  ): Promise<{ changed: number; retired?: Array<{ external_id: string; version_id: number }> }>
}
type SharedSource = {
  id: string
  revision: string
  content: string
  source: string
  scope: string
  project_id?: string
  confidence: number
  valid_from?: string
  valid_until?: string
  metadata_needed?: boolean
  rewrite_eligible?: boolean
  metadata?: Record<string, unknown>
  tags?: string[]
  importance?: number
  provenance?: Record<string, unknown>
}
export const sqlMemoryMaintenanceAdapter: MemoryMaintenanceAdapter = {
  id: 'luczor-sql',
  capabilities: { scoped: true, revisioned: true, atomicWrite: true },
  async jobs(principalId, projectId, signal, budget) {
    const jobs: HydratedMaintenanceJob[] = []
    let after = 0
    do {
      signal.throwIfAborted()
      const page = await luczorMemory.sharedMaintenance<{ next: number | null; records: SharedSource[] }>(
        principalId,
        projectId ? 'project' : 'user',
        projectId,
        'sources',
        { after },
        signal
      )
      if (!page || !Array.isArray(page.records)) throw new Error('invalid_adapter_response')
      const safeRecords = page.records.filter(
        record =>
          /^\d+$/u.test(record.id) && /^[a-f0-9]{64}$/u.test(record.revision) && !containsSensitiveMemoryData(record)
      )
      const sources = safeRecords.map(record => ({
        id: record.id,
        kind: 'shared' as const,
        revision: record.revision,
        content: JSON.stringify(record),
      }))
      const maxChars = budget?.maxBatchChars ?? 15_000
      for (const record of safeRecords.filter(record => record.metadata_needed === true)) {
        const material = sources.filter(source => source.id === record.id)
        const oversized = JSON.stringify(material).length > maxChars
        jobs.push({
          id: `sql:${projectId ?? 'user'}:metadata:${record.id}`,
          projectId,
          kind: 'metadata',
          material,
          sources: material.map(({ content: _content, ...ref }) => ref),
          revision: await maintenanceHash(material.map(({ content: _content, ...ref }) => ref)),
          status: oversized ? 'blocked' : 'pending',
          blockedReason: oversized ? 'source_too_large' : undefined,
          attempts: 0,
          nextAttemptAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
      const writableSources = sources.filter(
        source => safeRecords.find(record => record.id === source.id)?.rewrite_eligible !== false
      )
      for (const material of partitionMaintenanceSources(writableSources, budget?.maxSourceCount ?? 4, maxChars)) {
        const oversized = JSON.stringify(material).length > maxChars
        const revision = await maintenanceHash(material.map(({ content: _content, ...ref }) => ref))
        jobs.push({
          id: `sql:${projectId ?? 'user'}:${material[0]!.id}`,
          projectId,
          kind: 'memory',
          material,
          sources: material.map(({ content: _content, ...ref }) => ref),
          revision,
          status: oversized ? 'blocked' : 'pending',
          blockedReason: oversized ? 'source_too_large' : undefined,
          attempts: 0,
          nextAttemptAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
      if (page.next === null) break
      if (!Number.isSafeInteger(page.next) || page.next <= after) throw new Error('invalid_adapter_cursor')
      after = page.next
    } while (jobs.length < 5000)
    return jobs
  },
  async apply(principalId, job, changes, modelId, signal) {
    return luczorMemory.sharedMaintenance(
      principalId,
      job.projectId ? 'project' : 'user',
      job.projectId,
      'apply',
      {
        request_id: await maintenanceHash([principalId, job.id, job.revision]),
        model_id: modelId,
        sources: job.sources.map(source => ({ id: source.id, revision: source.revision })),
        operations: changes.operations,
      },
      signal
    )
  },
}

/** Discovery never grants write authority. Unknown tool memories remain read-only unless explicitly registered. */
export const memoryMaintenanceAdapters: ReadonlyArray<MemoryMaintenanceAdapter> = [sqlMemoryMaintenanceAdapter]
export function writableMaintenanceAdapter(adapter: MemoryMaintenanceAdapter): boolean {
  return (
    adapter.capabilities.scoped &&
    adapter.capabilities.revisioned &&
    adapter.capabilities.atomicWrite &&
    typeof adapter.apply === 'function'
  )
}
