import { reactive } from 'vue'
import { state } from '@/state/store'
import type { Message, MemoryItem, Project, ProjectGoal, SummaryItem } from '@/state/types'
import { saveAppStateStrict } from '@/services/persistence'
import { getVerifiedAccountSnapshot, type VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig } from './luczorApi'
import { getSafeRecordValue, isSafeRecordKey, setSafeRecordValue } from '@/services/safeRecord'
import { cloudProjectPrincipal } from '@/services/cloudProjectAccess'

type PortableMessage = Pick<Message, 'id' | 'role' | 'content' | 'ts' | 'createdAt' | 'visibility'>
type PortableMemory = Omit<MemoryItem, 'projectId'>
type PortableSummary = Omit<SummaryItem, 'projectId'>
export type CloudProjectSnapshot = {
  schema_version: 1
  project: Pick<Project, 'name' | 'goal' | 'summary' | 'goals' | 'createdAt' | 'updatedAt' | 'archivedAt'>
  messages: PortableMessage[]
  memories: PortableMemory[]
  summaries: PortableSummary[]
}
export type CloudProjectDocument = {
  project_id: number
  external_id: string
  revision: number
  snapshot: CloudProjectSnapshot
  updated_at: string
  updated_by_device: string | null
}
export type CloudProjectListItem = { id: number; external_id: string; name: string; cloud_revision?: number }
export type CloudProjectFile = {
  path: string
  revision: number
  bytes: number
  sha256: string
  updated_at: string
  updated_by_device: string | null
  content?: string
}
type SyncStatus = 'synced' | 'pending' | 'conflict' | 'error'
export const cloudProjectsState = reactive({
  get principalId() {
    return cloudProjectPrincipal.value
  },
  busy: false,
  projects: [] as CloudProjectListItem[],
  status: {} as Record<string, { state: SyncStatus; message: string }>,
  error: '',
})
let generation = 0
let currentAbort = new AbortController()
let operations: Promise<unknown> = Promise.resolve()
let workloadBusy: () => boolean = () => false

export function configureCloudProjectWorkload(check: () => boolean): () => void {
  workloadBusy = check
  return () => {
    if (workloadBusy === check) workloadBusy = () => false
  }
}
export function invalidateCloudProjects(): void {
  generation++
  currentAbort.abort()
  currentAbort = new AbortController()
  cloudProjectPrincipal.value = ''
  cloudProjectsState.projects = []
  cloudProjectsState.status = {}
  cloudProjectsState.error = ''
}
if (typeof window !== 'undefined') {
  window.addEventListener('luczor:api-identity-changing', invalidateCloudProjects)
  import.meta.hot?.dispose(() => window.removeEventListener('luczor:api-identity-changing', invalidateCloudProjects))
}
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = operations.catch(() => undefined).then(run)
  operations = next.catch(() => undefined)
  return next
}
async function session() {
  const captured = generation
  const account = await getVerifiedAccountSnapshot()
  if (!account || captured !== generation) throw new Error('Für globale Projekte bitte am Luczor-Server anmelden.')
  cloudProjectPrincipal.value = account.principalId
  const signal = currentAbort.signal
  const assertCurrent = () => {
    if (captured !== generation || signal.aborted) throw new Error('Die Benutzerzuordnung wurde geändert.')
  }
  return { account, signal, assertCurrent }
}
type Session = Awaited<ReturnType<typeof session>>
function request<T>(
  current: Session,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
  query?: Record<string, string>
) {
  current.assertCurrent()
  return requestWithConfig<T>(path, { method, body, query, signal: current.signal }, current.account.config)
}
function projectById(id: string) {
  const project = state.projects.find(item => item.id === id)
  if (!project) throw new Error('Das lokale Projekt ist nicht mehr vorhanden.')
  return project
}
function linkedProject(id: string, account: VerifiedAccountSnapshot) {
  const project = projectById(id)
  if (!project.cloud || project.cloud.principalId !== account.principalId)
    throw new Error('Dieses Cloud-Projekt gehört nicht zum angemeldeten Benutzer.')
  return project as Project & { cloud: NonNullable<Project['cloud']> }
}
function assertIdle(id: string): void {
  if (
    workloadBusy() ||
    state.messages.some(
      message => message.projectId === id && (message.meta?.isLoading || message.meta?.activity?.status === 'running')
    ) ||
    getSafeRecordValue(state.pending.toolCallsByProject, id)?.some(call =>
      ['approved', 'executing', 'proposed'].includes(call.status)
    )
  )
    throw new Error('Der Auftrag läuft noch. Der Projektabgleich wartet bis zum Abschluss.')
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Only portable, public project content. No native paths, tools, raw model output or account memories. */
export function snapshotForCloud(projectId: string): CloudProjectSnapshot {
  const project = projectById(projectId)
  const messages = state.messages
    .filter(
      item =>
        item.projectId === projectId &&
        item.visibility !== 'hidden' &&
        ['user', 'assistant'].includes(item.role) &&
        item.meta?.dataHandling !== 'ephemeral' &&
        !item.meta?.isLoading
    )
    .map(({ id, role, content, ts, createdAt }) => ({
      id,
      role,
      content,
      ts,
      createdAt,
      visibility: 'visible' as const,
    }))
  const memories = state.global.memories
    .filter(item => item.projectId === projectId)
    .map(({ projectId: _projectId, ...memory }) => memory)
  const summaries = state.summaries
    .filter(item => item.projectId === projectId)
    .map(({ projectId: _projectId, ...summary }) => summary)
  return validateSnapshot(
    copy({
      schema_version: 1,
      project: {
        name: project.name,
        goal: project.goal,
        summary: project.summary,
        goals: project.goals,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        archivedAt: project.archivedAt,
      },
      messages,
      memories,
      summaries,
    })
  )
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ungültiges Cloud-Projektformat.')
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > limit)
    throw new Error('Ein Cloud-Projektfeld ist ungültig oder zu groß.')
  return value
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Ungültiger Zeitstempel im Cloud-Projekt.')
  return Number(value)
}
function identifier(value: unknown): string {
  const result = text(value, 200)
  if (!result || !isSafeRecordKey(result)) throw new Error('Ungültige Cloud-Projekt-ID.')
  return result
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error(`Cloud-Projekt überschreitet die zulässige Eintragszahl (${limit}).`)
  return value
}
function unique<T extends { id: string }>(values: T[]): T[] {
  if (new Set(values.map(item => item.id)).size !== values.length) throw new Error('Doppelte IDs im Cloud-Projekt.')
  return values
}
export function validateSnapshot(value: unknown): CloudProjectSnapshot {
  const snapshot = record(value)
  if (snapshot.schema_version !== 1) throw new Error('Unbekannte Cloud-Projektversion.')
  const project = record(snapshot.project)
  const goals = unique(
    list(project.goals, 500).map(value => {
      const goal = record(value)
      if (
        !['open', 'in_progress', 'done'].includes(String(goal.status)) ||
        (goal.priority !== undefined && !['low', 'normal', 'high'].includes(String(goal.priority)))
      )
        throw new Error('Ungültiges Projektziel.')
      return {
        id: identifier(goal.id),
        title: text(goal.title, 1000),
        status: goal.status as ProjectGoal['status'],
        ...(goal.description === undefined ? {} : { description: text(goal.description, 20000) }),
        ...(goal.priority === undefined ? {} : { priority: goal.priority as ProjectGoal['priority'] }),
        createdAt: timestamp(goal.createdAt),
        updatedAt: timestamp(goal.updatedAt),
        ...(goal.doneAt == null ? {} : { doneAt: timestamp(goal.doneAt) }),
      }
    })
  )
  const messages = unique(
    list(snapshot.messages ?? [], 2000).map(value => {
      const message = record(value)
      if (message.role !== 'user' && message.role !== 'assistant')
        throw new Error('Cloud-Projekte enthalten nur öffentliche Chatnachrichten.')
      return {
        id: identifier(message.id),
        role: message.role as 'user' | 'assistant',
        content: text(message.content, 200000),
        ts: timestamp(message.ts),
        createdAt: timestamp(message.createdAt),
        visibility: 'visible' as const,
      }
    })
  )
  const memories = unique(
    list(snapshot.memories ?? [], 500).map(value => {
      const memory = record(value)
      if (
        !['rule', 'todo_policy', 'preference', 'fact', 'note'].includes(String(memory.kind)) ||
        ![1, 2, 3, 4, 5].includes(Number(memory.priority)) ||
        typeof memory.active !== 'boolean'
      )
        throw new Error('Ungültige Projekterinnerung.')
      const source = record(memory.source)
      if (!['user', 'assistant', 'system'].includes(String(source.by))) throw new Error('Ungültige Erinnerungsquelle.')
      return {
        id: identifier(memory.id),
        kind: memory.kind as MemoryItem['kind'],
        key: text(memory.key, 1000),
        value: text(memory.value, 200000),
        priority: memory.priority as MemoryItem['priority'],
        active: memory.active,
        createdAt: timestamp(memory.createdAt),
        updatedAt: timestamp(memory.updatedAt),
        source: { by: source.by as MemoryItem['source']['by'] },
      }
    })
  )
  const summaries = unique(
    list(snapshot.summaries ?? [], 500).map(value => {
      const summary = record(value)
      return { id: identifier(summary.id), text: text(summary.text, 200000), createdAt: timestamp(summary.createdAt) }
    })
  )
  const result: CloudProjectSnapshot = {
    schema_version: 1,
    project: {
      name: text(project.name, 240),
      summary: text(project.summary ?? '', 200000),
      goals,
      ...(project.goal == null ? {} : { goal: text(project.goal, 60000) }),
      createdAt: timestamp(project.createdAt),
      updatedAt: timestamp(project.updatedAt),
      archivedAt: project.archivedAt == null ? null : timestamp(project.archivedAt),
    },
    messages,
    memories,
    summaries,
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 4 * 1024 * 1024)
    throw new Error('Das Projekt ist für den Cloud-Abgleich zu groß (maximal 4 MiB). Es wurde nichts gekürzt.')
  return result
}
async function fingerprint(snapshot: CloudProjectSnapshot): Promise<string> {
  // Selecting a chat touches updatedAt without editing portable content.
  const content = { ...snapshot, project: { ...snapshot.project, updatedAt: 0 } }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function document(value: CloudProjectDocument): CloudProjectDocument {
  if (
    !Number.isSafeInteger(value.project_id) ||
    value.project_id < 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error('Ungültige Cloud-Projektrevision.')
  identifier(value.external_id)
  return { ...value, snapshot: validateSnapshot(value.snapshot) }
}
function setStatus(id: string, status: SyncStatus, message: string) {
  if (isSafeRecordKey(id)) setSafeRecordValue(cloudProjectsState.status, id, { state: status, message })
}
async function saveLink(current: Session, local: Project, remote: CloudProjectDocument, hash: string): Promise<void> {
  current.assertCurrent()
  const previous = local.cloud
  local.cloud = {
    principalId: current.account.principalId,
    projectId: remote.project_id,
    externalId: remote.external_id,
    revision: remote.revision,
    fingerprint: hash,
    syncedAt: Date.now(),
    paused: local.cloud?.paused ?? false,
  }
  try {
    await saveAppStateStrict(state)
  } catch (error) {
    local.cloud = previous
    throw error
  }
  current.assertCurrent()
  setStatus(local.id, 'synced', `Abgeglichen · Version ${remote.revision}`)
}
async function applyRemote(
  current: Session,
  local: Project,
  remote: CloudProjectDocument,
  baseline: string
): Promise<void> {
  const hash = await fingerprint(remote.snapshot)
  current.assertCurrent()
  assertIdle(local.id)
  if (JSON.stringify(snapshotForCloud(local.id)) !== baseline)
    throw new Error('Das Projekt wurde während des Abgleichs geändert. Lokale Änderungen bleiben erhalten.')
  const snapshot = remote.snapshot
  Object.assign(local, copy(snapshot.project))
  // The app addresses messages by (projectId, id); device-only tool observations stay on this device.
  state.messages = state.messages
    .filter(
      item => item.projectId !== local.id || item.visibility === 'hidden' || item.meta?.dataHandling === 'ephemeral'
    )
    .concat(snapshot.messages.map(message => ({ ...message, projectId: local.id, parsed: null, meta: {} })))
  state.global.memories = state.global.memories
    .filter(item => item.projectId !== local.id)
    .concat(snapshot.memories.map(memory => ({ ...memory, projectId: local.id })))
  state.summaries = state.summaries
    .filter(item => item.projectId !== local.id)
    .concat(snapshot.summaries.map(summary => ({ ...summary, projectId: local.id })))
  await saveLink(current, local, remote, hash)
}

export async function listCloudProjects(): Promise<CloudProjectListItem[]> {
  const current = await session()
  const result: CloudProjectListItem[] = []
  for (let page = 1; page <= 100; page++) {
    const response = await request<{
      data: { data: CloudProjectListItem[]; current_page?: number; last_page?: number }
    }>(current, '/projects', 'GET', undefined, { scope: 'cloud', page: String(page) })
    current.assertCurrent()
    const batch = response.data.data
    if (!Array.isArray(batch)) throw new Error('Die Serverantwort enthält keine globale Projektliste.')
    for (const item of batch) {
      if (!Number.isSafeInteger(item.id) || item.id < 1) throw new Error('Ungültige Cloud-Projekt-ID.')
      identifier(item.external_id)
      text(item.name, 240)
      result.push(item)
    }
    if (!batch.length || page >= (response.data.last_page ?? page)) {
      cloudProjectsState.projects = result
      return result
    }
  }
  throw new Error('Die globale Projektliste überschreitet die zulässige Seitengröße.')
}

/** First publication is explicit. Existing projects from other devices are never claimed by matching names. */
export function publishCloudProject(id: string): Promise<void> {
  return serialize(async () => {
    const current = await session()
    const local = projectById(id)
    if (local.cloud) throw new Error('Das Projekt ist bereits mit der Cloud verknüpft.')
    assertIdle(id)
    const snapshot = snapshotForCloud(id)
    const hash = await fingerprint(snapshot)
    current.assertCurrent()
    const created = await request<{ data: { id: number } }>(current, '/projects', 'POST', {
      external_id: id,
      name: local.name,
    })
    current.assertCurrent()
    const remote = document(
      (
        await request<{ data: CloudProjectDocument }>(current, `/projects/${created.data.id}/cloud`, 'PUT', {
          expected_revision: 0,
          snapshot,
        })
      ).data
    )
    await saveLink(current, local, remote, hash)
  })
}

export function importCloudProject(projectId: number): Promise<string> {
  return serialize(async () => {
    const current = await session()
    const existing = state.projects.find(
      project => project.cloud?.principalId === current.account.principalId && project.cloud.projectId === projectId
    )
    if (existing) return existing.id
    const remote = document(
      (await request<{ data: CloudProjectDocument }>(current, `/projects/${projectId}/cloud`)).data
    )
    current.assertCurrent()
    if (remote.project_id !== projectId) throw new Error('Widersprüchliche Cloud-Projektzuordnung.')
    const id = `cloud-${crypto.randomUUID()}`
    const local: Project = {
      id,
      ...copy(remote.snapshot.project),
      defaults: { maxOutputTokens: state.global.defaults.maxOutputTokens },
      focus: { activeTodoId: null, activeStepId: null },
    }
    state.projects.push(local)
    try {
      await applyRemote(current, local, remote, JSON.stringify(snapshotForCloud(id)))
    } catch (error) {
      state.projects = state.projects.filter(project => project.id !== id)
      state.messages = state.messages.filter(message => message.projectId !== id)
      state.global.memories = state.global.memories.filter(memory => memory.projectId !== id)
      state.summaries = state.summaries.filter(summary => summary.projectId !== id)
      throw error
    }
    return id
  })
}

async function synchronizeProject(current: Session, id: string) {
  const local = linkedProject(id, current.account)
  if (local.cloud.paused) return
  assertIdle(id)
  const snapshot = snapshotForCloud(id)
  const baseline = JSON.stringify(snapshot)
  const hash = await fingerprint(snapshot)
  const remote = document(
    (await request<{ data: CloudProjectDocument }>(current, `/projects/${local.cloud.projectId}/cloud`)).data
  )
  current.assertCurrent()
  assertIdle(id)
  if (
    remote.project_id !== local.cloud.projectId ||
    remote.external_id !== local.cloud.externalId ||
    remote.revision < local.cloud.revision
  )
    throw new Error('Die Cloud-Projektzuordnung oder Revision ist widersprüchlich.')
  if (JSON.stringify(snapshotForCloud(id)) !== baseline) {
    setStatus(id, 'pending', 'Neue lokale Änderungen warten auf den nächsten Abgleich.')
    return
  }
  if (remote.revision > local.cloud.revision) {
    // Content equality for optimistic concurrency, not a credential comparison.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (hash !== local.cloud.fingerprint) {
      setStatus(
        id,
        'conflict',
        'Beide Geräte haben Änderungen. Cloud-Stand als getrennte Kopie öffnen oder lokalen Stand separat veröffentlichen.'
      )
      return
    }
    await applyRemote(current, local, remote, baseline)
    // eslint-disable-next-line security/detect-possible-timing-attacks -- public content equality
  } else if (hash !== local.cloud.fingerprint) {
    const updated = document(
      (
        await request<{ data: CloudProjectDocument }>(current, `/projects/${local.cloud.projectId}/cloud`, 'PUT', {
          expected_revision: local.cloud.revision,
          snapshot,
        })
      ).data
    )
    await saveLink(current, local, updated, hash)
  } else setStatus(id, 'synced', `Abgeglichen · Version ${remote.revision}`)
}

export function syncCloudProjects(onlyId?: string): Promise<void> {
  return serialize(async () => {
    cloudProjectsState.busy = true
    cloudProjectsState.error = ''
    try {
      const current = await session()
      for (const project of [...state.projects]) {
        if (
          !project.cloud ||
          project.cloud.principalId !== current.account.principalId ||
          (onlyId && onlyId !== project.id)
        )
          continue
        try {
          await synchronizeProject(current, project.id)
        } catch (error) {
          current.assertCurrent()
          const status = (error as { status?: number }).status
          setStatus(
            project.id,
            status === 409 ? 'conflict' : 'error',
            error instanceof Error ? error.message : 'Projektabgleich fehlgeschlagen.'
          )
          if (onlyId) throw error
        }
      }
    } catch (error) {
      cloudProjectsState.error = error instanceof Error ? error.message : 'Cloud-Verbindung fehlgeschlagen.'
      throw error
    } finally {
      cloudProjectsState.busy = false
    }
  })
}

export async function pauseCloudProject(id: string, paused: boolean): Promise<void> {
  const current = await session()
  linkedProject(id, current.account).cloud.paused = paused
  await saveAppStateStrict(state)
}

/** Keep the local copy intact when resolving concurrent edits; import a separate server copy for review. */
export function copyCloudProject(id: string): Promise<string> {
  return serialize(async () => {
    const current = await session()
    const local = linkedProject(id, current.account)
    assertIdle(id)
    const remote = document(
      (await request<{ data: CloudProjectDocument }>(current, `/projects/${local.cloud.projectId}/cloud`)).data
    )
    current.assertCurrent()
    const newId = `cloud-review-${crypto.randomUUID()}`
    const clone: Project = {
      id: newId,
      ...copy(remote.snapshot.project),
      defaults: { ...local.defaults },
      focus: { activeTodoId: null, activeStepId: null },
    }
    state.projects.push(clone)
    await applyRemote(current, clone, remote, JSON.stringify(snapshotForCloud(newId)))
    clone.name += ' · Cloud-Kopie'
    clone.cloud!.paused = true
    await saveAppStateStrict(state)
    return newId
  })
}

export async function cloudProjectFiles(id: string): Promise<CloudProjectFile[]> {
  const current = await session()
  const local = linkedProject(id, current.account)
  const response = await request<{ data: CloudProjectFile[] }>(current, `/projects/${local.cloud.projectId}/files`)
  current.assertCurrent()
  return response.data
}
export async function readCloudProjectFile(id: string, path: string): Promise<CloudProjectFile & { content: string }> {
  const current = await session()
  const local = linkedProject(id, current.account)
  const response = await request<{ data: CloudProjectFile & { content: string } }>(
    current,
    `/projects/${local.cloud.projectId}/files/content`,
    'GET',
    undefined,
    { path }
  )
  current.assertCurrent()
  return response.data
}
export async function saveCloudProjectFile(
  id: string,
  path: string,
  content: string,
  expectedRevision: number
): Promise<CloudProjectFile> {
  const current = await session()
  const local = linkedProject(id, current.account)
  if (new TextEncoder().encode(content).length > 1024 * 1024)
    throw new Error('Eine Cloud-Datei darf höchstens 1 MiB Text enthalten.')
  const response = await request<{ data: CloudProjectFile }>(
    current,
    `/projects/${local.cloud.projectId}/files`,
    'PUT',
    { path, content, expected_revision: expectedRevision }
  )
  current.assertCurrent()
  return response.data
}
