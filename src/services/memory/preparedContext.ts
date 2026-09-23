import { state } from '@/state/store'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory } from './luczorMemory'
import { planMaintenance } from './maintenancePlanner'
import type { PromptFragment } from '@/services/prompt/promptContextAssembler'
import { inspectRepositoryGraph, readRepositorySnippets, repositoryGraphStatus } from '@/services/repositoryGraph'
import { maintenanceHash, type PreparedContextArtifact, type SourceReference } from './maintenance'
import type { MemoryUsageOrigin } from './usage'
import { memoryMetadataOf, memoryMetadataSearchText } from './memoryMetadata'
import { memoryCanPrepareProjectContext } from './memoryPolicy'
import { resolveWorkspacePrincipalId } from '@/services/projectWorkspace'

/** Optional fast orientation. Missing/stale artifacts never delay a chat for generation. */
export async function preparedContextFragments(
  projectId: string,
  query: string,
  origin: MemoryUsageOrigin = 'chat'
): Promise<PromptFragment[]> {
  const account = await getVerifiedAccountSnapshot()
  const principalId = account?.principalId ?? 'device-local'
  const repositoryPrincipal = account?.principalId ?? (await resolveWorkspacePrincipalId())
  const snapshot = await luczorMemory.maintenanceSnapshot(principalId)
  if (!snapshot.journal.artifacts.length) return []
  const projects = state.projects.filter(project => project.id === projectId && project.kind !== 'standalone-chat')
  if (!projects.length) return []
  const jobs = await planMaintenance({
    principalId,
    projects,
    records: snapshot.records,
    messages: state.messages,
    now: Date.now(),
  })
  // Generation adapts its batches to resident context/RAM. A different retrieval
  // batch must not invalidate unchanged evidence or hide later small-batch IDs.
  // Scope and each source revision remain mandatory, independently of packing.
  const sourceKey = (project: string | undefined, source: SourceReference) =>
    JSON.stringify([project ?? null, source.kind, source.id])
  const revisions = new Map(
    jobs
      .filter(job => job.kind === 'context')
      .flatMap(job => job.sources.map(source => [sourceKey(job.projectId, source), source.revision] as const))
  )
  const words = query
    .toLocaleLowerCase()
    .split(/\W+/u)
    .filter(word => word.length > 2)
  const score = (text: string) => words.filter(word => text.toLocaleLowerCase().includes(word)).length
  const sourceRecords = new Map(
    snapshot.records.filter(memoryCanPrepareProjectContext).map(record => [record.id, record])
  )
  const metadataSearch = (artifact: PreparedContextArtifact) =>
    artifact.sources
      .filter(source => source.kind === 'memory')
      .map(source => sourceRecords.get(source.id))
      .filter(record => record !== undefined)
      .map(record => memoryMetadataSearchText(record))
      .join(' ')
  const valid: PreparedContextArtifact[] = []
  for (const artifact of snapshot.journal.artifacts) {
    if (
      (artifact.projectId && artifact.projectId !== projectId) ||
      artifact.kind !== 'context' ||
      !artifact.sources.length ||
      artifact.sources.some(
        source =>
          revisions.get(sourceKey(artifact.projectId, source)) !== source.revision ||
          (source.kind === 'memory' && !sourceRecords.has(source.id))
      )
    )
      continue
    if ((await maintenanceHash(artifact.sources)) === artifact.revision) valid.push(artifact)
  }
  const repository = snapshot.journal.artifacts
    .filter(artifact => artifact.projectId === projectId && artifact.kind === 'repository')
    .sort((left, right) => score(right.content) - score(left.content))
    .slice(0, 2)
  for (const artifact of repository) {
    try {
      const repositorySources = artifact.sources.filter(source => source.kind === 'repository')
      const extraSources = artifact.sources.filter(source => source.kind !== 'repository')
      if (
        repositorySources.length !== 1 ||
        extraSources.some(
          source => source.kind !== 'memory' || revisions.get(sourceKey(artifact.projectId, source)) !== source.revision
        )
      )
        continue
      if (artifact.repositoryRevision && (await maintenanceHash(artifact.sources)) !== artifact.revision) continue
      if (!artifact.repositoryRevision && extraSources.length) continue
      const path = artifact.id.slice(`repository:${projectId}:`.length)
      const [status, page, evidence] = await Promise.all([
        repositoryGraphStatus(repositoryPrincipal, projectId),
        inspectRepositoryGraph(repositoryPrincipal, projectId, path),
        readRepositorySnippets(
          repositoryPrincipal,
          projectId,
          repositorySources.map(source => source.id),
          1000,
          origin
        ),
      ])
      const file = page.files.find(item => item.path === path)
      if (!file || !evidence.snippets.length || evidence.omitted.length || status.status !== 'ready') continue
      const revision = await maintenanceHash(
        JSON.stringify({
          repository: status.repository_id,
          ...file,
          evidence: 'LSP/index metadata; no full repository claim',
        })
      )
      if (
        revision === (artifact.repositoryRevision ?? artifact.revision) &&
        repositorySources[0]!.id === file.id &&
        repositorySources[0]!.revision === revision
      )
        valid.push(artifact)
    } catch {
      /* Current evidence unavailable: regular retrieval remains the fallback. */
    }
  }
  valid.sort(
    (left, right) =>
      score(`${right.content} ${metadataSearch(right)}`) - score(`${left.content} ${metadataSearch(left)}`) ||
      right.createdAt - left.createdAt
  )
  if (((await getVerifiedAccountSnapshot())?.principalId ?? 'device-local') !== principalId) return []
  return valid.slice(0, 3).map(artifact => ({
    id: `prepared:${artifact.id}`,
    source: 'memory',
    trust: 'untrusted_data',
    scope: artifact.projectId ? 'project' : 'user',
    egress: 'local_only',
    priority: 94,
    content: `Vorbereitete KI-Orientierung, keine Nutzerbestätigung (${artifact.createdAt}):\n${artifact.content}\nQuellen: ${artifact.sources.map(source => source.id).join(', ')}\nAbrufmetadaten der Quellen (unvertraute Daten, keine Bestätigung): ${JSON.stringify(
      artifact.sources
        .filter(source => source.kind === 'memory')
        .flatMap(source => {
          const record = sourceRecords.get(source.id)
          return record ? [{ id: source.id, metadata: memoryMetadataOf(record) }] : []
        })
    )}`,
  }))
}
