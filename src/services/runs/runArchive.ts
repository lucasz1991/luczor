import { invoke, isTauri } from '@tauri-apps/api/core'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import { canPersistData, strictestDataPolicy, type SharedDataPolicy } from './dataPolicy'

export type RunArchiveScope = { principalId: string; projectId: string; conversationId: string; runId: string }
export type ArchivedRunState = 'working' | 'interrupted' | 'waiting_approval' | 'completed' | 'cancelled'
export type ArchiveHead = RunArchiveScope & { revision: number; updatedAt: number; manifest: string }
export type ArchiveSegment = { id: string; ciphertext: string }
export type RunArchiveStore = {
  read(scope: RunArchiveScope, segmentIds?: string[]): Promise<{ head: ArchiveHead | null; segments: ArchiveSegment[] }>
  write(input: {
    scope: RunArchiveScope
    expectedRevision: number
    manifest: string
    segments: ArchiveSegment[]
  }): Promise<ArchiveHead>
  list(principalId: string, afterRunId?: string): Promise<ArchiveHead[]>
}
type Manifest = {
  version: 1 | 2
  scope: RunArchiveScope
  messageId: string
  state: ArchivedRunState
  dataPolicy: SharedDataPolicy
  contentHash: string
  metadata: string[]
  /** v2 isolates scalar/object fields and each cumulative-array entry. v1 remains readable. */
  fields?: Record<string, string[]>
  collections?: Record<string, string[][]>
  messages: string[][]
  gaps: { reason: 'ephemeral_data'; messageCount: number }[]
}
export type ArchivedRun = {
  scope: RunArchiveScope
  messageId: string
  state: ArchivedRunState
  revision: number
  updatedAt: number
  dataPolicy: SharedDataPolicy
  gaps: Manifest['gaps']
  checkpoint?: AgentCheckpoint
}
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const CHUNK_CHARACTERS = 48_000
const MAX_SNAPSHOT_CHARACTERS = 64_000_000
const MAX_SEGMENTS = 8192
const scopeKey = (scope: RunArchiveScope) =>
  JSON.stringify([scope.principalId, scope.projectId, scope.conversationId, scope.runId])
const scopeFields = (scope: RunArchiveScope): RunArchiveScope => ({
  principalId: scope.principalId,
  projectId: scope.projectId,
  conversationId: scope.conversationId,
  runId: scope.runId,
})
const sameScope = (left: RunArchiveScope, right: RunArchiveScope) => scopeKey(left) === scopeKey(right)
const references = (value: Manifest): string[] => [
  ...value.metadata,
  ...value.messages.flat(),
  ...Object.values(value.fields ?? {}).flat(),
  ...Object.values(value.collections ?? {}).flat(2),
]
const hash = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('')
const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const fromBase64 = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

export function createNativeRunArchiveStore(): RunArchiveStore {
  return {
    read: (scope, segmentIds = []) =>
      invoke('run_archive_read', { payload: { scope: scopeFields(scope), segmentIds } }),
    write: payload => invoke('run_archive_write', { payload: { ...payload, scope: scopeFields(payload.scope) } }),
    list: (principalId, afterRunId) => invoke('run_archive_list', { payload: { principalId, afterRunId } }),
  }
}
/** Preview explicitly has no disk durability. Injection also enables realistic restart tests. */
export function createMemoryRunArchiveStore(): RunArchiveStore {
  const heads = new Map<string, ArchiveHead>()
  const objects = new Map<string, string>()
  return {
    async read(scope, ids = []) {
      const head = heads.get(JSON.stringify([scope.principalId, scope.runId])) ?? null
      if (head && !sameScope(head, scope)) throw new Error('archive_scope_mismatch')
      return {
        head: head ? structuredClone(head) : null,
        segments: ids.map(id => {
          const ciphertext = objects.get(`${scopeKey(scope)}:${id}`)
          if (!ciphertext) throw new Error('archive_segment_missing')
          return { id, ciphertext }
        }),
      }
    },
    async write(input) {
      const key = JSON.stringify([input.scope.principalId, input.scope.runId])
      const previous = heads.get(key)
      if (previous && !sameScope(previous, input.scope)) throw new Error('archive_scope_mismatch')
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Error('archive_revision_conflict')
      for (const segment of input.segments) {
        const id = `${scopeKey(input.scope)}:${segment.id}`
        if (!objects.has(id)) objects.set(id, segment.ciphertext)
      }
      const head = {
        ...input.scope,
        revision: input.expectedRevision + 1,
        updatedAt: Date.now(),
        manifest: input.manifest,
      }
      heads.set(key, head)
      return structuredClone(head)
    },
    async list(principalId, afterRunId) {
      return [...heads.values()]
        .filter(head => head.principalId === principalId && (!afterRunId || head.runId > afterRunId))
        .sort((left, right) => left.runId.localeCompare(right.runId))
        .slice(0, 200)
        .map(head => structuredClone(head))
    },
  }
}

export function createRunArchive(options: { store?: RunArchiveStore; key?: () => Promise<string> } = {}) {
  const native = isTauri()
  const store = options.store ?? (native ? createNativeRunArchiveStore() : createMemoryRunArchiveStore())
  // Browser previews never invoke the OS keyring and never persist their key.
  const previewKey = toBase64(crypto.getRandomValues(new Uint8Array(32)))
  let key: Promise<CryptoKey> | undefined
  const getKey = () =>
    (key ??= (async () => {
      const seed = options.key
        ? await options.key()
        : native
          ? await invoke<string>('memory_key_get_or_create')
          : undefined
      if (seed !== undefined && !/^[0-9a-f]{64}$/iu.test(seed)) throw new Error('archive_key_invalid')
      const bytes =
        seed === undefined
          ? fromBase64(previewKey)
          : Uint8Array.from(seed.match(/.{2}/gu)!, pair => Number.parseInt(pair, 16))
      return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
    })().catch(error => {
      key = undefined
      throw error
    }))
  const aad = (scope: RunArchiveScope, id: string) => encoder.encode(`luczor-run-archive-v1:${scopeKey(scope)}:${id}`)
  async function encrypt(scope: RunArchiveScope, id: string, value: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(scope, id) },
      await getKey(),
      encoder.encode(value)
    )
    return JSON.stringify({ version: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) })
  }
  async function decrypt(scope: RunArchiveScope, id: string, value: string) {
    try {
      const envelope = JSON.parse(value) as { version: number; iv: string; data: string }
      if (envelope.version !== 1) throw new Error()
      return decoder.decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad(scope, id) },
          await getKey(),
          fromBase64(envelope.data)
        )
      )
    } catch {
      throw new Error('archive_decryption_failed')
    }
  }
  async function manifest(head: ArchiveHead): Promise<Manifest> {
    const value = JSON.parse(await decrypt(head, 'manifest', head.manifest)) as Manifest
    if (
      ![1, 2].includes(value.version) ||
      !sameScope(value.scope, head) ||
      !Array.isArray(value.metadata) ||
      !Array.isArray(value.messages) ||
      !Array.isArray(value.gaps) ||
      !['syncable', 'local_only', 'ephemeral'].includes(value.dataPolicy)
    )
      throw new Error('archive_manifest_invalid')
    if (value.version === 2 && (!value.fields || !value.collections)) throw new Error('archive_manifest_invalid')
    const refs = references(value)
    if (refs.length > MAX_SEGMENTS || refs.some(id => !/^[0-9a-f]{64}$/u.test(id)))
      throw new Error('archive_manifest_limit')
    return value
  }
  const writes = new Map<string, Promise<unknown>>()
  type Encoded = { size: number; chunks: { id: string; text: string }[] }
  const encodingCaches = new Map<string, { objects: WeakMap<object, Encoded>; scalars: Map<unknown, Encoded> }>()
  const serialize = <T>(scope: RunArchiveScope, operation: () => Promise<T>): Promise<T> => {
    const id = scopeKey(scope)
    const next = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation)
    writes.set(id, next)
    void next
      .finally(() => {
        if (writes.get(id) === next) writes.delete(id)
      })
      .catch(() => undefined)
    return next
  }
  function summary(head: ArchiveHead, value: Manifest): ArchivedRun {
    return {
      scope: value.scope,
      messageId: value.messageId,
      state: value.state,
      revision: head.revision,
      updatedAt: head.updatedAt,
      dataPolicy: value.dataPolicy,
      gaps: value.gaps,
    }
  }
  return {
    clearCaches(scope?: RunArchiveScope) {
      if (scope) encodingCaches.delete(scopeKey(scope))
      else encodingCaches.clear()
    },
    async capture(
      input: RunArchiveScope & {
        messageId: string
        checkpoint: AgentCheckpoint
        state?: ArchivedRunState
        dataPolicy?: SharedDataPolicy
      }
    ): Promise<ArchivedRun> {
      const scope: RunArchiveScope = {
        principalId: input.principalId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        runId: input.runId,
      }
      if (
        input.checkpoint.projectId !== scope.projectId ||
        input.checkpoint.conversationId !== scope.conversationId ||
        input.checkpoint.principalScopeId !== scope.principalId
      )
        throw new Error('archive_checkpoint_scope_mismatch')
      return serialize(scope, async () => {
        let encodingCache = encodingCaches.get(scopeKey(scope))
        if (!encodingCache) {
          encodingCache = { objects: new WeakMap(), scalars: new Map() }
          encodingCaches.set(scopeKey(scope), encodingCache)
        }
        const current = (await store.read(scope)).head
        const previous = current ? await manifest(current) : undefined
        // Explicitly ephemeral source classification cannot be weakened by a caller.
        const dataPolicy = strictestDataPolicy(
          input.dataPolicy ?? 'syncable',
          input.checkpoint.dataPolicy ?? (input.checkpoint.ephemeralDataUsed ? 'ephemeral' : 'syncable')
        )
        const value: Manifest = {
          version: 2,
          scope,
          messageId: input.messageId,
          state: input.state ?? 'working',
          dataPolicy,
          contentHash: '',
          metadata: [],
          fields: {},
          collections: {},
          messages: [],
          gaps: [],
        }
        const pending: ArchiveSegment[] = []
        const known = new Set(previous ? references(previous) : [])
        let size = 0
        async function encode(value: unknown): Promise<string[]> {
          const immutable = !!value && typeof value === 'object' && Object.isFrozen(value)
          const scalar = value === null || ['string', 'number', 'boolean'].includes(typeof value)
          let encoded = immutable
            ? encodingCache!.objects.get(value as object)
            : scalar
              ? encodingCache!.scalars.get(value)
              : undefined
          if (!encoded) {
            const text = JSON.stringify(value)
            const chunks: { id: string; text: string }[] = []
            for (let start = 0; start < text.length;) {
              let end = Math.min(start + CHUNK_CHARACTERS, text.length)
              if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--
              const chunk = text.slice(start, end)
              chunks.push({ id: await hash(chunk), text: chunk })
              start = end
            }
            encoded = { size: text.length, chunks }
            if (immutable) encodingCache!.objects.set(value as object, encoded)
            else if (scalar) encodingCache!.scalars.set(value, encoded)
          }
          size += encoded.size
          if (size > MAX_SNAPSHOT_CHARACTERS) throw new Error('archive_snapshot_limit')
          const refs: string[] = []
          for (const { id, text } of encoded.chunks) {
            refs.push(id)
            if (!known.has(id)) {
              pending.push({ id, ciphertext: await encrypt(scope, id, text) })
              known.add(id)
            }
          }
          return refs
        }
        if (canPersistData(dataPolicy)) {
          const { messages, ...metadata } = input.checkpoint
          for (const [name, field] of Object.entries(metadata)) {
            if (field === undefined) continue
            if (Array.isArray(field)) {
              const items: string[][] = []
              for (const item of field) items.push(await encode(item))
              Object.defineProperty(value.collections!, name, {
                value: items,
                enumerable: true,
                writable: true,
                configurable: true,
              })
            } else if (name === 'progressEvidence' && metadata.progressEvidence) {
              const { receipts, ...progress } = metadata.progressEvidence
              Object.defineProperty(value.fields!, name, {
                value: await encode(progress),
                enumerable: true,
                writable: true,
                configurable: true,
              })
              const items: string[][] = []
              for (const receipt of receipts) items.push(await encode(receipt))
              value.collections!['progressEvidence.receipts'] = items
            } else
              Object.defineProperty(value.fields!, name, {
                value: await encode(field),
                enumerable: true,
                writable: true,
                configurable: true,
              })
          }
          for (const message of messages) value.messages.push(await encode(message))
        } else {
          // No objective, payload identity, tool arguments, outputs or derived prose
          // from a volatile checkpoint is serialized, even inside encryption.
          value.gaps = [{ reason: 'ephemeral_data', messageCount: input.checkpoint.messages.length }]
        }
        if (references(value).length > MAX_SEGMENTS) throw new Error('archive_snapshot_limit')
        value.contentHash = await hash(JSON.stringify(value))
        if (previous?.contentHash === value.contentHash && current) return summary(current, previous)
        const result = await store.write({
          scope,
          expectedRevision: current?.revision ?? 0,
          manifest: await encrypt(scope, 'manifest', JSON.stringify(value)),
          segments: pending,
        })
        if (value.state === 'completed' || value.state === 'cancelled') encodingCaches.delete(scopeKey(scope))
        return summary(result, value)
      })
    },
    async setState(scope: RunArchiveScope, state: ArchivedRunState): Promise<void> {
      return serialize(scope, async () => {
        const current = (await store.read(scope)).head
        if (!current) return
        const value = await manifest(current)
        if (value.state === state) return
        value.state = state
        value.contentHash = ''
        value.contentHash = await hash(JSON.stringify(value))
        await store.write({
          scope,
          expectedRevision: current.revision,
          manifest: await encrypt(scope, 'manifest', JSON.stringify(value)),
          segments: [],
        })
        if (state === 'completed' || state === 'cancelled') encodingCaches.delete(scopeKey(scope))
      })
    },
    async load(scope: RunArchiveScope): Promise<ArchivedRun | null> {
      const head = (await store.read(scope)).head
      if (!head) return null
      const value = await manifest(head)
      const result = summary(head, value)
      if (value.gaps.length) return result
      const ids = [...new Set(references(value))]
      const objects = (await store.read(scope, ids)).segments
      const texts = new Map<string, string>()
      for (const object of objects) {
        const plaintext = await decrypt(scope, object.id, object.ciphertext)
        if ((await hash(plaintext)) !== object.id) throw new Error('archive_segment_hash_mismatch')
        texts.set(object.id, plaintext)
      }
      const decode = (refs: string[]) =>
        JSON.parse(
          refs
            .map(id => {
              const text = texts.get(id)
              if (text === undefined) throw new Error('archive_segment_missing')
              return text
            })
            .join('')
        )
      const metadata: Record<string, unknown> =
        value.version === 1
          ? decode(value.metadata)
          : Object.fromEntries(Object.entries(value.fields!).map(([name, refs]) => [name, decode(refs)]))
      for (const [name, items] of Object.entries(value.collections ?? {})) {
        const decoded = items.map(decode)
        if (name === 'progressEvidence.receipts')
          metadata.progressEvidence = { ...(metadata.progressEvidence as object), receipts: decoded }
        else
          Object.defineProperty(metadata, name, {
            value: decoded,
            enumerable: true,
            writable: true,
            configurable: true,
          })
      }
      const checkpoint = { ...metadata, messages: value.messages.map(decode) } as AgentCheckpoint
      if (
        checkpoint.principalScopeId !== scope.principalId ||
        checkpoint.projectId !== scope.projectId ||
        checkpoint.conversationId !== scope.conversationId
      )
        throw new Error('archive_checkpoint_scope_mismatch')
      result.checkpoint = checkpoint
      return result
    },
    async list(principalId: string): Promise<ArchivedRun[]> {
      const result: ArchivedRun[] = []
      let afterRunId: string | undefined
      for (;;) {
        const page = await store.list(principalId, afterRunId)
        for (const head of page) {
          if (head.principalId !== principalId) throw new Error('archive_scope_mismatch')
          result.push(summary(head, await manifest(head)))
        }
        if (page.length < 200) return result
        const next = page.at(-1)!.runId
        if (afterRunId === next) throw new Error('archive_cursor_not_advanced')
        afterRunId = next
      }
    },
  }
}
export type RunArchive = ReturnType<typeof createRunArchive>
