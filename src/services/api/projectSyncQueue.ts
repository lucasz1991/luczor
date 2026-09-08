import { Store } from '@tauri-apps/plugin-store'
import { LuczorApi, type LuczorApiConfigSnapshot } from './luczorApi'
import { state } from '@/state/store'
import { unbindProjectWorkspace } from '@/services/projectWorkspace'

const STORE_FILE = 'luczor.pending-project-sync.json'
const STORE_KEY = 'queue_v1'
const STORE_VERSION = 1
const MAX_ENTRIES = 500
const MAX_BATCH = 8
const INITIAL_RETRY_MS = 15_000
const MAX_RETRY_MS = 5 * 60_000
const SHA256 = /^[0-9a-f]{64}$/u

type StoredProjectSync = {
  scopeId: string
  operationId: string
  externalId: string
  name: string
  state: 'staged' | 'ready'
  queuedAt: number
  attempts: number
  nextAttemptAt: number
  lastAttemptAt?: number
  workspacePrincipalId?: string
}

type StoredDocument = {
  version: typeof STORE_VERSION
  entries: StoredProjectSync[]
}

export type ProjectSyncFlushResult = {
  attempted: number
  synced: number
  pending: number
}

export type ProjectSyncFlushOptions = {
  config?: LuczorApiConfigSnapshot
  signal?: AbortSignal
  force?: boolean
  maxEntries?: number
}

export type StagedProjectSync = Readonly<{
  scopeId: string
  operationId: string
  externalId: string
}>

export type ProjectSyncStageOptions = {
  workspacePrincipalId?: string
}

let writes: Promise<void> = Promise.resolve()
let flushes: Promise<unknown> = Promise.resolve()
const activeOperations = new Set<string>()

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) return ''
  return normalized
}

function normalizeEntry(value: unknown): StoredProjectSync | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const scopeId = normalizeText(item.scopeId, 64).toLowerCase()
  const operationId = normalizeText(item.operationId, 100)
  const externalId = normalizeText(item.externalId, 200)
  const name = normalizeText(item.name, 240)
  const state = item.state
  const queuedAt = Number(item.queuedAt)
  const attempts = Number(item.attempts)
  const nextAttemptAt = Number(item.nextAttemptAt)
  const lastAttemptAt = item.lastAttemptAt === undefined ? undefined : Number(item.lastAttemptAt)
  const workspacePrincipalId =
    item.workspacePrincipalId === undefined ? undefined : normalizeText(item.workspacePrincipalId, 1_000)
  if (
    !SHA256.test(scopeId) ||
    !operationId ||
    !externalId ||
    !name ||
    (state !== 'staged' && state !== 'ready') ||
    !Number.isSafeInteger(queuedAt) ||
    queuedAt < 0 ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    !Number.isSafeInteger(nextAttemptAt) ||
    nextAttemptAt < 0 ||
    (lastAttemptAt !== undefined && (!Number.isSafeInteger(lastAttemptAt) || lastAttemptAt < 0)) ||
    (item.workspacePrincipalId !== undefined && !workspacePrincipalId)
  )
    return null
  return {
    scopeId,
    operationId,
    externalId,
    name,
    state,
    queuedAt,
    attempts,
    nextAttemptAt,
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    ...(workspacePrincipalId === undefined ? {} : { workspacePrincipalId }),
  }
}

function decodeDocument(value: unknown): StoredProjectSync[] {
  if (value === undefined || value === null) return []
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Die Projekt-Synchronisierungsqueue hat ein unbekanntes Format.')
  const document = value as Partial<StoredDocument>
  if (document.version !== STORE_VERSION || !Array.isArray(document.entries))
    throw new Error('Die Projekt-Synchronisierungsqueue hat ein unbekanntes Format.')
  if (document.entries.length > MAX_ENTRIES)
    throw new Error('Die Projekt-Synchronisierungsqueue überschreitet die zulässige Eintragszahl.')
  const entries = document.entries.map(normalizeEntry)
  if (entries.some(entry => !entry))
    throw new Error('Die Projekt-Synchronisierungsqueue enthält einen ungültigen Eintrag.')
  return entries as StoredProjectSync[]
}

async function readEntries(): Promise<StoredProjectSync[]> {
  await writes.catch(() => undefined)
  const store = await Store.load(STORE_FILE)
  return decodeDocument(await store.get<unknown>(STORE_KEY))
}

function replaceEntries(next: (entries: StoredProjectSync[]) => StoredProjectSync[]): Promise<void> {
  const operation = writes
    .catch(() => undefined)
    .then(async () => {
      const store = await Store.load(STORE_FILE)
      const entries = next(decodeDocument(await store.get<unknown>(STORE_KEY)))
      if (entries.length > MAX_ENTRIES)
        throw new Error('Die Projekt-Synchronisierungsqueue überschreitet die zulässige Eintragszahl.')
      await store.set(STORE_KEY, { version: STORE_VERSION, entries } satisfies StoredDocument)
      await store.save()
    })
  writes = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

function canonicalBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

async function apiScopeId(config: LuczorApiConfigSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(
    ['luczor-project-sync-v1', canonicalBaseUrl(config.baseUrl), config.clientId.trim(), config.deviceKey].join(
      '\u0000'
    )
  )
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function assertConfigured(config: LuczorApiConfigSnapshot): void {
  if (!config.baseUrl.trim() || !config.clientId.trim() || !config.deviceKey.trim()) {
    throw new Error(
      'Das Projekt kann erst angelegt werden, wenn Server-URL, Client-ID und Device Key vollständig konfiguriert sind.'
    )
  }
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** Math.min(5, Math.max(0, attempts - 1)))
}

function boundedBatch(value: number | undefined): number {
  if (value === undefined) return MAX_BATCH
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Das Projekt-Synchronisierungslimit ist ungültig.')
  return Math.min(MAX_ENTRIES, value)
}

function hasCommittedLocalProject(externalId: string): boolean {
  return state.projects.some(project => project.id === externalId)
}

function shouldRecover(entry: StoredProjectSync): boolean {
  return (
    entry.state === 'staged' && !activeOperations.has(entry.operationId) && hasCommittedLocalProject(entry.externalId)
  )
}

function shouldDiscard(entry: StoredProjectSync): boolean {
  if (activeOperations.has(entry.operationId)) return false
  return !hasCommittedLocalProject(entry.externalId)
}

async function reconcileProjectSyncEntries(): Promise<void> {
  const snapshot = await readEntries()
  const recoverable = snapshot.filter(shouldRecover)
  const orphaned = snapshot.filter(shouldDiscard)
  if (!recoverable.length && !orphaned.length) return
  const cleaned = new Set<string>()
  for (const entry of orphaned) {
    if (entry.workspacePrincipalId) {
      try {
        await unbindProjectWorkspace(entry.externalId, entry.workspacePrincipalId)
      } catch {
        // Keep the recovery marker until the authoritative native binding can
        // be checked and removed on a later startup/status pass.
        continue
      }
    }
    cleaned.add(entry.operationId)
  }
  const recovered = new Set(recoverable.map(entry => entry.operationId))
  if (!cleaned.size && !recovered.size) return
  await replaceEntries(entries =>
    entries
      .filter(entry => !cleaned.has(entry.operationId))
      .map(entry => (recovered.has(entry.operationId) ? { ...entry, state: 'ready' as const } : entry))
  )
}

/** Persist the idempotent project POST before the caller reports local success. */
export async function enqueueProjectSync(
  externalIdInput: string,
  nameInput: string,
  config: LuczorApiConfigSnapshot,
  options: ProjectSyncStageOptions = {}
): Promise<StagedProjectSync> {
  assertConfigured(config)
  const externalId = normalizeText(externalIdInput, 200)
  const name = normalizeText(nameInput, 240)
  const workspacePrincipalId = options.workspacePrincipalId
    ? normalizeText(options.workspacePrincipalId, 1_000)
    : undefined
  if (!externalId || !name) throw new Error('Das lokale Projekt besitzt keine gültigen Synchronisierungsdaten.')
  if (options.workspacePrincipalId && !workspacePrincipalId)
    throw new Error('Die lokale Workspace-Identität für die Projektanlage ist ungültig.')
  const scopeId = await apiScopeId(config)
  await reconcileProjectSyncEntries()
  const operationId =
    globalThis.crypto?.randomUUID?.() ?? `project-sync-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const queuedAt = Date.now()
  activeOperations.add(operationId)
  try {
    await replaceEntries(entries => {
      const retained = entries.filter(entry => entry.scopeId !== scopeId || entry.externalId !== externalId)
      return [
        ...retained,
        {
          scopeId,
          operationId,
          externalId,
          name,
          state: 'staged',
          queuedAt,
          attempts: 0,
          nextAttemptAt: 0,
          ...(workspacePrincipalId ? { workspacePrincipalId } : {}),
        } satisfies StoredProjectSync,
      ]
    })
  } catch (error) {
    activeOperations.delete(operationId)
    throw error
  }
  return Object.freeze({ scopeId, operationId, externalId })
}

/** Remove one abandoned staging marker without touching another retry. */
export function cancelProjectSync(staged: StagedProjectSync): Promise<void> {
  const operation = replaceEntries(entries => entries.filter(entry => !sameOperation(entry, staged))).finally(() => {
    activeOperations.delete(staged.operationId)
  })
  return operation
}

function sameOperation(entry: StoredProjectSync, staged: StagedProjectSync): boolean {
  return (
    entry.scopeId === staged.scopeId &&
    entry.operationId === staged.operationId &&
    entry.externalId === staged.externalId
  )
}

/**
 * Durably publish the local project before making its server retry eligible.
 * A crash after the local save leaves a staged marker that startup recovery
 * promotes to ready; a crash before that save safely discards the marker.
 */
export function commitProjectSync(staged: StagedProjectSync, commitLocal: () => void | Promise<void>): Promise<void> {
  const operation = writes
    .catch(() => undefined)
    .then(async () => {
      try {
        const store = await Store.load(STORE_FILE)
        const existing = decodeDocument(await store.get<unknown>(STORE_KEY))
        const candidate = existing.find(entry => sameOperation(entry, staged) && entry.state === 'staged')
        if (!candidate) throw new Error('Der vorbereitete Projekt-Synchronisierungseintrag ist nicht mehr verfügbar.')

        try {
          await commitLocal()
        } catch (error) {
          const retained = existing.filter(entry => !sameOperation(entry, staged))
          await store.set(STORE_KEY, { version: STORE_VERSION, entries: retained } satisfies StoredDocument)
          await store.save()
          throw error
        }
        const ready = existing.map(entry =>
          sameOperation(entry, staged) ? { ...entry, state: 'ready' as const } : entry
        )
        try {
          await store.set(STORE_KEY, { version: STORE_VERSION, entries: ready } satisfies StoredDocument)
          await store.save()
        } catch {
          // The original staged marker is already durable. Since commitLocal
          // succeeded durably, the next reconciliation promotes it to ready.
        }
      } finally {
        activeOperations.delete(staged.operationId)
      }
    })
  writes = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

/** Number of unresolved project creates for the exact current API identity. */
export async function pendingProjectSyncCount(config?: LuczorApiConfigSnapshot): Promise<number> {
  const current = config ?? (await LuczorApi.getConfigSnapshot())
  if (!current.baseUrl || !current.deviceKey || !current.clientId) return 0
  const scopeId = await apiScopeId(current)
  await reconcileProjectSyncEntries()
  return (await readEntries()).filter(entry => entry.scopeId === scopeId && entry.state === 'ready').length
}

async function flushProjectSyncQueueOnce(options: ProjectSyncFlushOptions): Promise<ProjectSyncFlushResult> {
  const config = options.config ?? (await LuczorApi.getConfigSnapshot())
  if (!config.baseUrl || !config.deviceKey || !config.clientId) return { attempted: 0, synced: 0, pending: 0 }
  const scopeId = await apiScopeId(config)
  await reconcileProjectSyncEntries()
  const now = Date.now()
  const candidates = (await readEntries())
    .filter(
      entry =>
        entry.scopeId === scopeId &&
        entry.state === 'ready' &&
        hasCommittedLocalProject(entry.externalId) &&
        (options.force || entry.nextAttemptAt <= now)
    )
    .sort((left, right) => left.queuedAt - right.queuedAt || left.externalId.localeCompare(right.externalId))
    .slice(0, boundedBatch(options.maxEntries))
  let attempted = 0
  let synced = 0

  for (const candidate of candidates) {
    if (options.signal?.aborted) break
    attempted++
    try {
      await LuczorApi.createProject(candidate.externalId, candidate.name, options.signal, config)
      await replaceEntries(entries =>
        entries.filter(
          entry =>
            entry.scopeId !== candidate.scopeId ||
            entry.operationId !== candidate.operationId ||
            entry.externalId !== candidate.externalId ||
            entry.queuedAt !== candidate.queuedAt
        )
      )
      synced++
    } catch {
      const attemptedAt = Date.now()
      await replaceEntries(entries =>
        entries.map(entry => {
          if (
            entry.scopeId !== candidate.scopeId ||
            entry.operationId !== candidate.operationId ||
            entry.externalId !== candidate.externalId ||
            entry.queuedAt !== candidate.queuedAt
          )
            return entry
          const attempts = entry.attempts + 1
          return {
            ...entry,
            attempts,
            lastAttemptAt: attemptedAt,
            nextAttemptAt: attemptedAt + retryDelay(attempts),
          }
        })
      )
      if (options.signal?.aborted) break
    }
  }

  const pending = (await readEntries()).filter(entry => entry.scopeId === scopeId && entry.state === 'ready').length
  return { attempted, synced, pending }
}

/**
 * Retry due entries in deterministic FIFO order. Calls are serialized so a
 * status heartbeat, a manual sync and a fresh project_create cannot POST the
 * same id concurrently. createProject is server-idempotent by external id.
 */
export function flushProjectSyncQueue(options: ProjectSyncFlushOptions = {}): Promise<ProjectSyncFlushResult> {
  const operation = flushes.catch(() => undefined).then(() => flushProjectSyncQueueOnce(options))
  flushes = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

/** Test-only simulation of losing all in-memory owners during an app crash. */
export function resetProjectSyncQueueRuntimeForTests(): void {
  if (import.meta.env.MODE === 'test') activeOperations.clear()
}
