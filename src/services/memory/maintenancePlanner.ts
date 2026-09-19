import type { Message, Project } from '@/state/types'
import type { MemoryRecord } from './luczorMemory'
import { canAccessCloudProject } from '@/services/cloudProjectAccess'
import {
  MAINTENANCE_BATCH_CHARS,
  maintenanceEligible,
  maintenanceHash,
  memoryRevision,
  partitionMaintenanceSources,
  type MaintenanceJob,
  type MaintenanceSource,
} from './maintenance'

export type HydratedMaintenanceJob = MaintenanceJob & { material: MaintenanceSource[] }
export const memoryMaintenanceSource = (record: MemoryRecord): MaintenanceSource => ({
  id: record.id,
  kind: 'memory',
  revision: memoryRevision(record),
  content: JSON.stringify({
    text: record.content,
    source: record.source,
    intent: record.writeIntent,
    scope: record.scope,
    status: record.status,
    at: record.updatedAt,
    expiresAt: record.expiresAt,
  }),
})
export async function planMaintenance(input: {
  principalId: string
  projects: Project[]
  records: MemoryRecord[]
  messages?: Message[]
  now: number
  /** Material size per job; defaults to the generic cap, the worker fits it to the model context. */
  maxBatchChars?: number
  maxSourceCount?: number
}): Promise<HydratedMaintenanceJob[]> {
  const maxBatchChars = input.maxBatchChars ?? MAINTENANCE_BATCH_CHARS
  const projects = input.projects.filter(
    project => !project.archivedAt && canAccessCloudProject(project, input.principalId)
  )
  const work: HydratedMaintenanceJob[] = []
  const append = async (
    id: string,
    kind: MaintenanceJob['kind'],
    projectId: string | undefined,
    material: MaintenanceSource[]
  ) => {
    if (!material.length) return
    const oversized = JSON.stringify(material).length > maxBatchChars
    work.push({
      id,
      kind,
      projectId,
      material,
      sources: material.map(({ content: _content, ...ref }) => ref),
      revision: await maintenanceHash(material.map(({ content: _content, ...ref }) => ref)),
      status: oversized ? 'blocked' : 'pending',
      blockedReason: oversized ? 'source_too_large' : undefined,
      attempts: 0,
      nextAttemptAt: input.now,
      updatedAt: input.now,
    })
  }
  const scopes = [undefined, ...projects] as Array<Project | undefined>
  for (const project of scopes) {
    const records = input.records
      .filter(
        record =>
          record.principalId === input.principalId &&
          maintenanceEligible(record, input.now, true) &&
          (project ? record.projectId === (project.cloud?.externalId ?? project.id) : !record.projectId)
      )
      .sort((left, right) => left.id.localeCompare(right.id))
    const partitionKey = (record: MemoryRecord) =>
      JSON.stringify([record.dataset, record.visibility, !!record.synced, record.tags.includes('maintenance-derived')])
    const partitions = [...new Set(records.map(partitionKey))]
    for (const partitionId of partitions) {
      const partition = records.filter(record => partitionKey(record) === partitionId)
      const dataset = partition[0]!.dataset
      const sources = partition.map(memoryMaintenanceSource)
      for (const material of partitionMaintenanceSources(sources, input.maxSourceCount ?? 6, maxBatchChars)) {
        const batch = partition.filter(record => material.some(source => source.id === record.id))
        if (
          batch.every(
            record =>
              !record.tags.includes('maintenance-derived') &&
              record.visibility === 'private' &&
              !record.serverId &&
              !record.serverVersionId &&
              !record.synced
          )
        )
          await append(`memory:${project?.id ?? 'user'}:${dataset}:${material[0]!.id}`, 'memory', project?.id, material)
        await append(`context:${project?.id ?? 'user'}:${dataset}:${material[0]!.id}`, 'context', project?.id, material)
      }
    }
    if (!project) continue
    const content = JSON.stringify({
      name: project.name,
      goal: project.goal,
      summary: project.summary,
      goals: project.goals,
    })
    await append(`project:${project.id}`, 'context', project.id, [
      { id: `project:${project.id}`, kind: 'project', content, revision: await maintenanceHash(content) },
    ])
    // A loading/unfinished turn cuts off this conversation. Hidden/tool/raw reasoning never enters a summary.
    const conversations = new Map<string, Message[]>()
    for (const message of input.messages ?? []) {
      if (message.projectId !== project.id) continue
      const id = message.conversationId ?? project.id
      conversations.set(id, [...(conversations.get(id) ?? []), message])
    }
    for (const [conversation, messages] of conversations) {
      const visible = messages
        .sort((left, right) => left.ts - right.ts)
        .filter(
          message =>
            message.visibility === 'visible' && message.role !== 'tool' && message.meta.dataHandling !== 'ephemeral'
        )
      const loading = visible.findIndex(message => message.meta.isLoading)
      const completed = loading < 0 ? visible : visible.slice(0, loading)
      while (completed.length && completed.at(-1)?.role !== 'assistant') completed.pop()
      for (let index = 0; index < completed.length;) {
        let end = Math.min(index + (input.maxSourceCount ?? 4), completed.length)
        while (end < completed.length && completed[end - 1]?.role !== 'assistant') end++
        const material: MaintenanceSource[] = []
        for (const message of completed.slice(index, end)) {
          const content = JSON.stringify({
            role: message.role,
            text: message.content,
            feedback: message.meta.userFeedback,
            at: message.ts,
          })
          material.push({ id: message.id, kind: 'chat', content, revision: await maintenanceHash(content) })
        }
        await append(`chat:${conversation}:${completed.at(index)!.id}`, 'context', project.id, material)
        index = end
      }
    }
  }
  return work
}
