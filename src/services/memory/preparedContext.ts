import { state } from '@/state/store'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory } from './luczorMemory'
import { planMaintenance } from './maintenancePlanner'
import type { PromptFragment } from '@/services/prompt/promptContextAssembler'
import { inspectRepositoryGraph, readRepositorySnippets, repositoryGraphStatus } from '@/services/repositoryGraph'
import { maintenanceHash } from './maintenance'
import type { MemoryUsageOrigin } from './usage'

/** Optional fast orientation. Missing/stale artifacts never delay a chat for generation. */
export async function preparedContextFragments(
  projectId: string,
  query: string,
  origin: MemoryUsageOrigin = 'chat'
): Promise<PromptFragment[]> {
  const account = await getVerifiedAccountSnapshot()
  if (!account) return []
  const snapshot = await luczorMemory.maintenanceSnapshot(account.principalId)
  if (!snapshot.journal.artifacts.length) return []
  const projects = state.projects.filter(project => project.id === projectId)
  if (!projects.length) return []
  const jobs = await planMaintenance({
    principalId: account.principalId,
    projects,
    records: snapshot.records,
    messages: state.messages,
    now: Date.now(),
  })
  const revisions = new Map(jobs.map(job => [job.id, job.revision]))
  const words = query
    .toLocaleLowerCase()
    .split(/\W+/u)
    .filter(word => word.length > 2)
  const score = (text: string) => words.filter(word => text.toLocaleLowerCase().includes(word)).length
  const valid = snapshot.journal.artifacts.filter(
    artifact =>
      (!artifact.projectId || artifact.projectId === projectId) &&
      artifact.kind === 'context' &&
      revisions.get(artifact.id) === artifact.revision
  )
  const repository = snapshot.journal.artifacts
    .filter(artifact => artifact.projectId === projectId && artifact.kind === 'repository')
    .sort((left, right) => score(right.content) - score(left.content))
    .slice(0, 2)
  for (const artifact of repository) {
    try {
      const path = artifact.id.slice(`repository:${projectId}:`.length)
      const [status, page, evidence] = await Promise.all([
        repositoryGraphStatus(account.principalId, projectId),
        inspectRepositoryGraph(account.principalId, projectId, path),
        readRepositorySnippets(
          account.principalId,
          projectId,
          artifact.sources.map(source => source.id),
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
      if (revision === artifact.revision) valid.push(artifact)
    } catch {
      /* Current evidence unavailable: regular retrieval remains the fallback. */
    }
  }
  valid.sort((left, right) => score(right.content) - score(left.content) || right.createdAt - left.createdAt)
  if ((await getVerifiedAccountSnapshot())?.principalId !== account.principalId) return []
  return valid.slice(0, 3).map(artifact => ({
    id: `prepared:${artifact.id}`,
    source: 'memory',
    trust: 'untrusted_data',
    scope: artifact.projectId ? 'project' : 'user',
    egress: 'local_only',
    priority: 94,
    content: `Vorbereitete KI-Orientierung, keine Nutzerbestätigung (${artifact.createdAt}):\n${artifact.content}\nQuellen: ${artifact.sources.map(source => source.id).join(', ')}`,
  }))
}
