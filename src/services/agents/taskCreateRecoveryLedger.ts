import { Store } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import type { PendingTaskCreateVerification } from './chatCheckpoint'

const STORE_FILE = 'luczor.pending-task-create.json'
const STORE_KEY = 'entries'
const STORE_VERSION = 1
const ENVELOPE_VERSION = 1
const MAX_ENTRIES = 500
const MAX_RESOLVED_ENTRIES = 5_000
const MAX_ENCRYPTED_BYTES = 1_000_000
const ADDITIONAL_DATA = new TextEncoder().encode('luczor-task-create-recovery-v1')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256 = /^[0-9a-f]{64}$/u

type StoredPendingTaskCreate = Omit<
  PendingTaskCreateVerification,
  'fingerprint' | 'fingerprintHash' | 'taskId' | 'resourceId' | 'state'
> & {
  kind: 'task' | 'conversation'
  principalScopeId: string
  fingerprintHash: string
  updatedAt: string
  state: PendingTaskCreateVerification['state'] | 'resolved'
}

type StoredDocument = {
  version: typeof STORE_VERSION
  entries: StoredPendingTaskCreate[]
}

type EncryptedEnvelope = {
  version: typeof ENVELOPE_VERSION
  algorithm: 'AES-256-GCM'
  initializationVector: string
  ciphertext: string
}

let writes: Promise<void> = Promise.resolve()
let encryptionKey: Promise<CryptoKey> | undefined

function serializeLedgerOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  const queued = writes.catch(() => {}).then(operation)
  writes = queued.then(
    () => undefined,
    () => undefined
  )
  return queued
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalize(value: unknown): StoredPendingTaskCreate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const principalScopeId = text(item.principalScopeId, 1_000)
  const projectId = text(item.projectId, 200)
  const title = text(item.title, 240)
  const externalId = text(item.externalId, 64)
  const fingerprintHash = text(item.fingerprintHash, 64).toLowerCase()
  const state = item.state
  const kind = item.kind === undefined ? 'task' : item.kind
  if (
    !principalScopeId ||
    !projectId ||
    !title ||
    !UUID.test(externalId) ||
    !SHA256.test(fingerprintHash) ||
    (kind !== 'task' && kind !== 'conversation') ||
    !['unknown', 'verified_absent', 'verified_present', 'resolved'].includes(String(state))
  )
    return null
  return {
    kind,
    principalScopeId,
    projectId,
    title,
    externalId,
    fingerprintHash,
    state: state as StoredPendingTaskCreate['state'],
    updatedAt: text(item.updatedAt, 64) || new Date(0).toISOString(),
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0)
    throw new Error('Der verschlüsselte task_create-Recovery-Speicher ist beschädigt.')
  const binary = atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function recoveryEncryptionKey(): Promise<CryptoKey> {
  encryptionKey ??= invoke<string>('memory_key_get_or_create').then(seed => {
    if (!/^[0-9a-f]{64}$/iu.test(seed)) throw new Error('Der lokale Recovery-Schlüssel ist ungültig.')
    const raw = Uint8Array.from(seed.match(/.{2}/gu) ?? [], pair => Number.parseInt(pair, 16))
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  })
  return encryptionKey
}

function decodeEntries(raw: unknown): StoredPendingTaskCreate[] {
  if (raw === undefined || raw === null) return []
  // Strictly migrate the short-lived pre-version format. A partially invalid
  // legacy array is treated as corruption, never as an empty recovery state.
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<StoredDocument>).version === STORE_VERSION &&
        Array.isArray((raw as Partial<StoredDocument>).entries)
        ? (raw as StoredDocument).entries
        : null
      : null
  if (!values) throw new Error('Der task_create-Recovery-Speicher hat ein unbekanntes Format.')
  if (values.length > MAX_ENTRIES + MAX_RESOLVED_ENTRIES)
    throw new Error('Der task_create-Recovery-Speicher überschreitet die zulässige Eintragszahl.')
  const normalized = values.map(normalize)
  if (normalized.some(item => !item))
    throw new Error('Der task_create-Recovery-Speicher enthält einen ungültigen Eintrag.')
  return normalized as StoredPendingTaskCreate[]
}

async function encryptEntries(entries: StoredPendingTaskCreate[]): Promise<string> {
  if (
    entries.filter(item => item.state !== 'resolved').length > MAX_ENTRIES ||
    entries.length > MAX_ENTRIES + MAX_RESOLVED_ENTRIES
  )
    throw new Error('Der task_create-Recovery-Speicher überschreitet die zulässige Eintragszahl.')
  const initializationVector = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ version: STORE_VERSION, entries } satisfies StoredDocument)
  )
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: initializationVector, additionalData: ADDITIONAL_DATA },
    await recoveryEncryptionKey(),
    plaintext
  )
  const envelope = JSON.stringify({
    version: ENVELOPE_VERSION,
    algorithm: 'AES-256-GCM',
    initializationVector: bytesToBase64(initializationVector),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  } satisfies EncryptedEnvelope)
  if (new TextEncoder().encode(envelope).byteLength > MAX_ENCRYPTED_BYTES)
    throw new Error('Der verschlüsselte task_create-Recovery-Speicher überschreitet das Größenlimit.')
  return envelope
}

async function decodeStoredEntries(raw: unknown): Promise<StoredPendingTaskCreate[]> {
  if (typeof raw !== 'string') return decodeEntries(raw)
  if (new TextEncoder().encode(raw).byteLength > MAX_ENCRYPTED_BYTES)
    throw new Error('Der verschlüsselte task_create-Recovery-Speicher überschreitet das Größenlimit.')
  let envelope: Partial<EncryptedEnvelope>
  try {
    envelope = JSON.parse(raw) as Partial<EncryptedEnvelope>
  } catch {
    throw new Error('Der verschlüsselte task_create-Recovery-Speicher ist beschädigt.')
  }
  if (
    envelope.version !== ENVELOPE_VERSION ||
    envelope.algorithm !== 'AES-256-GCM' ||
    typeof envelope.initializationVector !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  )
    throw new Error('Der verschlüsselte task_create-Recovery-Speicher hat ein unbekanntes Format.')
  const initializationVector = base64ToBytes(envelope.initializationVector)
  if (initializationVector.byteLength !== 12)
    throw new Error('Der verschlüsselte task_create-Recovery-Speicher ist beschädigt.')
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: initializationVector, additionalData: ADDITIONAL_DATA },
      await recoveryEncryptionKey(),
      base64ToBytes(envelope.ciphertext)
    )
    return decodeEntries(JSON.parse(new TextDecoder().decode(plaintext)))
  } catch {
    throw new Error('Der verschlüsselte task_create-Recovery-Speicher konnte nicht entschlüsselt werden.')
  }
}

async function readEntries(): Promise<StoredPendingTaskCreate[]> {
  const store = await Store.load(STORE_FILE)
  const raw = await store.get<unknown>(STORE_KEY)
  const entries = await decodeStoredEntries(raw)
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    await store.set(STORE_KEY, await encryptEntries(entries))
    await store.save()
  }
  return entries
}

/** Load only unresolved writes belonging to the verified account/server and project. */
export function loadPendingTaskCreates(
  principalScopeId: string,
  projectId: string
): Promise<PendingTaskCreateVerification[]> {
  return serializeLedgerOperation(async () =>
    (await readEntries())
      .filter(
        item =>
          item.principalScopeId === principalScopeId &&
          item.projectId === projectId &&
          item.state !== 'resolved' &&
          item.state !== 'verified_present'
      )
      .map(({ updatedAt: _updatedAt, kind, state, ...item }) => ({
        ...item,
        ...(kind === 'conversation' ? { kind } : {}),
        state: state as PendingTaskCreateVerification['state'],
      }))
  )
}

/**
 * Merge exact operations, never replace a project partition from a chat snapshot.
 * Explicit terminal tombstones prevent a delayed checkpoint resurrecting a
 * completed operation. Omitting an operation cannot resolve another chat's write.
 */
export function replacePendingTaskCreates(
  principalScopeId: string,
  projectId: string,
  pending: readonly PendingTaskCreateVerification[],
  resolved: readonly PendingTaskCreateVerification[] = []
): Promise<void> {
  return serializeLedgerOperation(async () => {
    const store = await Store.load(STORE_FILE)
    const raw = await store.get<unknown>(STORE_KEY)
    const existing = await decodeStoredEntries(raw)
    const now = new Date().toISOString()
    const incoming = [...pending, ...resolved.map(item => ({ ...item, state: 'verified_present' as const }))].filter(
      item =>
        item.projectId === projectId &&
        (!item.principalScopeId || item.principalScopeId === principalScopeId) &&
        ['unknown', 'verified_absent', 'verified_present'].includes(item.state)
    )
    if (incoming.some(item => !item.fingerprintHash || !SHA256.test(item.fingerprintHash)))
      throw new Error('Ein Create-Recovery-Eintrag besitzt keinen gültigen Payload-Hash.')
    const replacement = incoming
      .map(item =>
        normalize({
          kind: item.kind ?? 'task',
          projectId: item.projectId,
          title: item.title,
          externalId: item.externalId,
          fingerprintHash: item.fingerprintHash,
          state: item.state === 'verified_present' ? 'resolved' : item.state,
          principalScopeId,
          updatedAt: now,
        })
      )
      .filter((item): item is StoredPendingTaskCreate => !!item)
    const byExternalId = new Map<string, StoredPendingTaskCreate>()
    const key = (item: StoredPendingTaskCreate) =>
      `${item.principalScopeId}\u0000${item.projectId}\u0000${item.kind}\u0000${item.externalId}`
    for (const item of existing) byExternalId.set(key(item), item)
    let changed = raw !== undefined && typeof raw !== 'string'
    for (const item of replacement) {
      const previous = byExternalId.get(key(item))
      if (previous && previous.fingerprintHash !== item.fingerprintHash)
        throw new Error('Die Recovery-Operation besitzt widersprüchliche Payload-Hashes.')
      if (previous?.state === 'resolved' || (previous?.state === item.state && previous.title === item.title)) continue
      byExternalId.set(key(item), item)
      changed = true
    }
    if (!changed) return
    await store.set(STORE_KEY, await encryptEntries([...byExternalId.values()]))
    await store.save()
  })
}
