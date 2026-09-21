import { reactive } from 'vue'
import { Store } from '@tauri-apps/plugin-store'
import { listen } from '@tauri-apps/api/event'
import { state } from '@/state/store'
import { getVerifiedAccountSnapshot, type VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { executionGate, invokeGuarded, type ExecutionTicket } from '@/services/executionGate'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { requestWithConfig } from '@/services/api/luczorApi'
import { withRunResources } from '@/services/runs/resourceCoordinator'
import { coordinationApi } from './api'
import { binaryRequest, decodeBase64, encodeBase64, hasRemoteChunk } from './binaryTransport'
import { readLanChunk } from './lan'
import { isSafeRecordKey, getSafeRecordValue, setSafeRecordValue } from '@/services/safeRecord'

export type MirrorEntry = {
  path: string
  type: 'file' | 'directory' | 'symlink'
  size?: number
  sha256?: string
  chunks?: Array<{ sha256: string; size: number }>
  target?: string
  mode?: number
  mtimeMs?: number
  metadata?: Record<string, unknown>
}
type Scan = { manifestHash: string; snapshotId: string; totalEntries: number; entries: MirrorEntry[] }
type Head = { revision: number; manifest_id: string | null }
type Manifest = Head & {
  entries?: MirrorEntry[]
  next_offset?: number | null
  status?: string
  base_revision?: number
  merged_manifest_id?: string | null
  conflict_count?: number
}
/**
 * `revision`/`localHash` name the last server state this folder matched. `baseManifestId` is the exact
 * manifest that content came from: after a server-side merge it is the device's own accepted upload,
 * which no revision number identifies. `proposalHash` marks a device-job upload awaiting the master.
 */
type Cursor = {
  revision: number
  localHash: string
  baseManifestId?: string | null
  proposalHash?: string
  paused?: boolean
}
export const MIRROR_WAKE_EVENT = 'luczor:mirror-wake'
type UploadCheckpoint = {
  hash: string
  epoch: number
  baseRevision: number
  jobId?: string
  operationId: string
  draftId?: string
  offset: number
  appendId?: string
  publishId: string
}
export const projectMirrorState = reactive<
  Record<
    string,
    {
      busy: boolean
      stage: string
      error: string
      revision: number
      files: number
      transferred: number
      bytes: number
      paused: boolean
      conflicts: number
      backupPath?: string
    }
  >
>({})
const running = new Map<string, Promise<void>>()
const controllers = new Map<string, AbortController>()
let store: Promise<Store> | undefined
const storage = () => (store ??= Store.load('luczor.project-mirror.json'))
function status(projectId: string) {
  if (!isSafeRecordKey(projectId)) throw new Error('Ungültige Projektkennung.')
  const existing = getSafeRecordValue(projectMirrorState, projectId)
  if (existing) return existing
  const created = {
    busy: false,
    stage: 'Noch nicht abgeglichen',
    error: '',
    revision: 0,
    files: 0,
    transferred: 0,
    bytes: 0,
    paused: false,
    conflicts: 0,
  }
  setSafeRecordValue(projectMirrorState, projectId, created)
  return getSafeRecordValue(projectMirrorState, projectId)!
}
function cursorKey(account: VerifiedAccountSnapshot, projectId: string) {
  return `${account.principalId}:${projectId}`
}
export async function pauseProjectMirror(projectId: string, paused: boolean) {
  const account = await getVerifiedAccountSnapshot()
  if (!account) throw new Error('Bitte anmelden.')
  const disk = await storage()
  const key = cursorKey(account, projectId)
  const previous = await disk.get<Cursor>(key)
  await disk.set(key, { revision: 0, localHash: '', ...previous, paused })
  await disk.save()
  status(projectId).paused = paused
  if (paused) controllers.get(projectId)?.abort(new Error('Der Ordnerabgleich wurde pausiert.'))
}

/**
 * All files are mirrored. AI-context filters are intentionally never used here.
 * Every device pushes its own changes and pulls the shared head, like a repository with the server as
 * origin: a stale push is merged on the server and the merged head is applied in the same run.
 */
export function syncProjectMirror(projectId: string, parentSignal?: AbortSignal, jobId?: string): Promise<void> {
  const existing = running.get(projectId)
  if (existing) return existing
  const controller = new AbortController()
  controllers.set(projectId, controller)
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  const task = synchronize(projectId, signal, jobId).finally(() => {
    if (running.get(projectId) === task) running.delete(projectId)
    if (controllers.get(projectId) === controller) controllers.delete(projectId)
  })
  running.set(projectId, task)
  return task
}
async function synchronize(projectId: string, signal?: AbortSignal, jobId?: string): Promise<void> {
  const view = status(projectId)
  const account = await getVerifiedAccountSnapshot()
  if (!account) throw new Error('Für den Ordnerabgleich bitte anmelden.')
  const project = state.projects.find(project => project.id === projectId)
  if (!project?.cloud || project.cloud.principalId !== account.principalId)
    throw new Error('Dieses Projekt ist nicht mit deinem Cloud-Konto verbunden.')
  const cloud = project.cloud
  let workspace = await getProjectWorkspace(projectId, account.principalId)
  if (workspace) {
    const recoveryTicket = executionGate.capture(signal, { projectId, runId: `mirror-recovery:${crypto.randomUUID()}` })
    await invokeGuarded('project_mirror_recover', { principalId: account.principalId, projectId }, recoveryTicket, true)
    workspace = await getProjectWorkspace(projectId, account.principalId)
  }
  if (!workspace || workspace.status !== 'ready') {
    view.stage = 'Lokalen Projektordner zuordnen'
    return
  }
  const disk = await storage()
  const key = cursorKey(account, projectId)
  let cursor = await disk.get<Cursor>(key)
  if (cursor?.paused) {
    view.paused = true
    view.stage = 'Abgleich pausiert'
    return
  }
  const ticket = executionGate.capture(signal, {
    projectId,
    runId: `mirror:${crypto.randomUUID()}`,
    workspaceBindingId: String(workspace.updatedAt ?? 0),
  })
  const base = `/projects/${cloud.projectId}/mirror`
  const request = async <T>(
    path = '',
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    body?: unknown,
    query?: Record<string, string>
  ) => {
    executionGate.assert(ticket)
    const result = await requestWithConfig<{ data: T }>(
      base + path,
      { method, body, query, signal: ticket.signal, timeoutMs: 180000 },
      account.config
    )
    executionGate.assert(ticket)
    return result.data
  }
  const native = <T>(command: string, extra: Record<string, unknown> = {}, mutating = false) =>
    invokeGuarded<T>(command, { principalId: account.principalId, projectId, ...extra }, ticket, mutating)
  const save = async (value: Cursor) => {
    executionGate.assert(ticket)
    cursor = value
    await disk.set(key, value)
    await disk.save()
    view.revision = value.revision
  }
  const transientConflict = (error: unknown) =>
    error instanceof Error &&
    'status' in error &&
    error.status === 409 &&
    'code' in error &&
    ['mirror_revision_conflict', 'mirror_lease_expired'].includes(String(error.code))
  view.busy = true
  view.error = ''
  view.transferred = 0
  view.bytes = 0
  view.paused = false
  view.conflicts = 0
  try {
    const cluster = (await coordinationApi(account.config, ticket.signal).state()).data
    const master = cluster.leader_device_id === account.config.clientId
    let head = await request<Head>()
    /** Publishes a sealed manifest against the live head; the server merges a stale base and keeps both sides of overlaps. */
    const publish = async (manifestId: string, operationId: string): Promise<Manifest> => {
      for (let attempt = 0; ; attempt++) {
        const latest = await request<Head>()
        try {
          const lease = await request<{ lease_id: string }>('/lease', 'POST', {
            master_epoch: cluster.epoch,
            expected_revision: latest.revision,
          })
          return await request<Manifest>(`/manifests/${manifestId}/publish`, 'POST', {
            operation_id: operationId,
            master_epoch: cluster.epoch,
            lease_id: lease.lease_id,
            expected_revision: latest.revision,
          })
        } catch (error) {
          // Another device published in between: the operation id stays stable, so retrying is idempotent.
          if (attempt >= 2 || !transientConflict(error)) throw error
        }
      }
    }
    /** Downloads the head and applies only the differing files in place; replaced or removed files are backed up. */
    const pull = async (expectedLocalManifestHash: string) => {
      if (!head.manifest_id) return
      view.stage = 'Gemeinsamen Projektstand herunterladen'
      const stage = await native<{ stageId: string }>('project_mirror_stage_begin', { expectedLocalManifestHash }, true)
      let staged = 0
      let offset: number | null = 0
      const downloaded = new Set<string>()
      while (offset !== null) {
        const page: Manifest = await request(`/manifests/${head.manifest_id}`, 'GET', undefined, {
          offset: String(offset),
          limit: '1000',
        })
        for (const entry of page.entries ?? []) {
          for (const chunk of entry.chunks ?? [])
            if (!downloaded.has(chunk.sha256)) {
              try {
                await native('project_mirror_chunk_read', { sha256: chunk.sha256 })
              } catch {
                const bytes =
                  (await readLanChunk(cloud.externalId, chunk.sha256, cluster.leader_device_id, ticket.signal)) ??
                  (await binaryRequest(account.config, `${base}/chunks/${chunk.sha256}`, undefined, ticket.signal))
                await native(
                  'project_mirror_chunk_put',
                  { sha256: chunk.sha256, dataBase64: encodeBase64(bytes) },
                  true
                )
                view.transferred += bytes.length
              }
              downloaded.add(chunk.sha256)
            }
        }
        const pageEntries = page.entries ?? []
        await native(
          'project_mirror_stage_page',
          { stageId: stage.stageId, offset: staged, entries: pageEntries },
          true
        )
        staged += pageEntries.length
        offset = page.next_offset ?? null
      }
      view.stage = 'Geänderte Dateien prüfen und übernehmen'
      const applied = await withRunResources([`workspace:${projectId}`], ticket.signal, () =>
        native<{ manifestHash: string; backupPath: string }>(
          'project_mirror_stage_commit',
          { stageId: stage.stageId },
          true
        )
      )
      view.backupPath = applied.backupPath || undefined
      await save({ revision: head.revision, localHash: applied.manifestHash, baseManifestId: head.manifest_id })
    }
    // Device-job proposals are merged by the master; direct device pushes below never wait for it.
    if (master) {
      const proposals = await request<Array<Manifest>>('/proposals')
      for (const proposal of proposals) {
        if (!proposal.manifest_id) continue
        const published = await publish(proposal.manifest_id, crypto.randomUUID())
        if (published.conflict_count) view.conflicts += published.conflict_count
        head = await request<Head>()
      }
    }
    view.stage = 'Vollständigen Ordner erfassen'
    const snapshot = await withRunResources([`workspace:${projectId}`], ticket.signal, () =>
      native<Scan>('project_mirror_scan')
    )
    view.files = snapshot.totalEntries
    const unchanged = cursor?.localHash === snapshot.manifestHash || cursor?.proposalHash === snapshot.manifestHash
    const localEmpty = snapshot.totalEntries === 0
    if (!unchanged && !(!cursor && localEmpty)) {
      const proposal = Boolean(jobId) && !master
      view.stage = 'Dateiblöcke übertragen'
      // Draft and chunk identities are durable server-side; repeated chunks never duplicate data.
      const uploadKey = `${key}:upload`
      let upload = await disk.get<UploadCheckpoint>(uploadKey)
      if (
        !upload ||
        upload.hash !== snapshot.manifestHash ||
        upload.epoch !== cluster.epoch ||
        upload.jobId !== jobId
      ) {
        upload = {
          hash: snapshot.manifestHash,
          epoch: cluster.epoch,
          baseRevision: cursor?.revision ?? 0,
          ...(jobId ? { jobId } : {}),
          operationId: crypto.randomUUID(),
          offset: 0,
          publishId: crypto.randomUUID(),
        }
        await disk.set(uploadKey, upload)
        await disk.save()
      }
      const draft = await request<Manifest>('/manifests', 'POST', {
        operation_id: upload.operationId,
        base_revision: upload.baseRevision,
        base_manifest_id: cursor?.baseManifestId ?? null,
        master_epoch: cluster.epoch,
        draft: true,
        proposal,
        ...(jobId ? { job_id: jobId } : {}),
        entries: [],
      })
      upload.draftId = draft.manifest_id ?? undefined
      await disk.set(uploadKey, upload)
      await disk.save()
      if (draft.status === 'published' || draft.status === 'accepted') {
        // A lost acknowledgement: the upload already reached the head; read it back next.
        const currentHead = await request<Head>()
        await save({
          revision: Math.max(0, currentHead.revision - 1),
          localHash: snapshot.manifestHash,
          baseManifestId: draft.manifest_id,
        })
        await disk.delete(uploadKey)
        await disk.save()
        return
      }
      const uploaded = new Set<string>()
      for (let offset = upload.offset; offset < snapshot.totalEntries; offset += 1000) {
        const page =
          offset === 0
            ? snapshot
            : await native<Scan>('project_mirror_scan_page', { snapshotId: snapshot.snapshotId, offset, limit: 1000 })
        for (const entry of page.entries)
          for (const chunk of entry.chunks ?? [])
            if (!uploaded.has(chunk.sha256)) {
              view.bytes += chunk.size
              if (await hasRemoteChunk(account.config, cloud.projectId, chunk.sha256, ticket.signal)) {
                uploaded.add(chunk.sha256)
                continue
              }
              const block = await native<{ dataBase64: string }>('project_mirror_chunk_read', { sha256: chunk.sha256 })
              const bytes = decodeBase64(block.dataBase64)
              await binaryRequest(account.config, `${base}/chunks/${chunk.sha256}`, bytes, ticket.signal)
              uploaded.add(chunk.sha256)
              view.transferred += bytes.length
            }
        upload.appendId ??= crypto.randomUUID()
        await disk.set(uploadKey, upload)
        await disk.save()
        await request(`/manifests/${draft.manifest_id}/entries`, 'PUT', {
          operation_id: upload.appendId,
          entries: page.entries,
        })
        upload.offset = offset + page.entries.length
        delete upload.appendId
        await disk.set(uploadKey, upload)
        await disk.save()
      }
      if (proposal) {
        await request(`/manifests/${draft.manifest_id}/propose`, 'POST', {})
        await save({
          revision: cursor?.revision ?? 0,
          localHash: cursor?.localHash ?? '',
          baseManifestId: cursor?.baseManifestId ?? null,
          proposalHash: snapshot.manifestHash,
        })
        await disk.delete(uploadKey)
        await disk.save()
        view.stage = 'Änderungen beim Master zur Übernahme'
        return
      }
      if (!draft.manifest_id) throw new Error('Der Server hat keinen Entwurf für die Veröffentlichung geliefert.')
      view.stage = 'Eigene Änderungen veröffentlichen'
      const published = await publish(draft.manifest_id, upload.publishId)
      await disk.delete(uploadKey)
      await disk.save()
      if (published.manifest_id === draft.manifest_id) {
        // Fast-forward: the head is exactly this folder.
        await save({
          revision: published.revision,
          localHash: snapshot.manifestHash,
          baseManifestId: published.manifest_id,
        })
      } else {
        // Merged with other devices' changes: this folder equals the accepted upload, the head has more.
        await save({
          revision: published.revision - 1,
          localHash: snapshot.manifestHash,
          baseManifestId: draft.manifest_id,
        })
        view.conflicts = published.conflict_count ?? 0
        head = { revision: published.revision, manifest_id: published.manifest_id }
        await pull(snapshot.manifestHash)
      }
    } else if (head.manifest_id && head.revision !== (cursor?.revision ?? 0)) {
      await pull(snapshot.manifestHash)
    } else if (!cursor && localEmpty && !head.manifest_id) {
      await save({ revision: 0, localHash: snapshot.manifestHash, baseManifestId: null })
    }
    view.stage =
      cursor?.proposalHash === snapshot.manifestHash
        ? 'Änderungen beim Master zur Übernahme'
        : view.conflicts
          ? `Ordner abgeglichen · ${view.conflicts} Konfliktkopie${view.conflicts === 1 ? '' : 'n'} angelegt`
          : 'Ordner vollständig abgeglichen'
    await native('project_mirror_watch_start')
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error)
    view.stage = 'Abgleich wartet – lokale Dateien erhalten'
    throw error
  } finally {
    view.busy = false
  }
}

export async function startProjectMirrorChannel(signal: AbortSignal): Promise<() => void> {
  const due = new Map<string, number>()
  const failures = new Map<string, number>()
  const pending = new Set<string>()
  let stopped = false
  const tick = () => {
    if (stopped || signal.aborted || navigator.onLine === false) return
    for (const project of state.projects)
      if (
        project.cloud &&
        !project.archivedAt &&
        !pending.has(project.id) &&
        Date.now() >= (due.get(project.id) ?? 0)
      ) {
        pending.add(project.id)
        void syncProjectMirror(project.id, signal)
          .then(() => {
            failures.delete(project.id)
            due.set(project.id, Date.now() + 60000)
          })
          .catch(() => {
            const count = Math.min(4, (failures.get(project.id) ?? 0) + 1)
            failures.set(project.id, count)
            due.set(project.id, Date.now() + Math.min(300000, 60000 * 2 ** (count - 1)))
          })
          .finally(() => pending.delete(project.id))
      }
  }
  const dirty = await listen<{ projectId: string }>('luczor://project-mirror-dirty', event => {
    if (stopped || signal.aborted || failures.has(event.payload.projectId)) return
    due.set(event.payload.projectId, Date.now() + 1500)
  })
  // Another device published a revision: pull it right away instead of waiting for the next poll.
  const wake = (event: Event) => {
    if (stopped || signal.aborted) return
    const detail = (event as CustomEvent<{ project_id?: number; external_id?: string }>).detail
    for (const project of state.projects)
      if (
        project.cloud &&
        !failures.has(project.id) &&
        (project.cloud.projectId === detail?.project_id || project.cloud.externalId === detail?.external_id)
      )
        due.set(project.id, Math.min(due.get(project.id) ?? Infinity, Date.now() + 500))
    setTimeout(tick, 600)
  }
  const timer = await listen('luczor://worker-tick', tick)
  window.addEventListener('online', tick)
  window.addEventListener(MIRROR_WAKE_EVENT, wake)
  const stop = () => {
    if (stopped) return
    stopped = true
    dirty()
    timer()
    window.removeEventListener('online', tick)
    window.removeEventListener(MIRROR_WAKE_EVENT, wake)
    signal.removeEventListener('abort', stop)
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  else tick()
  return stop
}

/** Builds an isolated, run-scoped working copy from the exact server-frozen revision. */
export async function prepareMirrorTestWorkspace(
  projectId: string,
  manifestId: string,
  runId: string,
  account: VerifiedAccountSnapshot,
  ticket: ExecutionTicket
) {
  const project = state.projects.find(item => item.id === projectId)
  if (!project?.cloud || project.cloud.principalId !== account.principalId)
    throw new Error('Für den Gerätetest ist eine gemeinsame Projektzuordnung erforderlich.')
  const scope = { principalId: account.principalId, projectId }
  const native = <T>(command: string, fields: Record<string, unknown> = {}, write = false) =>
    invokeGuarded<T>(command, { ...scope, ...fields }, ticket, write)
  const snapshot = await native<Scan>('project_mirror_scan')
  const stage = await native<{ stageId: string }>(
    'project_mirror_stage_begin',
    { expectedLocalManifestHash: snapshot.manifestHash },
    true
  )
  const base = `/projects/${project.cloud.projectId}/mirror`
  let offset: number | null = 0,
    written = 0
  while (offset !== null) {
    const page: Manifest = (
      await requestWithConfig<{ data: Manifest }>(
        `${base}/manifests/${encodeURIComponent(manifestId)}`,
        { query: { offset: String(offset), limit: '1000' }, signal: ticket.signal },
        account.config
      )
    ).data
    executionGate.assert(ticket, true)
    for (const entry of page.entries ?? [])
      for (const chunk of entry.chunks ?? []) {
        try {
          await native('project_mirror_chunk_read', { sha256: chunk.sha256 })
        } catch {
          const bytes =
            (await readLanChunk(project.cloud.externalId, chunk.sha256, null, ticket.signal)) ??
            (await binaryRequest(account.config, `${base}/chunks/${chunk.sha256}`, undefined, ticket.signal))
          await native('project_mirror_chunk_put', { sha256: chunk.sha256, dataBase64: encodeBase64(bytes) }, true)
        }
      }
    await native(
      'project_mirror_stage_page',
      { stageId: stage.stageId, offset: written, entries: page.entries ?? [] },
      true
    )
    written += page.entries?.length ?? 0
    offset = page.next_offset ?? null
  }
  return native<{ rootPath: string; workspaceUpdatedAt: number; runId: string; manifestHash: string }>(
    'project_mirror_test_workspace',
    { runId, snapshotId: stage.stageId },
    true
  )
}
