// Unified desktop memory facade. The device is the privacy gate; Laravel is
// the canonical shared store and Cognee is only a rebuildable server index.

import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot, type VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import { memoryImportance, memoryPriority, MEMORY_PRIORITIES, type MemoryPriority } from './memoryPriority'
import { analyzeMemoryRecords, type MemoryAnalysis } from './memoryAnalysis'
import { trackMemoryActivity } from './activity'
import { trackMemoryUsage, type MemoryUsageOrigin } from './usage'
import {
  emptyMaintenanceJournal,
  maintenanceEligible,
  memoryRevision,
  MAINTENANCE_POLICY,
  type MaintenanceJournal,
  type MaintenanceSource,
  type MemoryChangeSet,
  type PreparedContextArtifact,
} from './maintenance'
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchBoundedResponseWithTimeout,
  fetchWithTimeout,
  type LuczorApiConfigSnapshot,
} from '@/services/api/luczorApi'

const SETTINGS_FILE = 'luczor.settings.json'
const MEMORY_FILE = 'luczor.memory.json'
const ENCRYPTED_STATE_KEY = 'state_v3_encrypted'
const PLAINTEXT_STATE_KEY = 'state_v2'
const LEGACY_KEY = 'records_v1'
const MAX_RECORDS = 5_000
const MAX_MEMORY_RESPONSE_BYTES = 1024 * 1024
let maintenanceWrites = 0
const maintenanceNonces = new Set<string>()
export function isMaintenanceWrite(value?: unknown): boolean {
  if (maintenanceWrites > 0) return true
  try {
    const envelope = typeof value === 'string' ? JSON.parse(value) : null
    return typeof envelope?.iv === 'string' && maintenanceNonces.has(envelope.iv)
  } catch {
    return false
  }
}

export type MemoryScope =
  'device' | 'private' | 'user' | 'project' | 'workspace' | 'skill' | 'agent' | 'session' | 'global'
export type MemoryVisibility = 'private' | 'syncable' | 'public'
export type MemoryStatus = 'candidate' | 'active' | 'superseded'
export type MemoryRetention = 'session' | 'durable' | 'permanent'
export type MemoryWriteIntent = 'explicit' | 'confirmed' | 'automatic' | 'inferred' | 'system'
export type MemorySensitivity = 'normal' | 'sensitive' | 'secret'

export type MemoryRecord = {
  id: string
  principalId: string
  serverId?: string
  serverVersionId?: number
  expectedPreviousServerVersionId?: number | null
  requiresServerVersionRefresh?: boolean
  scope: MemoryScope
  dataset: string
  content: string
  contentHash: string
  type: string
  visibility: MemoryVisibility
  status: MemoryStatus
  retention: MemoryRetention
  sensitivity: MemorySensitivity
  writeIntent: MemoryWriteIntent
  importance: number
  priority?: MemoryPriority
  confidence: number
  source: string
  tags: string[]
  createdAt: number
  updatedAt: number
  expiresAt?: number
  projectId?: string
  agentId?: string
  sessionId?: string
  featureKey?: string
  provenance?: Record<string, unknown>
  meta?: Record<string, unknown>
  synced?: boolean
  syncError?: string
  retrievalScore?: number
}

export type RememberInput = {
  content: string
  /** Bind reviewed imports to the account selected before asynchronous preparation. */
  expectedPrincipalId?: string
  scope?: MemoryScope
  projectId?: string
  agentId?: string
  sessionId?: string
  userId?: string
  featureKey?: string
  memoryKey?: string
  type?: string
  source?: string
  sourceRef?: string
  tags?: string[]
  meta?: Record<string, unknown>
  provenance?: Record<string, unknown>
  visibility?: MemoryVisibility
  importance?: number
  priority?: MemoryPriority
  confidence?: number
  writeIntent?: MemoryWriteIntent
  retention?: MemoryRetention
  sensitivity?: MemorySensitivity
}

export type RecallQuery = {
  origin?: MemoryUsageOrigin
  query: string
  scope?: MemoryScope
  projectId?: string
  agentId?: string
  sessionId?: string
  userId?: string
  limit?: number
}

type MemoryContext = {
  principalId: string
  scope: MemoryScope
  dataset: string
  projectId?: string
  agentId?: string
  sessionId?: string
  userId?: string
}

type MemoryOutboxEvent = {
  id: string
  principalId: string
  recordId: string
  operation: 'upsert' | 'delete'
  attempts: number
  nextAttemptAt: number
  createdAt: number
}

type MemoryTombstone = {
  principalId: string
  recordId: string
  serverId?: string
  scope: MemoryScope
  projectId?: string
  agentId?: string
  sessionId?: string
  createdAt: number
}

type MemoryState = {
  version: 2
  records: MemoryRecord[]
  outbox: MemoryOutboxEvent[]
  tombstones: MemoryTombstone[]
  maintenance?: Record<string, MaintenanceJournal>
}

type WritePlan = {
  status: MemoryStatus
  visibility: MemoryVisibility
  retention: MemoryRetention
  sensitivity: MemorySensitivity
  writeIntent: MemoryWriteIntent
  confidence: number
  localOnly: boolean
  reason: string
}

type ServerWriteResult = {
  decision?: 'accepted' | 'candidate' | 'local_only'
  id?: string
  status?: MemoryStatus
  projection_status?: string
  memory_link_id?: number
  persisted?: boolean
}

class MemoryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody?: unknown
  ) {
    super(`Memory HTTP ${status}`)
  }
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Accept only explicit server-version fields from a structured 409 response. */
function conflictVersionFromResponse(value: unknown, depth = 0): number | undefined {
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  for (const candidate of [body.current_memory_id, body.current_memory_link_id, body.source_record_id]) {
    const version = positiveInteger(candidate)
    if (version) return version
  }
  for (const nested of [body.current_memory, body.current, body.conflict, body.data, body.error]) {
    const version = conflictVersionFromResponse(nested, depth + 1)
    if (version) return version
  }
  return undefined
}

type ServerForgetResult = {
  forgotten: boolean
  already_absent: boolean
}

type MemoryOperationSnapshot = Readonly<{
  principalId: string
  config: LuczorApiConfigSnapshot | null
}>

const SECRET_TERMS = [
  'password',
  'passwort',
  'api key',
  'access token',
  'secret',
  'geheim',
  'kennwort',
  'private key',
  'authorization',
  'auth token',
  'iban',
  'kreditkart',
]
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
  /\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{12,}\b/iu,
]
const SECRET_KEY_ALIASES = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'authorization',
  'privatekey',
  'clientsecret',
  'dbpassword',
  'databasepassword',
  'credential',
]
const DLP_MAX_DEPTH = 8
const DLP_MAX_NODES = 1_024
const DLP_MAX_STRING_BYTES = 65_536
const EXPLICIT_MEMORY_PHRASES = ['merke', 'merk dir', 'remember', 'ab jetzt', 'künftig', 'zukünftig']
const LOCAL_SOURCE_TYPES = new Set(['repository', 'repository_graph', 'code_graph', 'raw_code', 'screen_secret'])

function normalizeForPolicy(content: string): string {
  return content.toLocaleLowerCase().split('_').join(' ').split('-').join(' ').split(/\s+/u).join(' ')
}

function containsSecretTerm(content: string): boolean {
  const normalized = normalizeForPolicy(content)
  return (
    SECRET_TERMS.some(term => normalized.includes(term)) || SECRET_VALUE_PATTERNS.some(pattern => pattern.test(content))
  )
}

function canonicalPolicyKey(key: string): { words: string; compact: string } {
  const words = key
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return { words, compact: words.replace(/[^\p{L}\p{N}]/gu, '') }
}

function containsSecretKey(key: string): boolean {
  const { words, compact } = canonicalPolicyKey(key)
  return SECRET_TERMS.some(term => words.includes(term)) || SECRET_KEY_ALIASES.some(alias => compact.includes(alias))
}

/**
 * Inspect JSON-like memory data without allowing hostile depth, size or cycles
 * to turn a privacy decision into an unbounded traversal. Unsupported values
 * and exhausted limits are sensitive by default (fail closed).
 */
export function containsSensitiveMemoryData(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0
  let stringBytes = 0
  const encoder = new TextEncoder()

  try {
    while (stack.length > 0) {
      const current = stack.pop()!
      nodes += 1
      if (nodes > DLP_MAX_NODES || current.depth > DLP_MAX_DEPTH) return true

      if (current.value == null || typeof current.value === 'boolean' || typeof current.value === 'number') continue
      if (typeof current.value === 'string') {
        stringBytes += encoder.encode(current.value).byteLength
        if (stringBytes > DLP_MAX_STRING_BYTES || containsSecretTerm(current.value)) return true
        continue
      }
      if (typeof current.value !== 'object') return true
      if (seen.has(current.value)) return true
      seen.add(current.value)

      const isArray = Array.isArray(current.value)
      const prototype = Object.getPrototypeOf(current.value)
      if (!isArray && prototype !== Object.prototype && prototype !== null) return true

      const entries = Object.entries(current.value)
      if (current.depth >= DLP_MAX_DEPTH && entries.length > 0) return true
      for (const [key, child] of entries) {
        if (containsSecretKey(key)) return true
        stack.push({ value: child, depth: current.depth + 1 })
        stack.push({ value: key, depth: current.depth + 1 })
      }
    }
  } catch {
    return true
  }

  return false
}

/**
 * Repository provenance is a privacy boundary, even when it is nested in
 * metadata and the top-level source was accidentally or maliciously set to
 * `user`. Complexity failures are local-only by default.
 */
function containsLocalRepositorySource(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()
  let nodes = 0

  try {
    while (stack.length > 0) {
      const current = stack.pop()!
      nodes += 1
      if (nodes > DLP_MAX_NODES || current.depth > DLP_MAX_DEPTH) return true
      if (current.value === null || typeof current.value !== 'object') continue
      if (seen.has(current.value)) return true
      seen.add(current.value)

      const isArray = Array.isArray(current.value)
      const prototype = Object.getPrototypeOf(current.value)
      if (!isArray && prototype !== Object.prototype && prototype !== null) return true

      const entries = Object.entries(current.value)
      if (current.depth >= DLP_MAX_DEPTH && entries.length > 0) return true
      for (const [key, child] of entries) {
        const normalizedKey = canonicalPolicyKey(key).compact
        if (
          (normalizedKey === 'source' || normalizedKey === 'sourcetype' || normalizedKey === 'origintype') &&
          typeof child === 'string' &&
          LOCAL_SOURCE_TYPES.has(child.trim().toLocaleLowerCase())
        ) {
          return true
        }
        stack.push({ value: child, depth: current.depth + 1 })
      }
    }
  } catch {
    return true
  }

  return false
}

function rememberInputDlpPayload(input: RememberInput): Record<string, unknown> {
  return {
    content: input.content,
    project_id: input.projectId,
    agent_id: input.agentId,
    session_id: input.sessionId,
    feature_key: input.featureKey ?? input.memoryKey,
    type: input.type,
    source_type: input.source,
    source_ref: input.sourceRef,
    tags: input.tags,
    provenance: input.provenance,
    meta: input.meta,
  }
}

function memoryRecordDlpPayload(record: MemoryRecord): Record<string, unknown> {
  return {
    content: record.content,
    external_id: record.id,
    project_id: record.projectId,
    agent_id: record.agentId,
    session_id: record.sessionId,
    feature_key: record.featureKey,
    type: record.type,
    source_type: record.source,
    source_ref: record.provenance?.source_ref,
    tags: record.tags,
    provenance: record.provenance,
    meta: record.meta,
  }
}

/** Only records that may safely cross a provider boundary enter normal recall. */
function isProviderSafeMemoryRecord(record: MemoryRecord): boolean {
  return (
    record.sensitivity !== 'secret' &&
    !containsSensitiveMemoryData(memoryRecordDlpPayload(record)) &&
    !recordWritePlan(record).localOnly
  )
}

function isExplicitMemory(content: string): boolean {
  const normalized = normalizeForPolicy(content)
  const words = new Set(normalized.split(' '))
  return (
    EXPLICIT_MEMORY_PHRASES.some(phrase => normalized.includes(phrase)) ||
    words.has('immer') ||
    words.has('nie') ||
    words.has('niemals')
  )
}

export function datasetFor(
  scope: MemoryScope,
  ids: { userId?: string; projectId?: string; agentId?: string; sessionId?: string }
): string {
  const user = ids.userId || 'local'
  switch (scope) {
    case 'device':
      return 'device:private'
    case 'private':
      return `device:private:${ids.projectId || 'global'}`
    case 'project':
      return `tenant:local:user:${user}:project:${ids.projectId || 'default'}`
    case 'workspace':
      return 'tenant:local:workspace'
    case 'skill':
      return `tenant:local:user:${user}:skills`
    case 'agent':
      return `tenant:local:user:${user}:agent:${ids.agentId || 'default'}:runs`
    case 'session':
      return `tenant:local:user:${user}:session:${ids.sessionId || 'default'}`
    case 'global':
      return 'global:curated'
    case 'user':
    default:
      return `tenant:local:user:${user}:private`
  }
}

export function classify(content: string): { visibility: MemoryVisibility; type: string } {
  const text = content.trim()
  if (containsSecretTerm(text)) return { visibility: 'private', type: 'fact' }
  if (/\b(fehler|error|exception|stack ?trace|bug)\b/i.test(text)) return { visibility: 'syncable', type: 'error' }
  if (/\b(skill|workflow|ablauf|vorgehen|anleitung)\b/i.test(text)) return { visibility: 'syncable', type: 'skill' }
  if (/\b(bevorzug|präferenz|preference|immer|nie)\b/i.test(text)) return { visibility: 'syncable', type: 'preference' }
  return { visibility: 'syncable', type: 'note' }
}

export function score(content: string): number {
  const text = content.trim()
  let value = 0.3
  if (text.length > 80) value += 0.2
  if (text.length > 240) value += 0.1
  if (/\b(wichtig|immer|nie|merke|regel|bevorzug|prefer)\b/i.test(text)) value += 0.25
  if (containsSecretTerm(text)) value += 0.1
  return clamp(value)
}

export function planMemoryWrite(input: RememberInput): WritePlan {
  const source = input.source ?? 'user'
  const classified = classify(input.content)
  const detectedSecret = containsSensitiveMemoryData(rememberInputDlpPayload(input))
  const sensitivity = detectedSecret ? 'secret' : (input.sensitivity ?? 'normal')
  let writeIntent = input.writeIntent ?? (source === 'assistant' || source === 'chat' ? 'automatic' : 'inferred')
  // Heuristics may classify an otherwise unspecified user command, but they
  // must never upgrade an explicit `automatic` capture from the chat loop.
  if (input.writeIntent === undefined && isExplicitMemory(input.content) && source === 'user') {
    writeIntent = 'explicit'
  }

  const repositoryDerived =
    LOCAL_SOURCE_TYPES.has(source.trim().toLocaleLowerCase()) ||
    containsLocalRepositorySource({ meta: input.meta, provenance: input.provenance })
  const privateScope = input.scope === 'device' || input.scope === 'private'
  const localOnly = privateScope || repositoryDerived || sensitivity === 'secret' || input.visibility === 'private'
  const candidate = writeIntent === 'automatic' || writeIntent === 'inferred'
  const status: MemoryStatus = candidate ? 'candidate' : 'active'
  const retention = input.retention ?? (candidate || input.scope === 'session' ? 'session' : 'durable')
  const visibility = localOnly || candidate ? 'private' : (input.visibility ?? classified.visibility)

  return {
    status,
    visibility,
    retention,
    sensitivity,
    writeIntent,
    confidence: clamp(input.confidence ?? (candidate ? 0.35 : 0.9)),
    localOnly: localOnly || candidate || retention === 'session',
    reason: repositoryDerived
      ? 'repository_local_only'
      : sensitivity === 'secret'
        ? 'secret_local_only'
        : candidate
          ? 'awaiting_confirmation'
          : 'confirmed_memory',
  }
}

function recordWritePlan(record: MemoryRecord, promoteCandidate = false): WritePlan {
  const requestedVisibility = promoteCandidate ? record.provenance?.requested_visibility : record.visibility
  const requestedRetention = promoteCandidate ? record.provenance?.requested_retention : record.retention
  const visibility =
    requestedVisibility === 'private' || requestedVisibility === 'syncable' || requestedVisibility === 'public'
      ? requestedVisibility
      : undefined
  const retention =
    requestedRetention === 'session' || requestedRetention === 'durable' || requestedRetention === 'permanent'
      ? requestedRetention
      : promoteCandidate && record.scope === 'session'
        ? 'session'
        : undefined

  return planMemoryWrite({
    content: record.content,
    scope: record.scope,
    projectId: record.projectId,
    agentId: record.agentId,
    sessionId: record.sessionId,
    featureKey: record.featureKey,
    type: record.type,
    source: record.source,
    sourceRef: typeof record.provenance?.source_ref === 'string' ? record.provenance.source_ref : undefined,
    tags: record.tags,
    meta: record.meta,
    provenance: record.provenance,
    visibility,
    importance: record.importance,
    confidence: record.confidence,
    writeIntent: promoteCandidate ? 'confirmed' : record.writeIntent,
    retention,
    sensitivity: record.sensitivity,
  })
}

class OfflineMemoryStore {
  private writes: Promise<unknown> = Promise.resolve()
  private encryptionKey: Promise<CryptoKey> | null = null

  private async load(): Promise<MemoryState> {
    try {
      const store = await Store.load(MEMORY_FILE)
      const encrypted = await store.get<string>(ENCRYPTED_STATE_KEY)
      if (encrypted) return normalizeState(await decryptMemoryState(encrypted, await this.key()))

      // One-time migration from the former plaintext store. The plaintext key
      // is removed in the same serialized operation after encryption succeeds.
      const current = await store.get<MemoryState>(PLAINTEXT_STATE_KEY)
      if (current?.version === 2) {
        const migrated = normalizeState(current)
        await this.saveToStore(store, migrated)
        return migrated
      }
      const legacy = (await store.get<Array<Partial<MemoryRecord>>>(LEGACY_KEY)) ?? []
      const migrated = normalizeState({
        version: 2,
        records: legacy.map(migrateLegacyRecord),
        outbox: [],
        tombstones: [],
      })
      if (legacy.length) await this.saveToStore(store, migrated)
      return migrated
    } catch {
      throw new Error('Local memory storage is unavailable; refusing to overwrite it.')
    }
  }

  private async save(state: MemoryState, maintenance = false): Promise<void> {
    const store = await Store.load(MEMORY_FILE)
    await this.saveToStore(store, normalizeState(state), maintenance)
  }

  private async saveToStore(store: Store, state: MemoryState, maintenance = false): Promise<void> {
    const encrypted = await encryptMemoryState(state, await this.key())
    if (maintenance) {
      maintenanceNonces.add((JSON.parse(encrypted) as { iv: string }).iv)
      if (maintenanceNonces.size > 32) maintenanceNonces.delete(maintenanceNonces.values().next().value!)
    }
    await store.set(ENCRYPTED_STATE_KEY, encrypted)
    await store.delete(PLAINTEXT_STATE_KEY)
    await store.delete(LEGACY_KEY)
    await store.save()
  }

  private key(): Promise<CryptoKey> {
    this.encryptionKey ??= invoke<string>('memory_key_get_or_create').then(seed => importMemoryKey(seed))
    return this.encryptionKey
  }

  private mutate<T>(operation: (state: MemoryState) => T | Promise<T>, maintenance = false): Promise<T> {
    const next = this.writes.then(async () => {
      const state = await this.load()
      const result = await operation(state)
      await this.save(state, maintenance)
      return result
    })
    this.writes = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  async maintenanceSnapshot(principalId: string) {
    await this.writes
    const state = await this.load()
    return {
      journal:
        (state.maintenance && Object.hasOwn(state.maintenance, principalId)
          ? (Reflect.get(state.maintenance, principalId) as MaintenanceJournal)
          : undefined) ?? emptyMaintenanceJournal(),
      records: state.records.filter(
        record => record.principalId === principalId && maintenanceEligible(record, Date.now(), true)
      ),
    }
  }

  async maintenanceTransaction<T>(
    principalId: string,
    operation: (journal: MaintenanceJournal, state: MemoryState) => Promise<T>
  ): Promise<T> {
    maintenanceWrites++
    return this.mutate(async state => {
      state.maintenance ??= {}
      const journal =
        (Object.hasOwn(state.maintenance, principalId)
          ? (Reflect.get(state.maintenance, principalId) as MaintenanceJournal)
          : undefined) ?? emptyMaintenanceJournal()
      Object.defineProperty(state.maintenance, principalId, {
        value: journal,
        writable: true,
        enumerable: true,
        configurable: true,
      })
      return operation(journal, state)
    }, true).finally(() => {
      maintenanceWrites--
    })
  }

  async remember(record: MemoryRecord, enqueueServer: boolean): Promise<MemoryRecord> {
    return this.mutate(state => {
      enqueueServer = enqueueServer && !containsSensitiveMemoryData(memoryRecordDlpPayload(record))
      const duplicate = state.records.find(
        item =>
          item.principalId === record.principalId &&
          item.contentHash === record.contentHash &&
          item.dataset === record.dataset &&
          item.status === record.status &&
          item.source === record.source &&
          item.writeIntent === record.writeIntent &&
          item.visibility === record.visibility &&
          item.retention === record.retention &&
          item.featureKey === record.featureKey &&
          (!enqueueServer || sameSyncedWrite(item, record))
      )
      if (duplicate) {
        // A persisted write ID is immutable. Repeated capture must not mutate
        // provenance/priority and replay a different fingerprint under that ID.
        if (enqueueServer) return duplicate
        duplicate.content = record.content
        duplicate.updatedAt = record.updatedAt
        duplicate.expiresAt = record.expiresAt
        duplicate.importance = Math.max(duplicate.importance, record.importance)
        duplicate.confidence = Math.max(duplicate.confidence, record.confidence)
        duplicate.source = record.source
        duplicate.tags = [...new Set([...duplicate.tags, ...record.tags])]
        duplicate.provenance = {
          ...(duplicate.provenance ?? {}),
          ...(record.provenance ?? {}),
          observation_count: Math.max(1, Number(duplicate.provenance?.observation_count ?? 1)) + 1,
        }
        duplicate.meta = { ...(duplicate.meta ?? {}), ...(record.meta ?? {}) }
        if (enqueueServer) {
          duplicate.synced = false
          if (
            !state.outbox.some(
              event =>
                event.operation === 'upsert' &&
                event.recordId === duplicate.id &&
                event.principalId === duplicate.principalId
            )
          ) {
            state.outbox.push(newOutboxEvent(duplicate.id, 'upsert', duplicate.principalId))
          }
        }
        return duplicate
      }

      if (record.status === 'active' && record.featureKey) {
        const previous = state.records
          .filter(
            item =>
              item.principalId === record.principalId &&
              item.dataset === record.dataset &&
              item.featureKey === record.featureKey &&
              item.status === 'active'
          )
          .sort((left, right) => right.updatedAt - left.updatedAt)[0]
        if (record.expectedPreviousServerVersionId === undefined) {
          // CAS is explicit even for a first local write. Unknown remote state
          // therefore conflicts instead of being silently overwritten.
          record.expectedPreviousServerVersionId = previous?.serverVersionId ?? null
        }
        for (const item of state.records) {
          if (
            item.principalId === record.principalId &&
            item.dataset === record.dataset &&
            item.featureKey === record.featureKey &&
            item.status === 'active'
          ) {
            item.status = 'superseded'
            item.updatedAt = Date.now()
          }
        }
      }
      state.records.push(record)
      if (enqueueServer) state.outbox.push(newOutboxEvent(record.id, 'upsert', record.principalId))
      pruneState(state)
      return record
    })
  }

  async recall(context: MemoryContext, query: string, limit: number, includePrivate = false): Promise<MemoryRecord[]> {
    const state = await this.load()
    const now = Date.now()
    const terms = queryTerms(query)
    return state.records
      .filter(
        record =>
          record.principalId === context.principalId && record.dataset === context.dataset && record.status === 'active'
      )
      .filter(record => !record.expiresAt || record.expiresAt > now)
      .filter(record => !state.tombstones.some(tombstone => tombstone.recordId === record.id))
      .filter(record =>
        includePrivate
          ? record.sensitivity !== 'secret' && !containsSensitiveMemoryData(memoryRecordDlpPayload(record))
          : isProviderSafeMemoryRecord(record)
      )
      .filter(record => matchesRecallQuery(record, query, terms))
      .map(record => ({ record, rank: memoryRank(record, terms) }))
      .sort((left, right) => right.rank - left.rank || right.record.updatedAt - left.record.updatedAt)
      .slice(0, limit)
      .map(item => item.record)
  }

  /** Pending local erasure and privacy decisions also govern remote recall. */
  async reconcileRecall(
    context: MemoryContext,
    local: MemoryRecord[],
    remote: MemoryRecord[]
  ): Promise<{ local: MemoryRecord[]; remote: MemoryRecord[] }> {
    await this.writes
    const state = await this.load()
    const scopedRecords = state.records.filter(
      record => record.principalId === context.principalId && record.dataset === context.dataset
    )
    const blockedIds = new Set<string>()
    const privateContent = new Set<string>()
    for (const tombstone of state.tombstones) {
      if (
        tombstone.principalId === context.principalId &&
        tombstone.scope === context.scope &&
        tombstone.projectId === context.projectId &&
        tombstone.agentId === context.agentId &&
        tombstone.sessionId === context.sessionId
      ) {
        blockedIds.add(tombstone.recordId)
        if (tombstone.serverId) blockedIds.add(tombstone.serverId)
      }
    }
    for (const record of scopedRecords) {
      if (record.status === 'superseded' || (record.status === 'active' && !isProviderSafeMemoryRecord(record))) {
        blockedIds.add(record.id)
        if (record.serverId) blockedIds.add(record.serverId)
      }
      if (record.status === 'active' && !isProviderSafeMemoryRecord(record)) {
        privateContent.add(normalizeRecallContent(record.content))
      }
    }
    const pendingFeatures = new Set(
      scopedRecords
        .filter(record => record.status === 'active' && !record.synced && record.featureKey)
        .map(record => record.featureKey)
    )
    const recalledLocalIds = new Set(local.map(record => record.id))
    const recalledContent = new Set(local.map(record => normalizeRecallContent(record.content)))
    const currentLocal = scopedRecords.filter(
      record =>
        (recalledLocalIds.has(record.id) || recalledContent.has(normalizeRecallContent(record.content))) &&
        record.status === 'active' &&
        (!record.expiresAt || record.expiresAt > Date.now()) &&
        !blockedIds.has(record.id) &&
        isProviderSafeMemoryRecord(record)
    )
    const eligibleRemote = remote.filter(
      record =>
        !blockedIds.has(record.id) &&
        !(record.serverId && blockedIds.has(record.serverId)) &&
        !privateContent.has(normalizeRecallContent(record.content)) &&
        !(record.featureKey && pendingFeatures.has(record.featureKey))
    )
    return {
      local: currentLocal,
      remote: eligibleRemote,
    }
  }

  async candidates(context: MemoryContext, limit: number): Promise<MemoryRecord[]> {
    const state = await this.load()
    const now = Date.now()
    return state.records
      .filter(
        record =>
          record.principalId === context.principalId &&
          record.dataset === context.dataset &&
          record.status === 'candidate'
      )
      .filter(record => !record.expiresAt || record.expiresAt > now)
      .filter(record => !state.tombstones.some(tombstone => tombstone.recordId === record.id))
      .filter(record => !containsSensitiveMemoryData(memoryRecordDlpPayload(record)))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
  }

  async promote(recordId: string, principalId: string): Promise<MemoryRecord | null> {
    return this.mutate(state => {
      const record = state.records.find(
        item => item.id === recordId && item.principalId === principalId && item.status === 'candidate'
      )
      if (!record) return null
      const plan = recordWritePlan(record, true)
      if (record.featureKey) {
        for (const item of state.records) {
          if (
            item.id !== record.id &&
            item.principalId === principalId &&
            item.dataset === record.dataset &&
            item.featureKey === record.featureKey &&
            item.status === 'active'
          ) {
            item.status = 'superseded'
            item.updatedAt = Date.now()
            queueRemoteDelete(state, item)
          }
        }
      }
      record.status = 'active'
      const sensitive = plan.sensitivity === 'secret' || containsSensitiveMemoryData(memoryRecordDlpPayload(record))
      record.sensitivity = sensitive ? 'secret' : plan.sensitivity
      record.retention = sensitive ? 'session' : plan.retention
      record.visibility = sensitive || plan.localOnly ? 'private' : plan.visibility
      record.writeIntent = plan.writeIntent
      record.confidence = Math.max(plan.confidence, 0.85)
      record.expiresAt = record.retention === 'session' ? Date.now() + 24 * 60 * 60_000 : undefined
      record.updatedAt = Date.now()
      record.provenance = { ...(record.provenance ?? {}), write_reason: plan.reason }
      state.outbox = state.outbox.filter(
        event =>
          !(event.operation === 'upsert' && event.recordId === record.id && event.principalId === record.principalId)
      )
      if (!plan.localOnly && !sensitive) {
        state.outbox.push(newOutboxEvent(record.id, 'upsert', principalId))
      }
      return record
    })
  }

  async forget(context: MemoryContext, recordId: string): Promise<void> {
    await this.mutate(state => {
      const record = state.records.find(
        item => item.principalId === context.principalId && item.dataset === context.dataset && item.id === recordId
      )
      const serverId = record?.serverId
      state.records = state.records.filter(
        item => !(item.principalId === context.principalId && item.dataset === context.dataset && item.id === recordId)
      )
      if (state.maintenance && Object.hasOwn(state.maintenance, context.principalId)) {
        const journal = Reflect.get(state.maintenance, context.principalId) as MaintenanceJournal
        journal.artifacts = journal.artifacts.filter(
          artifact => !artifact.sources.some(source => source.id === recordId)
        )
      }
      const needsRemoteDelete = !record || record.synced || !!record.serverId || record.visibility !== 'private'
      const hasDelete = state.outbox.some(
        event =>
          event.operation === 'delete' && event.recordId === recordId && event.principalId === context.principalId
      )
      if (
        needsRemoteDelete &&
        !state.tombstones.some(
          tombstone => tombstone.recordId === recordId && tombstone.principalId === context.principalId
        )
      ) {
        state.tombstones.push({
          principalId: context.principalId,
          recordId,
          serverId,
          scope: context.scope,
          projectId: context.projectId,
          agentId: context.agentId,
          sessionId: context.sessionId,
          createdAt: Date.now(),
        })
      }
      if (needsRemoteDelete && !hasDelete) {
        state.outbox.push(newOutboxEvent(recordId, 'delete', context.principalId))
      }
      pruneState(state)
    })
  }

  async dueOutbox(principalId: string, limit = 20): Promise<MemoryOutboxEvent[]> {
    const state = await this.load()
    const now = Date.now()
    const importance = new Map(state.records.map(record => [record.id, record.importance]))
    return state.outbox
      .filter(event => event.principalId === principalId && event.nextAttemptAt <= now)
      .sort(
        (left, right) =>
          Number(right.operation === 'delete') - Number(left.operation === 'delete') ||
          (importance.get(right.recordId) ?? 0) - (importance.get(left.recordId) ?? 0) ||
          left.createdAt - right.createdAt
      )
      .slice(0, limit)
  }

  async analyze(context: MemoryContext): Promise<MemoryAnalysis> {
    const state = await this.load()
    return analyzeMemoryRecords(
      state.records.filter(
        record =>
          record.principalId === context.principalId &&
          record.dataset === context.dataset &&
          record.sensitivity !== 'secret' &&
          !containsSensitiveMemoryData(memoryRecordDlpPayload(record)) &&
          !state.tombstones.some(
            tombstone => tombstone.principalId === context.principalId && tombstone.recordId === record.id
          )
      ),
      context.scope as 'user' | 'project'
    )
  }

  async recordForOutbox(recordId: string, principalId: string): Promise<MemoryRecord | undefined> {
    return (await this.load()).records.find(record => record.id === recordId && record.principalId === principalId)
  }

  async tombstoneForOutbox(recordId: string, principalId: string): Promise<MemoryTombstone | undefined> {
    return (await this.load()).tombstones.find(
      tombstone => tombstone.recordId === recordId && tombstone.principalId === principalId
    )
  }

  async acknowledge(eventId: string, serverId?: string, serverVersionId?: number): Promise<void> {
    await this.mutate(state => {
      const event = state.outbox.find(item => item.id === eventId)
      if (!event) return
      const record = state.records.find(item => item.id === event.recordId && item.principalId === event.principalId)
      if (record) {
        record.synced = true
        record.syncError = undefined
        if (serverId) record.serverId = serverId
        if (serverVersionId) record.serverVersionId = serverVersionId
        record.requiresServerVersionRefresh = false
      }
      // Retain the bounded erasure marker after acknowledgement: an older
      // in-flight recall can still deliver the pre-deletion SQL snapshot.
      // normalizeState expires acknowledged markers after 90 days.
      state.outbox = state.outbox.filter(item => item.id !== eventId)
    })
  }

  async quarantineSensitiveUpsert(eventId: string, recordId: string, principalId: string): Promise<void> {
    await this.mutate(state => {
      const record = state.records.find(item => item.id === recordId && item.principalId === principalId)
      if (record) {
        record.visibility = 'private'
        record.sensitivity = 'secret'
        record.retention = 'session'
        record.expiresAt = Date.now() + 24 * 60 * 60_000
        record.synced = false
        record.syncError = undefined
      }
      state.outbox = state.outbox.filter(item => item.id !== eventId)
    })
  }

  async quarantineLocalOnlyUpsert(
    eventId: string,
    recordId: string,
    principalId: string,
    plan: WritePlan
  ): Promise<void> {
    await this.mutate(state => {
      const record = state.records.find(item => item.id === recordId && item.principalId === principalId)
      if (record) {
        record.visibility = 'private'
        record.sensitivity = plan.sensitivity
        record.retention = plan.sensitivity === 'secret' ? 'session' : plan.retention
        record.expiresAt = record.retention === 'session' ? Date.now() + 24 * 60 * 60_000 : undefined
        record.synced = false
        record.syncError = undefined
        record.provenance = { ...(record.provenance ?? {}), write_reason: plan.reason }
      }
      state.outbox = state.outbox.filter(item => item.id !== eventId)
    })
  }

  async fail(eventId: string, error: unknown): Promise<void> {
    await this.mutate(state => {
      const event = state.outbox.find(item => item.id === eventId)
      if (!event) return
      event.attempts += 1
      event.nextAttemptAt = Date.now() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(event.attempts, 8))
      const record = state.records.find(item => item.id === event.recordId && item.principalId === event.principalId)
      if (record) record.syncError = String(error).slice(0, 500)
    })
  }

  async markVersionConflict(eventId: string, currentServerVersionId?: number): Promise<void> {
    await this.mutate(state => {
      const event = state.outbox.find(item => item.id === eventId)
      if (!event) return
      const record = state.records.find(item => item.id === event.recordId && item.principalId === event.principalId)
      if (record) {
        record.status = 'candidate'
        record.synced = false
        record.expectedPreviousServerVersionId = currentServerVersionId
        record.requiresServerVersionRefresh = currentServerVersionId === undefined
        record.syncError = 'Server memory changed; review this local version before promoting it.'
      }
      state.outbox = state.outbox.filter(item => item.id !== eventId)
    })
  }

  async confirmServerVersion(recordId: string, principalId: string, currentServerVersionId: number): Promise<void> {
    await this.mutate(state => {
      const record = state.records.find(
        item => item.id === recordId && item.principalId === principalId && item.status === 'candidate'
      )
      if (!record) return
      record.expectedPreviousServerVersionId = currentServerVersionId
      record.requiresServerVersionRefresh = false
      record.syncError = 'Server memory changed; this local version is ready for an explicit reviewed promotion.'
      record.updatedAt = Date.now()
    })
  }

  async pending(principalId: string): Promise<number> {
    return (await this.load()).outbox.filter(event => event.principalId === principalId).length
  }

  async inspect(principalId: string): Promise<MemoryRecord[]> {
    return (await this.load()).records.filter(record => record.principalId === principalId)
  }

  /**
   * One safe upgrade path for pre-v2 partitions: only the principal derived
   * from the currently authenticated Device Key may be moved. Unknown legacy
   * partitions stay quarantined instead of being guessed into an account.
   */
  async migrateVerifiedLegacyPrincipal(legacyPrincipalId: string, principalId: string): Promise<void> {
    if (!legacyPrincipalId || legacyPrincipalId === principalId) return
    await this.mutate(state => {
      for (const record of state.records) {
        if (record.principalId !== legacyPrincipalId) continue
        record.principalId = principalId
        record.dataset = datasetFor(record.scope, {
          userId: principalId,
          projectId: record.projectId,
          agentId: record.agentId,
          sessionId: record.sessionId,
        })
      }
      for (const event of state.outbox) {
        if (event.principalId === legacyPrincipalId) event.principalId = principalId
      }
      for (const tombstone of state.tombstones) {
        if (tombstone.principalId === legacyPrincipalId) tombstone.principalId = principalId
      }
      pruneState(state)
    })
  }
}

class ServerMemoryBackend {
  constructor(
    private baseUrl: string,
    private deviceKey: string,
    private clientId: string
  ) {}

  private async call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const { response, text } = await fetchBoundedResponseWithTimeout(
      `${this.baseUrl}/api/v1${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.deviceKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      },
      DEFAULT_FETCH_TIMEOUT_MS,
      MAX_MEMORY_RESPONSE_BYTES
    )
    if (!response.ok) {
      let responseBody: unknown = text
      if (text) {
        try {
          responseBody = JSON.parse(text)
        } catch {
          // Keep a non-JSON error body opaque; it is never copied into local memory.
        }
      }
      throw new MemoryHttpError(response.status, responseBody)
    }
    if (!text) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      return {} as T
    }
  }

  remember(record: MemoryRecord): Promise<ServerWriteResult> {
    const plan = recordWritePlan(record)
    if (plan.localOnly || containsSensitiveMemoryData(memoryRecordDlpPayload(record))) {
      return Promise.reject(new Error('Memory payload failed the local privacy policy.'))
    }

    return this.call('/memory/remember', {
      content: record.content,
      scope: record.scope,
      project_id: record.projectId,
      agent_id: record.agentId,
      session_id: record.sessionId,
      feature_key: record.featureKey,
      type: record.type,
      visibility: record.visibility,
      importance: record.importance,
      // Keep the exact numeric weight for older writes and stable fingerprints.
      // Named priorities are encoded in this same canonical importance value.
      priority:
        record.priority && MEMORY_PRIORITIES[record.priority].importance === record.importance
          ? record.priority
          : undefined,
      confidence: record.confidence,
      retention: record.retention,
      sensitivity: record.sensitivity,
      write_intent: record.writeIntent,
      source_type: record.source,
      source_ref: record.provenance?.source_ref,
      provenance: record.provenance,
      external_id: record.id,
      write_id: record.id,
      expected_previous_id: record.featureKey ? (record.expectedPreviousServerVersionId ?? null) : undefined,
      client_id: this.clientId,
      tags: record.tags,
      meta: record.meta,
    })
  }

  async recall(context: MemoryContext, query: string, limit: number): Promise<MemoryRecord[]> {
    const result = await this.call<{ data?: unknown }>('/memory/recall', {
      query,
      scope: context.scope,
      project_id: context.projectId,
      agent_id: context.agentId,
      session_id: context.sessionId,
      limit: Math.max(1, Math.min(20, Math.floor(limit))),
    })
    if (!Array.isArray(result.data)) return []
    return result.data.flatMap((value): MemoryRecord[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const item = value as Record<string, unknown>
      if (
        typeof item.content !== 'string' ||
        !item.content.trim() ||
        !['string', 'number'].includes(typeof item.id) ||
        !String(item.id).trim() ||
        (item.scope != null && item.scope !== context.scope) ||
        (item.project_id != null && item.project_id !== context.projectId) ||
        (item.agent_id != null && item.agent_id !== context.agentId) ||
        (item.session_id != null && item.session_id !== context.sessionId) ||
        (item.status != null && item.status !== 'active') ||
        (item.visibility != null && item.visibility !== 'syncable' && item.visibility !== 'public') ||
        (item.retention != null && item.retention !== 'durable' && item.retention !== 'permanent') ||
        (item.sensitivity != null && item.sensitivity !== 'normal' && item.sensitivity !== 'sensitive') ||
        (item.expires_at != null && (parseDate(item.expires_at) ?? 0) <= Date.now()) ||
        (item.valid_until != null && (parseDate(item.valid_until) ?? 0) <= Date.now()) ||
        (item.valid_from != null && (parseDate(item.valid_from) ?? Infinity) > Date.now()) ||
        containsSensitiveMemoryData(item) ||
        containsLocalRepositorySource(item)
      ) {
        return []
      }
      return [
        {
          id: String(item.id),
          principalId: context.principalId,
          serverId: String(item.id),
          serverVersionId: positiveInteger(item.source_record_id),
          scope: context.scope,
          dataset: context.dataset,
          content: item.content.trim(),
          contentHash: String(item.content_hash ?? ''),
          type: String(item.type ?? 'note'),
          visibility: 'syncable' as MemoryVisibility,
          status: 'active' as MemoryStatus,
          retention: 'durable' as MemoryRetention,
          sensitivity: 'normal' as MemorySensitivity,
          writeIntent: 'confirmed' as MemoryWriteIntent,
          importance: clamp(Number(item.importance ?? 0.5)),
          priority: memoryPriority(Number(item.importance ?? 0.5)),
          confidence: clamp(Number(item.confidence ?? 0.5)),
          source: String(item.source ?? 'server'),
          tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          createdAt: parseDate(item.recorded_at) ?? Date.now(),
          updatedAt: parseDate(item.recorded_at) ?? Date.now(),
          projectId: context.projectId,
          agentId: context.agentId,
          sessionId: context.sessionId,
          featureKey: typeof item.feature_key === 'string' ? item.feature_key : undefined,
          provenance: item.provenance as Record<string, unknown> | undefined,
          meta: item.meta as Record<string, unknown> | undefined,
          expiresAt: parseDate(item.expires_at) ?? parseDate(item.valid_until),
          retrievalScore: typeof item.retrieval_score === 'number' ? clamp(item.retrieval_score) : undefined,
          synced: true,
        },
      ]
    })
  }

  /**
   * Refresh the active version through the canonical, authorized SQL-backed
   * recall endpoint. Exact feature-key matching prevents a semantically
   * similar memory from being accepted as the CAS predecessor.
   */
  async refreshFeatureVersion(context: MemoryContext, record: MemoryRecord): Promise<number | undefined> {
    if (!record.featureKey) return undefined
    for (const query of [record.content, '']) {
      const result = await this.call<{ data?: Array<Record<string, unknown>> }>('/memory/recall', {
        query,
        scope: context.scope,
        project_id: context.projectId,
        agent_id: context.agentId,
        session_id: context.sessionId,
        limit: 20,
      })
      const versions = (result.data ?? [])
        .filter(item => item.feature_key === record.featureKey)
        .map(item => positiveInteger(item.source_record_id))
        .filter((version): version is number => version !== undefined)
      if (versions.length > 0) return Math.max(...versions)
    }
    return undefined
  }

  forget(context: MemoryContext, id: string): Promise<ServerForgetResult> {
    return this.call('/memory/forget', {
      external_id: id,
      scope: context.scope,
      project_id: context.projectId,
      agent_id: context.agentId,
      session_id: context.sessionId,
      client_id: this.clientId,
    })
  }

  improve(context: MemoryContext): Promise<unknown> {
    return this.call('/memory/improve', {
      scope: context.scope,
      project_id: context.projectId,
      agent_id: context.agentId,
      session_id: context.sessionId,
    })
  }

  maintenance<T>(
    context: MemoryContext,
    action: 'status' | 'sources' | 'apply' | 'receipt',
    data: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ data: T }> {
    return this.call(
      `/memory/maintenance/${action}`,
      { ...data, scope: context.scope, project_id: context.projectId },
      signal
    )
  }

  analyze(context: MemoryContext): Promise<{ data: MemoryAnalysis }> {
    return this.call('/memory/analyze', {
      scope: context.scope,
      project_id: context.scope === 'project' ? context.projectId : undefined,
    })
  }
}

export class LuczorMemoryService {
  private offline = new OfflineMemoryStore()
  private flushing: Promise<void> | null = null
  private sessionSecrets: MemoryRecord[] = []
  private migratedLegacyPrincipals = new Set<string>()
  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private syncRequestedDuringFlush = false
  private checkpoints = new Map<string, { content: string; at: number }>()

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.flushPendingSync())
    }
  }

  /** Main-view worker only. Private source text never enters the settings store or detached windows. */
  async maintenanceSnapshot(expectedPrincipalId: string) {
    if ((await this.operationSnapshot()).principalId !== expectedPrincipalId) throw new Error('scope_changed')
    const result = await this.offline.maintenanceSnapshot(expectedPrincipalId)
    if ((await this.operationSnapshot()).principalId !== expectedPrincipalId) throw new Error('scope_changed')
    return result
  }

  async sharedMaintenance<T>(
    principalId: string,
    scope: 'user' | 'project',
    projectId: string | undefined,
    action: 'status' | 'sources' | 'apply' | 'receipt',
    data: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<T> {
    signal.throwIfAborted()
    const snapshot = await this.operationSnapshot()
    if (snapshot.principalId !== principalId) throw new Error('scope_changed')
    const backend = await this.server(snapshot)
    if (!backend) throw new Error('server_disabled')
    if (action === 'apply') {
      const { journal } = await this.maintenanceSnapshot(principalId)
      if (
        !journal.consent?.automaticRewrite ||
        !journal.quality?.passed ||
        journal.quality.modelId !== data.model_id ||
        journal.quality.policy !== MAINTENANCE_POLICY ||
        containsSensitiveMemoryData(data)
      )
        throw new Error('shared_write_gate')
      data = {
        ...data,
        consent: true,
        quality: { passed: true, policy: journal.quality.policy, model_id: journal.quality.modelId },
      }
    }
    signal.throwIfAborted()
    const result = await backend.maintenance<T>(this.context(scope, { projectId }, principalId), action, data, signal)
    signal.throwIfAborted()
    if ((await this.operationSnapshot()).principalId !== principalId) throw new Error('scope_changed')
    return result.data
  }

  async updateMaintenance<T>(principalId: string, update: (journal: MaintenanceJournal) => T | Promise<T>): Promise<T> {
    return this.offline.maintenanceTransaction(principalId, async journal => {
      if ((await getVerifiedAccountSnapshot())?.principalId !== principalId) throw new Error('scope_changed')
      const result = await update(journal)
      if ((await getVerifiedAccountSnapshot())?.principalId !== principalId) throw new Error('scope_changed')
      return result
    })
  }

  async acknowledgeSharedMaintenance(
    principalId: string,
    retired: Array<{ external_id: string; version_id: number }>
  ): Promise<void> {
    await this.offline.maintenanceTransaction(principalId, async (journal, state) => {
      if ((await getVerifiedAccountSnapshot())?.principalId !== principalId) throw new Error('scope_changed')
      const removed = new Set<string>()
      for (const record of state.records) {
        if (
          record.principalId !== principalId ||
          !record.synced ||
          state.outbox.some(event => event.recordId === record.id)
        )
          continue
        if (
          !retired.some(
            item =>
              item.version_id === record.serverVersionId &&
              (item.external_id === record.id || item.external_id === record.serverId)
          )
        )
          continue
        removed.add(record.id)
        state.tombstones.push({
          principalId,
          recordId: record.id,
          serverId: record.serverId,
          scope: record.scope,
          projectId: record.projectId,
          createdAt: Date.now(),
        })
      }
      state.records = state.records.filter(record => record.principalId !== principalId || !removed.has(record.id))
      journal.artifacts = journal.artifacts.filter(artifact => !artifact.sources.some(source => removed.has(source.id)))
    })
  }

  /** One encrypted store commit includes results, source-CAS, receipts and completion; no old-text archive. */
  async applyMaintenance(input: {
    principalId: string
    jobId: string
    revision: string
    modelId: string
    catalogHash: string
    sources: MaintenanceSource[]
    artifact?: PreparedContextArtifact
    changes?: MemoryChangeSet
    signal: AbortSignal
    validate(): Promise<void>
  }): Promise<void> {
    await this.offline.maintenanceTransaction(input.principalId, async (journal, state) => {
      input.signal.throwIfAborted()
      await input.validate()
      if ((await getVerifiedAccountSnapshot())?.principalId !== input.principalId) throw new Error('scope_changed')
      const job = journal.jobs.find(item => item.id === input.jobId && item.revision === input.revision)
      if (!job || job.status !== 'running') throw new Error('stale_job')
      const records = state.records.filter(record => record.principalId === input.principalId)
      for (const source of input.sources.filter(item => item.kind === 'memory')) {
        const record = records.find(item => item.id === source.id)
        if (
          !record ||
          !maintenanceEligible(record, Date.now(), !!input.artifact) ||
          memoryRevision(record) !== source.revision ||
          state.tombstones.some(item => item.principalId === input.principalId && item.recordId === source.id)
        )
          throw new Error('stale_source')
      }
      let changed = 0
      let conflicts = 0
      for (const operation of input.changes?.operations ?? []) {
        if (operation.operation === 'noop') continue
        // New authority is account-local and model/policy-bound, never migrated from the old idle toggle.
        if (
          !journal.consent?.automaticRewrite ||
          !journal.quality?.passed ||
          journal.quality.modelId !== input.modelId ||
          journal.quality.catalogHash !== input.catalogHash ||
          journal.quality.policy !== MAINTENANCE_POLICY
        )
          throw new Error('quality_gate_required')
        if (containsSensitiveMemoryData(operation.content)) throw new Error('sensitive_candidate')
        const sources = operation.sources.map(id => records.find(record => record.id === id))
        if (sources.some(record => !record)) throw new Error('invalid_source')
        const original = sources[0]!
        if (sources.some(record => record!.dataset !== original.dataset || record!.scope !== original.scope))
          throw new Error('scope_merge_forbidden')
        const targets = operation.targets.map(id => records.find(record => record.id === id))
        if (
          targets.some(
            record =>
              !record ||
              record.visibility !== 'private' ||
              record.serverId ||
              record.serverVersionId ||
              record.synced ||
              state.outbox.some(event => event.recordId === record.id)
          )
        )
          throw new Error('adapter_write_unsupported')
        const now = Date.now()
        const id = uid()
        const derived: MemoryRecord = {
          ...original,
          id,
          content: operation.content,
          contentHash: await sha256(operation.content.replace(/\s+/g, ' ')),
          serverId: undefined,
          serverVersionId: undefined,
          expectedPreviousServerVersionId: undefined,
          requiresServerVersionRefresh: undefined,
          synced: false,
          syncError: undefined,
          visibility: 'private',
          source: 'assistant',
          writeIntent: 'inferred',
          status: 'active',
          confidence: Math.min(0.35, ...sources.map(source => source!.confidence)),
          expiresAt: sources.some(source => source!.expiresAt)
            ? Math.min(...sources.map(source => source!.expiresAt ?? Infinity))
            : undefined,
          retention: sources.some(source => source!.retention === 'session') ? 'session' : 'durable',
          type: operation.operation === 'conflict' ? 'memory_conflict' : 'memory_consolidation',
          tags: ['maintenance-derived'],
          createdAt: now,
          updatedAt: now,
          featureKey: undefined,
          provenance: {
            generated_locally: true,
            maintenance_policy: MAINTENANCE_POLICY,
            reviewed_locally: true,
            source_memory_ids: operation.sources,
            source_revisions: input.sources.map(({ content: _content, ...ref }) => ref),
            reason: operation.reason,
            model_id: input.modelId,
          },
          meta: undefined,
        }
        for (const target of targets) {
          state.records = state.records.filter(
            record => record.principalId !== input.principalId || record.id !== target!.id
          )
          journal.artifacts = journal.artifacts.filter(
            artifact => !artifact.sources.some(source => source.id === target!.id)
          )
          state.tombstones.push({
            principalId: input.principalId,
            recordId: target!.id,
            scope: target!.scope,
            projectId: target!.projectId,
            createdAt: now,
          })
        }
        state.records.push(derived)
        changed += targets.length || 1
        if (operation.operation === 'conflict') conflicts++
      }
      if (input.artifact) {
        if (containsSensitiveMemoryData(input.artifact.content)) throw new Error('sensitive_candidate')
        journal.artifacts = [...journal.artifacts.filter(item => item.id !== input.artifact!.id), input.artifact]
      }
      input.signal.throwIfAborted()
      await input.validate()
      if ((await getVerifiedAccountSnapshot())?.principalId !== input.principalId) throw new Error('scope_changed')
      job.status = 'completed'
      job.updatedAt = Date.now()
      journal.receipts = [
        ...journal.receipts,
        { id: job.id, revision: job.revision, at: Date.now(), modelId: input.modelId, changed, conflicts },
      ].slice(-2000)
    })
  }

  private async operationSnapshot(): Promise<MemoryOperationSnapshot> {
    const verified = await getVerifiedAccountSnapshot()
    if (!verified) return Object.freeze({ principalId: 'device-local', config: null })
    await this.migrateLegacyPrincipal(verified)
    return verified
  }

  private async migrateLegacyPrincipal(snapshot: VerifiedAccountSnapshot): Promise<void> {
    const legacyPrincipalId = `account:${await sha256(`${snapshot.config.baseUrl}\u0000${snapshot.config.deviceKey}`)}`
    if (this.migratedLegacyPrincipals.has(legacyPrincipalId)) return
    await this.offline.migrateVerifiedLegacyPrincipal(legacyPrincipalId, snapshot.principalId)
    this.migratedLegacyPrincipals.add(legacyPrincipalId)
  }

  private async server(snapshot: MemoryOperationSnapshot): Promise<ServerMemoryBackend | null> {
    if (!(await memoryUseServer())) return null
    const config = snapshot.config
    if (!config) return null
    return new ServerMemoryBackend(config.baseUrl, config.deviceKey, config.clientId)
  }

  private context(
    scope: MemoryScope,
    input: { projectId?: string; agentId?: string; sessionId?: string; userId?: string },
    principalId: string
  ): MemoryContext {
    const projectId = projectExternalIdForServer(input.projectId, principalId)
    return {
      principalId,
      scope,
      dataset: datasetFor(scope, { ...input, projectId, userId: principalId }),
      projectId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      userId: input.userId,
    }
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    return trackMemoryUsage('save', () => trackMemoryActivity('write', () => this.rememberOperation(input)))
  }

  private async rememberOperation(input: RememberInput): Promise<MemoryRecord> {
    const content = input.content.trim()
    if (!content) throw new Error('Memory content must not be empty.')
    const scope = input.scope ?? 'project'
    const classified = classify(content)
    const plan = planMemoryWrite({ ...input, scope })
    const snapshot = await this.operationSnapshot()
    const principalId = snapshot.principalId
    if (input.expectedPrincipalId !== undefined && input.expectedPrincipalId !== principalId) {
      throw new Error('The selected memory account changed before the write. Please review the import again.')
    }
    const context = this.context(scope, input, principalId)
    const now = Date.now()
    const record: MemoryRecord = {
      id: uid(),
      principalId,
      scope,
      dataset: context.dataset,
      content,
      contentHash: await sha256(content.replace(/\s+/g, ' ')),
      type: input.type ?? classified.type,
      visibility: plan.visibility,
      status: plan.status,
      retention: plan.retention,
      sensitivity: plan.sensitivity,
      writeIntent: plan.writeIntent,
      importance: memoryImportance(input.priority, input.importance ?? score(content)),
      priority: input.priority ?? memoryPriority(input.importance ?? score(content)),
      confidence: plan.confidence,
      source: input.source ?? 'user',
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      expiresAt: plan.retention === 'session' ? now + 24 * 60 * 60_000 : undefined,
      projectId: context.projectId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      featureKey: input.memoryKey ?? input.featureKey,
      provenance: {
        ...(input.provenance ?? {}),
        source_type: input.source ?? 'user',
        source_ref: input.sourceRef,
        captured_at: new Date(now).toISOString(),
        policy_version: 'desktop-memory-policy.v2',
        write_reason: plan.reason,
        requested_visibility: input.visibility,
        requested_retention: input.retention,
      },
      meta: input.meta,
      synced: false,
    }
    if (plan.sensitivity === 'secret' || containsSensitiveMemoryData(memoryRecordDlpPayload(record))) {
      // Secrets are usable for this process only. Even though the ordinary
      // store is encrypted, credentials must not become durable AI memory.
      record.retention = 'session'
      record.visibility = 'private'
      record.expiresAt = now + 24 * 60 * 60_000
      this.sessionSecrets.push(record)
      return record
    }
    const stored = await this.offline.remember(record, !plan.localOnly)
    if (!plan.localOnly && snapshot.config && (await memoryUseServer())) this.scheduleSync(stored.importance >= 0.95)
    return stored
  }

  /** Public intermediate text only, bound to the originally admitted account. */
  async captureCheckpoint(input: {
    content: string
    scope: 'user' | 'project'
    projectId?: string
    sessionId: string
    expectedPrincipalId: string
    final?: boolean
  }): Promise<MemoryRecord | null> {
    if (input.scope === 'project' && !input.projectId?.trim())
      throw new Error('A project is required for its checkpoint.')
    const snapshot = await this.operationSnapshot()
    if (snapshot.principalId !== input.expectedPrincipalId)
      throw new Error('The selected memory account changed before the checkpoint.')
    const content = input.content.trim().slice(0, 1500)
    if (content.length < 40) return null
    const key = JSON.stringify([snapshot.principalId, input.scope, input.projectId ?? null, input.sessionId])
    const previous = this.checkpoints.get(key)
    if (previous?.content === content || (!input.final && previous && Date.now() - previous.at < 15_000)) return null
    this.checkpoints.set(key, { content, at: Date.now() })
    if (this.checkpoints.size > 100) this.checkpoints.delete(this.checkpoints.keys().next().value!)
    try {
      return await this.remember({
        ...input,
        content,
        source: 'assistant',
        writeIntent: 'automatic',
        priority: 'normal',
        retention: 'session',
        tags: ['checkpoint'],
        sourceRef: input.sessionId,
      })
    } catch (error) {
      this.checkpoints.delete(key)
      throw error
    }
  }

  private scheduleSync(immediate = false): void {
    if (immediate) {
      void this.flushPendingSync()
      return
    }
    // Coalesce bursts; local encryption and durable outbox are already saved.
    if (this.syncTimer !== null) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      void this.flushPendingSync()
    }, 250)
  }

  async analyze(
    scope: 'user' | 'project',
    ids: { projectId?: string } = {}
  ): Promise<{ local: MemoryAnalysis; server: MemoryAnalysis | null; serverUnavailable?: boolean }> {
    return trackMemoryActivity('read', markFailed => this.analyzeOperation(scope, ids, markFailed))
  }

  /** Schedule canonical Cognee maintenance without transferring any local source content. */
  async scheduleImprovement(
    scope: 'user' | 'project',
    options: { projectId?: string; expectedPrincipalId: string; signal: AbortSignal }
  ): Promise<'scheduled' | 'not_scheduled' | 'unavailable'> {
    options.signal.throwIfAborted()
    const snapshot = await this.operationSnapshot()
    if (snapshot.principalId !== options.expectedPrincipalId) throw new Error('Memory account changed.')
    if (scope === 'project' && !options.projectId?.trim()) throw new Error('A project is required.')
    const backend = await this.server(snapshot)
    options.signal.throwIfAborted()
    if (!backend) return 'unavailable'
    const current = await getVerifiedAccountSnapshot()
    if (current?.principalId !== snapshot.principalId) throw new Error('Memory account changed.')
    options.signal.throwIfAborted()
    const result = await backend.improve(this.context(scope, options, snapshot.principalId))
    options.signal.throwIfAborted()
    if ((await getVerifiedAccountSnapshot())?.principalId !== snapshot.principalId)
      throw new Error('Memory account changed.')
    return result && typeof result === 'object' && 'scheduled' in result && result.scheduled === true
      ? 'scheduled'
      : 'not_scheduled'
  }

  private async analyzeOperation(
    scope: 'user' | 'project',
    ids: { projectId?: string },
    markFailed: () => void
  ): Promise<{ local: MemoryAnalysis; server: MemoryAnalysis | null; serverUnavailable?: boolean }> {
    if (scope === 'project' && !ids.projectId?.trim()) throw new Error('A project is required for memory analysis.')
    const snapshot = await this.operationSnapshot()
    const context = this.context(scope, scope === 'project' ? ids : {}, snapshot.principalId)
    const local = await this.offline.analyze(context)
    const backend = await this.server(snapshot)
    let server: MemoryAnalysis | null = null
    let serverUnavailable = false
    if (backend) {
      try {
        const response = await backend.analyze(context)
        server = response.data ?? null
        serverUnavailable = !server
      } catch {
        // Older backends and offline devices still have useful local analysis.
        // The account boundary below applies equally to this fallback.
        serverUnavailable = true
      }
    }
    const current = await getVerifiedAccountSnapshot()
    if ((current?.principalId ?? 'device-local') !== snapshot.principalId)
      throw new Error('The selected memory account changed during analysis.')
    if (serverUnavailable) markFailed()
    return { local, server, ...(serverUnavailable ? { serverUnavailable: true } : {}) }
  }

  async recall(query: RecallQuery): Promise<MemoryRecord[]> {
    return trackMemoryUsage(
      'sharedRecall',
      markUsageFailed =>
        trackMemoryActivity('read', markFailed =>
          this.recallOperation(query, () => {
            markFailed()
            markUsageFailed()
          })
        ),
      query.origin
    )
  }

  private async recallOperation(query: RecallQuery, markFailed: () => void): Promise<MemoryRecord[]> {
    const scope = query.scope ?? 'project'
    const snapshot = await this.operationSnapshot()
    const principalId = snapshot.principalId
    const context = this.context(scope, query, principalId)
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(20, Math.floor(query.limit!))) : 6
    const localPromise = this.offline.recall(context, query.query, limit * 2).catch(error => {
      markFailed()
      console.warn('[memory] encrypted local store unavailable:', error)
      return []
    })
    const serverPromise = this.server(snapshot)
      .then(server => (server ? server.recall(context, query.query, limit * 2) : []))
      .catch(error => {
        markFailed()
        console.warn('[memory] server recall failed, keeping local evidence:', error)
        return []
      })
    const [local, server] = await Promise.all([localPromise, serverPromise])
    const reconciled = await this.offline.reconcileRecall(context, local, server).catch(error => {
      markFailed()
      console.warn('[memory] local recall policy unavailable:', error)
      return { local: [], remote: [] }
    })
    // The verified request snapshot keeps reads partitioned, but its result
    // must not be delivered into an account selected while I/O was pending.
    const currentAccount = await getVerifiedAccountSnapshot()
    if ((currentAccount?.principalId ?? 'device-local') !== principalId) {
      markFailed()
      return []
    }
    return fuseMemories(
      reconciled.local.filter(isProviderSafeMemoryRecord),
      reconciled.remote.filter(isProviderSafeMemoryRecord),
      query.query,
      limit
    )
  }

  /** Device-only retrieval. No query, private record or result is sent to the context server. */
  async recallLocal(query: RecallQuery): Promise<MemoryRecord[]> {
    return trackMemoryUsage(
      'localRecall',
      markUsageFailed =>
        trackMemoryActivity('read', markFailed =>
          this.recallLocalOperation(query, () => {
            markFailed()
            markUsageFailed()
          })
        ),
      query.origin
    )
  }

  private async recallLocalOperation(query: RecallQuery, markFailed: () => void): Promise<MemoryRecord[]> {
    const snapshot = await this.operationSnapshot()
    const context = this.context(query.scope ?? 'project', query, snapshot.principalId)
    const limit = Number.isFinite(query.limit) ? Math.max(1, Math.min(20, Math.floor(query.limit!))) : 6
    const records = await this.offline.recall(context, query.query, limit, true)
    const current = await getVerifiedAccountSnapshot()
    if ((current?.principalId ?? 'device-local') !== snapshot.principalId) {
      markFailed()
      return []
    }
    return fuseMemories(records, [], query.query, limit)
  }

  async promote(recordId: string): Promise<MemoryRecord | null> {
    return trackMemoryActivity('write', () => this.promoteOperation(recordId))
  }

  private async promoteOperation(recordId: string): Promise<MemoryRecord | null> {
    const snapshot = await this.operationSnapshot()
    const candidate = await this.offline.recordForOutbox(recordId, snapshot.principalId)
    if (candidate?.status === 'candidate' && candidate.featureKey && candidate.requiresServerVersionRefresh) {
      const server = await this.server(snapshot)
      if (!server) {
        throw new Error(
          'The current server memory version could not be verified; keeping the local memory as a candidate.'
        )
      }
      const currentServerVersionId = await server.refreshFeatureVersion(
        this.context(candidate.scope, candidate, snapshot.principalId),
        candidate
      )
      if (!currentServerVersionId) {
        throw new Error(
          'The current server memory version could not be verified; keeping the local memory as a candidate.'
        )
      }
      await this.offline.confirmServerVersion(recordId, snapshot.principalId, currentServerVersionId)
    }
    const record = await this.offline.promote(recordId, snapshot.principalId)
    if (record && !recordWritePlan(record).localOnly) void this.flushPendingSync()
    return record
  }

  async listCandidates(projectId: string, limit = 8): Promise<MemoryRecord[]> {
    return trackMemoryActivity('read', () => this.listCandidatesOperation(projectId, limit))
  }

  private async listCandidatesOperation(projectId: string, limit: number): Promise<MemoryRecord[]> {
    if (!projectId.trim()) throw new Error('A project is required for memory candidates.')
    const snapshot = await this.operationSnapshot()
    const principalId = snapshot.principalId
    const records = await this.offline.candidates(
      this.context('project', { projectId }, principalId),
      Math.max(1, Math.min(30, limit))
    )
    const current = await getVerifiedAccountSnapshot()
    if ((current?.principalId ?? 'device-local') !== principalId) return []
    return records
  }

  async forget(
    scope: MemoryScope,
    id: string,
    ids: { userId?: string; projectId?: string; agentId?: string; sessionId?: string } = {}
  ): Promise<void> {
    return trackMemoryActivity('write', () => this.forgetOperation(scope, id, ids))
  }

  private async forgetOperation(
    scope: MemoryScope,
    id: string,
    ids: { userId?: string; projectId?: string; agentId?: string; sessionId?: string }
  ): Promise<void> {
    const snapshot = await this.operationSnapshot()
    const principalId = snapshot.principalId
    const secretIndex = this.sessionSecrets.findIndex(record => record.id === id && record.principalId === principalId)
    if (secretIndex >= 0) {
      this.sessionSecrets.splice(secretIndex, 1)
      return
    }
    await this.offline.forget(this.context(scope, ids, principalId), id)
    void this.flushPendingSync()
  }

  async improve(
    scope: MemoryScope,
    ids: { userId?: string; projectId?: string; agentId?: string; sessionId?: string } = {}
  ): Promise<void> {
    if (scope === 'device' || scope === 'private' || scope === 'session') return
    const snapshot = await this.operationSnapshot()
    try {
      const server = await this.server(snapshot)
      if (server) await server.improve(this.context(scope, ids, snapshot.principalId))
    } catch (error) {
      console.warn('[memory] improve failed:', error)
    }
  }

  async flushPendingSync(): Promise<void> {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    if (this.flushing) {
      this.syncRequestedDuringFlush = true
      return this.flushing
    }
    this.flushing = this.flushOutbox().finally(() => {
      this.flushing = null
      if (this.syncRequestedDuringFlush) {
        this.syncRequestedDuringFlush = false
        this.scheduleSync()
      }
    })
    return this.flushing
  }

  private async flushOutbox(): Promise<void> {
    const snapshot = await this.operationSnapshot()
    const server = await this.server(snapshot)
    if (!server) return
    const principalId = snapshot.principalId
    for (const event of await this.offline.dueOutbox(principalId)) {
      try {
        if (event.operation === 'upsert') {
          const record = await this.offline.recordForOutbox(event.recordId, principalId)
          if (!record || record.status !== 'active') {
            await this.offline.acknowledge(event.id)
            continue
          }
          if (containsSensitiveMemoryData(memoryRecordDlpPayload(record))) {
            await this.offline.quarantineSensitiveUpsert(event.id, record.id, principalId)
            continue
          }
          const plan = recordWritePlan(record)
          if (plan.localOnly) {
            await this.offline.quarantineLocalOnlyUpsert(event.id, record.id, principalId, plan)
            continue
          }
          const result = await server.remember(record)
          if (result.decision === 'local_only' || result.persisted === false) {
            await this.offline.quarantineLocalOnlyUpsert(event.id, record.id, principalId, {
              ...plan,
              localOnly: true,
              visibility: 'private',
              reason: 'server_local_only',
            })
            continue
          }
          await this.offline.acknowledge(event.id, result.id, result.memory_link_id)
        } else {
          const tombstone = await this.offline.tombstoneForOutbox(event.recordId, principalId)
          if (!tombstone) {
            throw new Error('Delete tombstone is missing; refusing to acknowledge remote erasure.')
          }
          const context = this.context(tombstone.scope, tombstone, principalId)
          const result = await server.forget(context, tombstone.serverId ?? tombstone.recordId)
          if (result.forgotten !== true && result.already_absent !== true) {
            throw new Error('Server did not confirm that the memory was erased or already absent.')
          }
          await this.offline.acknowledge(event.id)
        }
      } catch (error) {
        if (event.operation === 'upsert' && error instanceof MemoryHttpError && error.status === 409) {
          const record = await this.offline.recordForOutbox(event.recordId, principalId)
          let currentServerVersionId = conflictVersionFromResponse(error.responseBody)
          if (!currentServerVersionId && record?.featureKey) {
            currentServerVersionId = await server
              .refreshFeatureVersion(this.context(record.scope, record, principalId), record)
              .catch(() => undefined)
          }
          await this.offline.markVersionConflict(event.id, currentServerVersionId)
          continue
        }
        await this.offline.fail(event.id, error)
      }
    }
  }

  classify = classify
  score = score
  planWrite = planMemoryWrite

  async getContextForPrompt(projectId: string, query: string, limit = 5): Promise<string> {
    const hits = await this.recall({ scope: 'project', projectId, query, limit })
    if (!hits.length) return ''
    return `Relevante bestätigte Erinnerungen:\n${hits.map(hit => `- ${hit.content}`).join('\n')}`
  }

  async pendingSyncCount(): Promise<number> {
    const snapshot = await this.operationSnapshot()
    return this.offline.pending(snapshot.principalId)
  }

  /** Read-only, account-bound inventory. Inspector reads never count as AI retrieval. */
  async inspectLocal(options: { projectId?: string; query?: string; offset?: number; limit?: number } = {}) {
    const snapshot = await this.operationSnapshot()
    const all = await this.offline.inspect(snapshot.principalId)
    const projectId = options.projectId
      ? projectExternalIdForServer(options.projectId, snapshot.principalId)
      : undefined
    const query = (options.query ?? '').slice(0, 256).toLocaleLowerCase('de')
    const records = all
      .filter(
        record =>
          (!projectId || record.projectId === projectId) &&
          (!query ||
            `${record.sensitivity === 'normal' ? record.content : ''} ${record.type} ${record.scope}`
              .toLocaleLowerCase('de')
              .includes(query))
      )
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    const offset = Math.max(0, Math.floor(options.offset ?? 0) || 0)
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 120) || 120))
    const pending = await this.offline.pending(snapshot.principalId)
    const current = await getVerifiedAccountSnapshot()
    if ((current?.principalId ?? 'device-local') !== snapshot.principalId) throw new Error('Account changed')
    const knownIds = new Set(all.map(record => record.id))
    return {
      total: all.length,
      filtered: records.length,
      offset,
      pending,
      active: all.filter(record => record.status === 'active').length,
      candidates: all.filter(record => record.status === 'candidate').length,
      synced: all.filter(record => record.synced).length,
      records: records.slice(offset, offset + limit).map(record => ({
        id: record.id,
        content:
          record.sensitivity === 'normal' && !containsSensitiveMemoryData(record.content)
            ? record.content.slice(0, 4000)
            : '[Geschützter Inhalt]',
        ...(record.content.length > 4000 ? { truncated: true } : {}),
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        ...(Array.isArray(record.provenance?.source_memory_ids)
          ? {
              sourceIds: record.provenance.source_memory_ids
                .filter((id): id is string => typeof id === 'string' && knownIds.has(id) && id !== record.id)
                .slice(0, 64),
            }
          : {}),
        scope: record.scope,
        type: record.type,
        status: record.status,
        source: record.source,
        projectId: record.projectId,
        visibility: record.visibility,
        retention: record.retention,
        confidence: record.confidence,
        updatedAt: record.updatedAt,
        synced: !!record.synced,
      })),
    }
  }

  async memoryHealth(): Promise<boolean | null> {
    if (!(await memoryUseServer())) return null
    try {
      const snapshot = await this.operationSnapshot()
      const config = snapshot.config
      if (!config) return null
      const response = await fetchWithTimeout(`${config.baseUrl}/api/v1/health`)
      return response.ok
    } catch {
      return false
    }
  }
}

export const luczorMemory = new LuczorMemoryService()

export async function getMemoryPrefs(): Promise<{
  inject: boolean
  injectCount: number
  autoRemember: boolean
}> {
  try {
    const store = await Store.load(SETTINGS_FILE)
    return {
      inject: (await store.get<boolean>('memory_inject')) ?? true,
      injectCount: (await store.get<number>('memory_inject_count')) ?? 5,
      autoRemember: (await store.get<boolean>('memory_auto_remember')) ?? true,
    }
  } catch {
    return { inject: true, injectCount: 5, autoRemember: true }
  }
}

async function memoryUseServer(): Promise<boolean> {
  try {
    const store = await Store.load(SETTINGS_FILE)
    return (await store.get<boolean>('memory_use_server')) ?? true
  } catch {
    return true
  }
}

function normalizeState(state: MemoryState): MemoryState {
  const now = Date.now()
  const records = (state.records ?? []).map(record => ({
    ...record,
    principalId: record.principalId || 'legacy-quarantine',
  }))
  const principalByRecord = new Map(records.map(record => [record.id, record.principalId]))
  const outbox = (state.outbox ?? []).map(event => ({
    ...event,
    principalId: event.principalId || principalByRecord.get(event.recordId) || 'legacy-quarantine',
  }))
  const protectedRecordIds = new Set(outbox.filter(event => event.operation === 'upsert').map(event => event.recordId))
  const eligibleRecords = records
    .filter(record => record.status !== 'superseded' || record.updatedAt > now - 90 * 24 * 60 * 60_000)
    .filter(record => !record.expiresAt || record.expiresAt > now - 7 * 24 * 60 * 60_000)
  const protectedRecords = eligibleRecords.filter(record => protectedRecordIds.has(record.id))
  const recentRecords = eligibleRecords.filter(record => !protectedRecordIds.has(record.id)).slice(-MAX_RECORDS)
  const pendingDeletes = new Set(
    outbox.filter(event => event.operation === 'delete').map(event => `${event.principalId}:${event.recordId}`)
  )
  const tombstones = (state.tombstones ?? []).map(item => ({
    ...item,
    principalId: item.principalId || principalByRecord.get(item.recordId) || 'legacy-quarantine',
  }))
  const protectedTombstones = tombstones.filter(item => pendingDeletes.has(`${item.principalId}:${item.recordId}`))
  const recentTombstones = tombstones
    .filter(item => !pendingDeletes.has(`${item.principalId}:${item.recordId}`))
    .filter(item => item.createdAt > now - 90 * 24 * 60 * 60_000)
    .slice(-MAX_RECORDS)

  return {
    version: 2,
    maintenance: state.maintenance ?? {},
    records: [...recentRecords, ...protectedRecords].filter(
      (record, index, all) => all.findIndex(candidate => candidate.id === record.id) === index
    ),
    // Pending synchronization and erasure are reliability obligations, not a
    // cache: never discard them merely because a size/age threshold elapsed.
    outbox,
    tombstones: [...recentTombstones, ...protectedTombstones].filter(
      (item, index, all) =>
        all.findIndex(
          candidate => candidate.recordId === item.recordId && candidate.principalId === item.principalId
        ) === index
    ),
  }
}

function pruneState(state: MemoryState): void {
  const normalized = normalizeState(state)
  state.records = normalized.records
  state.outbox = normalized.outbox
  state.tombstones = normalized.tombstones
}

function migrateLegacyRecord(record: Partial<MemoryRecord>): MemoryRecord {
  const now = Date.now()
  const scope = record.scope ?? 'project'
  const content = String(record.content ?? '')
  return {
    id: record.id ?? uid(),
    principalId: record.principalId ?? 'legacy-quarantine',
    scope,
    dataset: record.dataset ?? datasetFor(scope, { projectId: record.projectId }),
    content,
    contentHash: record.contentHash ?? fallbackHash(content),
    type: record.type ?? 'note',
    visibility: record.visibility ?? 'private',
    status: record.status ?? 'active',
    retention: record.retention ?? 'durable',
    sensitivity: record.sensitivity ?? 'normal',
    writeIntent: record.writeIntent ?? 'confirmed',
    importance: clamp(record.importance ?? 0.5),
    confidence: clamp(record.confidence ?? 0.5),
    source: record.source ?? 'legacy',
    tags: record.tags ?? [],
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? record.createdAt ?? now,
    projectId: record.projectId,
    featureKey: record.featureKey,
    serverId: record.serverId,
    serverVersionId: record.serverVersionId,
    expectedPreviousServerVersionId: record.expectedPreviousServerVersionId,
    requiresServerVersionRefresh: record.requiresServerVersionRefresh,
    meta: record.meta,
    synced: record.synced,
  }
}

function newOutboxEvent(
  recordId: string,
  operation: MemoryOutboxEvent['operation'],
  principalId: string
): MemoryOutboxEvent {
  return { id: uid(), principalId, recordId, operation, attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now() }
}

function queueRemoteDelete(state: MemoryState, record: MemoryRecord): void {
  if (!record.synced && !record.serverId) return
  if (
    state.outbox.some(
      event => event.operation === 'delete' && event.recordId === record.id && event.principalId === record.principalId
    )
  ) {
    return
  }
  if (
    !state.tombstones.some(
      tombstone => tombstone.recordId === record.id && tombstone.principalId === record.principalId
    )
  ) {
    state.tombstones.push({
      principalId: record.principalId,
      recordId: record.id,
      serverId: record.serverId,
      scope: record.scope,
      projectId: record.projectId,
      agentId: record.agentId,
      sessionId: record.sessionId,
      createdAt: Date.now(),
    })
  }
  state.outbox.push(newOutboxEvent(record.id, 'delete', record.principalId))
}

function sameSyncedWrite(left: MemoryRecord, right: MemoryRecord): boolean {
  const payload = (record: MemoryRecord) => ({
    importance: record.importance,
    confidence: record.confidence,
    source: record.source,
    visibility: record.visibility,
    retention: record.retention,
    sensitivity: record.sensitivity,
    writeIntent: record.writeIntent,
    type: record.type,
    tags: record.tags,
    meta: record.meta,
    provenance: Object.fromEntries(
      Object.entries(record.provenance ?? {}).filter(([key]) => key !== 'captured_at' && key !== 'observation_count')
    ),
  })
  return JSON.stringify(payload(left)) === JSON.stringify(payload(right))
}

function fuseMemories(local: MemoryRecord[], server: MemoryRecord[], query: string, limit: number): MemoryRecord[] {
  const byContent = new Map<string, MemoryRecord>()
  for (const record of [...local, ...server]) {
    // Local fallback hashes and canonical SQL SHA-256 hashes are not comparable.
    // Compare the actual normalized content instead of trusting transport hashes.
    const key = normalizeRecallContent(record.content)
    const existing = byContent.get(key)
    if (
      !existing ||
      record.confidence + record.importance > existing.confidence + existing.importance ||
      (record.confidence + record.importance === existing.confidence + existing.importance &&
        record.updatedAt >= existing.updatedAt)
    ) {
      byContent.set(key, record)
    }
  }
  const terms = queryTerms(query)
  const ranked = [...byContent.values()]
    .filter(record => matchesRecallQuery(record, query, terms))
    .map(record => ({ record, rank: memoryRank(record, terms) }))
    .sort((left, right) => right.rank - left.rank || right.record.updatedAt - left.record.updatedAt)
  const features = new Set<string>()
  return ranked
    .filter(({ record }) => {
      if (!record.featureKey) return true
      if (features.has(record.featureKey)) return false
      features.add(record.featureKey)
      return true
    })
    .slice(0, limit)
    .map(({ record }) => record)
}

function memoryRank(record: MemoryRecord, terms: string[]): number {
  const lexical = lexicalRecallScore(record, terms)
  const semantic = record.source === 'cognee_revalidated' ? (record.retrievalScore ?? 0.5) : 0
  return Math.max(lexical, semantic) * 0.6 + record.importance * 0.2 + record.confidence * 0.2
}

function normalizeRecallContent(content: string): string {
  return content.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

const RECALL_STOP_WORDS = new Set([
  'aber',
  'als',
  'am',
  'an',
  'auch',
  'auf',
  'aus',
  'bei',
  'bitte',
  'das',
  'dass',
  'den',
  'der',
  'des',
  'die',
  'dies',
  'diese',
  'dieser',
  'dieses',
  'du',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'es',
  'für',
  'hat',
  'ich',
  'im',
  'in',
  'ist',
  'kann',
  'kannst',
  'mit',
  'mir',
  'nach',
  'noch',
  'oder',
  'sich',
  'sie',
  'sind',
  'und',
  'uns',
  'vom',
  'von',
  'vor',
  'war',
  'was',
  'welche',
  'welcher',
  'wie',
  'wir',
  'zu',
  'zum',
  'zur',
  'and',
  'are',
  'for',
  'from',
  'how',
  'is',
  'it',
  'of',
  'on',
  'please',
  'the',
  'this',
  'to',
  'what',
  'with',
  'you',
])

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .normalize('NFKC')
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(term => term.length >= 2 && !RECALL_STOP_WORDS.has(term))
    ),
  ]
}

function lexicalRecallScore(record: MemoryRecord, terms: string[]): number {
  if (!terms.length) return 0
  const tokens = queryTerms([record.content, record.featureKey ?? '', ...record.tags].join(' '))
  const matches = terms.filter(term =>
    tokens.some(token => token === term || (term.length >= 4 && token.startsWith(term)))
  )
  return matches.length / terms.length
}

function matchesRecallQuery(record: MemoryRecord, query: string, terms: string[]): boolean {
  return !query.trim() || lexicalRecallScore(record, terms) > 0 || record.source === 'cognee_revalidated'
}

function parseDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5))
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

async function importMemoryKey(seed: string): Promise<CryptoKey> {
  if (!/^[a-f0-9]{64}$/i.test(seed)) throw new Error('Invalid OS memory encryption key.')
  const raw = new Uint8Array(seed.match(/.{2}/g)!.map(value => Number.parseInt(value, 16)))
  return globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encryptMemoryState(state: MemoryState, key: CryptoKey): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const additionalData = new TextEncoder().encode('luczor-memory-state-v3')
  const plaintext = new TextEncoder().encode(JSON.stringify(state))
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext)
  return JSON.stringify({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  })
}

async function decryptMemoryState(payload: string, key: CryptoKey): Promise<MemoryState> {
  const envelope = JSON.parse(payload) as {
    version?: number
    algorithm?: string
    iv?: string
    ciphertext?: string
  }
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('Unsupported encrypted memory envelope.')
  }
  const additionalData = new TextEncoder().encode('luczor-memory-state-v3')
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData },
    key,
    base64ToBytes(envelope.ciphertext)
  )
  const state = JSON.parse(new TextDecoder().decode(plaintext)) as MemoryState
  if (state.version !== 2 || !Array.isArray(state.records) || !Array.isArray(state.outbox)) {
    throw new Error('Encrypted memory payload is invalid.')
  }
  return state
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return globalThis.btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function sha256(value: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(value)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return fallbackHash(value)
  }
}

function fallbackHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0)
    .toString(16)
    .padStart(8, '0')
    .repeat(8)
}
