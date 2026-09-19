import type { RepositoryGraphPage, RepositoryGraphStatus } from '@/services/repositoryGraph'
import { maintenanceHash, type MaintenanceJob, type MaintenanceSource } from './maintenance'
import type { HydratedMaintenanceJob } from './maintenancePlanner'

/** Source text is never stored in this checkpoint. It lives in the principal's encrypted journal. */
export type RepositoryMaintenanceCursor = {
  repositoryId: string
  offset: number
  indexRevision: string
  exhaustedAt?: number
}

export const REPOSITORY_MAINTENANCE_WINDOW = 12
export const REPOSITORY_MAINTENANCE_RESCAN_MS = 5 * 60_000
const MAX_INSPECTIONS = 2
const MAX_GRAPH_OFFSET = 20_000

type InspectRepository = (
  principalId: string,
  projectId: string,
  query?: string,
  offset?: number
) => Promise<RepositoryGraphPage>

type RepositoryInput = {
  principalId: string
  projectId: string
  status: RepositoryGraphStatus
  maxChars: number
  now: number
  signal: AbortSignal
  inspect: InspectRepository
}

export type RepositoryMaintenancePage = {
  work: HydratedMaintenanceJob[]
  cursor?: RepositoryMaintenanceCursor
  /** More discovery remains, even if this bounded window contains no runnable job. */
  pendingScan: boolean
}

function indexRevision(status: RepositoryGraphStatus): string {
  return JSON.stringify([
    status.repository_id,
    status.last_indexed_at,
    status.commit_sha,
    status.files,
    status.symbols,
    status.edges,
    status.lsp,
  ])
}

async function hydrateFile(
  input: RepositoryInput,
  file: RepositoryGraphPage['files'][number]
): Promise<HydratedMaintenanceJob> {
  input.signal.throwIfAborted()
  // The inspector's explicit sampling flag remains evidence: this is not the whole file or repository.
  const content = JSON.stringify({
    repository: input.status.repository_id,
    ...file,
    evidence: 'LSP/index metadata; no full repository claim',
  })
  const source: MaintenanceSource = {
    id: file.id,
    kind: 'repository',
    revision: await maintenanceHash(content),
    content,
  }
  const sources = [{ id: source.id, kind: source.kind, revision: source.revision }]
  const oversized = JSON.stringify([source]).length > input.maxChars
  input.signal.throwIfAborted()
  return {
    id: `repository:${input.projectId}:${file.path}`,
    projectId: input.projectId,
    kind: 'repository',
    sources,
    material: [source],
    // Preserve existing repository receipts/artifacts: their job revision is the metadata hash.
    revision: source.revision,
    status: oversized ? 'blocked' : 'pending',
    blockedReason: oversized ? 'source_too_large' : undefined,
    attempts: 0,
    nextAttemptAt: input.now,
    updatedAt: input.now,
  }
}

/** Exact-path validation performs one local metadata query, never a graph-wide rescan. */
export async function hydrateRepositoryJob(
  input: RepositoryInput & { path: string }
): Promise<HydratedMaintenanceJob | undefined> {
  input.signal.throwIfAborted()
  if (input.status.status !== 'ready' || !input.status.repository_id || !input.path) return
  // Match the native inspector's query limit. An unresolvable path fails closed, without shortening it.
  if (Array.from(input.path).length > 256) return
  const page = await input.inspect(input.principalId, input.projectId, input.path, 0)
  input.signal.throwIfAborted()
  const file = page.files.find(candidate => candidate.path === input.path)
  return file ? hydrateFile(input, file) : undefined
}

/**
 * Discover at most two native pages and retain at most twelve whole metadata sources.
 * A window stays until its runnable jobs settle. Backoff/blocked/completed windows advance;
 * one due retry can be hydrated directly so a long repository sweep does not starve retries.
 * Only callers discovering new work should persist the returned cursor, never CAS checks.
 */
export async function discoverRepositoryPage(
  input: RepositoryInput & { jobs: MaintenanceJob[]; cursor?: RepositoryMaintenanceCursor }
): Promise<RepositoryMaintenancePage> {
  input.signal.throwIfAborted()
  const repositoryId = input.status.repository_id
  if (input.status.status !== 'ready' || !repositoryId) {
    return { work: [], cursor: input.cursor, pendingScan: false }
  }
  const revision = indexRevision(input.status)
  let cursor: RepositoryMaintenanceCursor =
    input.cursor?.repositoryId === repositoryId &&
    Number.isInteger(input.cursor.offset) &&
    input.cursor.offset >= 0 &&
    input.cursor.offset <= MAX_GRAPH_OFFSET
      ? { ...input.cursor }
      : { repositoryId, offset: 0, indexRevision: revision }
  const prefix = `repository:${input.projectId}:`
  const known = new Map(
    input.jobs
      .filter(job => job.kind === 'repository' && job.projectId === input.projectId)
      .map(job => [job.id, job])
  )
  const work: HydratedMaintenanceJob[] = []
  let inspections = 0
  const retry = [...known.values()]
    .filter(
      job =>
        job.id.startsWith(prefix) &&
        (job.status === 'running' || (job.status === 'retry' && job.nextAttemptAt <= input.now))
    )
    .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.id.localeCompare(right.id))[0]
  if (retry) {
    inspections++
    const hydrated = await hydrateRepositoryJob({ ...input, path: retry.id.slice(prefix.length) })
    if (hydrated) work.push(hydrated)
  }
  if (cursor.exhaustedAt !== undefined) {
    if (
      cursor.indexRevision === revision &&
      input.now < cursor.exhaustedAt + REPOSITORY_MAINTENANCE_RESCAN_MS
    ) {
      return { work, cursor, pendingScan: false }
    }
    cursor = { repositoryId, offset: 0, indexRevision: revision }
  }

  while (inspections < MAX_INSPECTIONS) {
    input.signal.throwIfAborted()
    const page = await input.inspect(input.principalId, input.projectId, '', cursor.offset)
    inspections++
    input.signal.throwIfAborted()
    const files = page.files.slice(0, REPOSITORY_MAINTENANCE_WINDOW - work.length)
    if (!files.length) {
      cursor = { ...cursor, exhaustedAt: input.now }
      return { work, cursor, pendingScan: false }
    }
    const window = await Promise.all(files.map(file => hydrateFile(input, file)))
    const fresh = window.filter(job => !work.some(loaded => loaded.id === job.id))
    const runnable = fresh.some(job => {
      if (job.blockedReason) return false
      const old = known.get(job.id)
      return (
        !old ||
        old.revision !== job.revision ||
        (old.status === 'blocked' && old.blockedReason === 'source_too_large') ||
        old.status === 'running' ||
        (['pending', 'retry'].includes(old.status) && old.nextAttemptAt <= input.now)
      )
    })
    if (runnable) return { work: [...work, ...fresh], cursor, pendingScan: true }

    // Advance only when this window has no runnable work. Do not persist any source content.
    cursor = { ...cursor, offset: cursor.offset + files.length }
    const end = cursor.offset >= page.total || cursor.offset >= MAX_GRAPH_OFFSET
    if (end) cursor = { ...cursor, exhaustedAt: input.now }
    const changedMetadata = fresh.filter(job => {
      const old = known.get(job.id)
      return !old || old.revision !== job.revision || old.blockedReason !== job.blockedReason
    })
    if (changedMetadata.length || end) {
      return { work: [...work, ...changedMetadata], cursor, pendingScan: !end }
    }
  }
  return { work, cursor, pendingScan: true }
}
