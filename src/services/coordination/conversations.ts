import { Store } from '@tauri-apps/plugin-store'
import { state, mutations } from '@/state/store'
import { chatRuns } from '@/services/chatRunManager'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig } from '@/services/api/luczorApi'
import { saveAppStateStrict } from '@/services/persistence'
import type { Conversation, Message } from '@/state/types'

type RemoteConversation = {
  id?: number
  external_id: string
  title: string | null
  revision: number
  archived_at?: string | null
  created_at: string
  updated_at: string
}
type RemoteMessage = { id: string; role: 'user' | 'assistant'; content: string; created_at: number; job_id?: string }
type Page = { revision: number; messages: RemoteMessage[]; next_cursor: number | null }
let inFlight: Promise<void> | null = null
let disk: Promise<Store> | null = null

/** Keep valid existing IDs; migrate pre-UUID histories deterministically without deleting them. */
export async function conversationWireId(namespace: string, id: string): Promise<string> {
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return id
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${namespace}\0${id}`)))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function portableConversationMessage(message: Message): boolean {
  return (
    ['user', 'assistant'].includes(message.role) &&
    message.visibility !== 'hidden' &&
    !message.meta?.isLoading &&
    message.meta?.dataHandling !== 'ephemeral' &&
    message.meta?.serverSpeechAllowed !== false
  )
}
/** Append-only conversation reconciliation is independent of project snapshot replacement and other active runs. */
export function syncConversations(signal?: AbortSignal): Promise<void> {
  if (inFlight) return inFlight
  const current = synchronize(signal).finally(() => {
    if (inFlight === current) inFlight = null
  })
  inFlight = current
  return current
}
async function synchronize(signal?: AbortSignal) {
  const account = await getVerifiedAccountSnapshot()
  if (!account) return
  const store = await (disk ??= Store.load('luczor.conversation-sync.json'))
  const request = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
    query?: Record<string, string>
  ): Promise<T> => {
    signal?.throwIfAborted()
    const result = await requestWithConfig<{ data: T }>(path, { method, body, query, signal }, account.config)
    signal?.throwIfAborted()
    return result.data
  }
  for (const project of state.projects.filter(
    item => item.cloud?.principalId === account.principalId && !item.cloud?.paused
  )) {
    const externalId = project.cloud!.externalId
    mutations.getActiveConversationId(project.id)
    const namespace = `${account.principalId}:${externalId}`
    const locals = new Map<string, Conversation>()
    for (const conversation of state.conversations ?? [])
      if (conversation.projectId === project.id)
        locals.set(await conversationWireId(namespace, conversation.id), conversation)
    const remote: RemoteConversation[] = []
    for (let after = 0; ;) {
      const batch = await request<RemoteConversation[]>('/conversations', 'GET', undefined, {
        project_id: externalId,
        include_archived: '1',
        after: String(after),
        limit: '200',
      })
      remote.push(...batch)
      if (batch.length < 200) break
      const next = batch.at(-1)?.id
      if (!next || next <= after) throw new Error('Die Chatliste konnte nicht vollständig abgerufen werden.')
      after = next
    }
    const known = new Set(remote.map(item => item.external_id))
    const created = new Set<string>()
    for (const [wireId, local] of locals)
      if (!known.has(wireId)) {
        await request('/conversations', 'POST', {
          external_id: wireId,
          title: local.title,
          project_id: externalId,
          client_id: account.config.clientId,
        })
        created.add(wireId)
        remote.push({
          external_id: wireId,
          title: local.title,
          revision: 0,
          created_at: new Date(local.createdAt).toISOString(),
          updated_at: new Date(local.updatedAt).toISOString(),
        })
      }
    for (const conversation of remote) {
      const key = `${namespace}:${conversation.external_id}`
      let local = locals.get(conversation.external_id)
      if (!local) {
        local = {
          id: conversation.external_id,
          projectId: project.id,
          title: conversation.title || 'Chat',
          createdAt: Date.parse(conversation.created_at),
          updatedAt: Date.parse(conversation.updated_at),
          archivedAt: conversation.archived_at ? Date.parse(conversation.archived_at) : null,
        }
        state.conversations!.push(local)
      }
      const path = `/conversations/${conversation.external_id}`
      const checkpoint = await store.get<{ cursor: number; revision: number; title: string; archived: boolean }>(key)
      let cursor = checkpoint?.cursor ?? 0,
        revision = checkpoint?.revision ?? conversation.revision
      const localMessages = state.messages.filter(
        message =>
          message.projectId === project.id &&
          (message.conversationId ?? message.meta?.conversationId) === local!.id &&
          portableConversationMessage(message)
      )
      const localById = new Map<string, Message>()
      for (const message of localMessages) localById.set(await conversationWireId(key, message.id), message)
      const received = new Map<string, RemoteMessage>()
      let after = 0 // Includes acknowledged messages so a lost local cursor cannot cause duplicate effects.
      while (true) {
        const page = await request<Page>(`${path}/messages`, 'GET', undefined, { after: String(after), limit: '200' })
        revision = page.revision
        for (const message of page.messages) received.set(message.id, message)
        if (page.messages.length < 200 || page.next_cursor === null) break
        if (page.next_cursor <= after) throw new Error('Der Nachrichtenabgleich lieferte keinen fortsetzbaren Stand.')
        after = page.next_cursor
        cursor = after
      }
      for (const [wireId, message] of received) {
        const existing = localById.get(wireId)
        if (existing && (existing.content !== message.content || existing.role !== message.role))
          throw new Error(
            'Ein Chat enthält unterschiedliche Fassungen derselben Nachricht. Beide Stände bleiben erhalten.'
          )
        if (!existing && !chatRuns.hasLive(local.id)) {
          mutations.addMessage({
            id: wireId,
            projectId: project.id,
            conversationId: local.id,
            role: message.role,
            content: message.content,
            createdAt: message.created_at,
            ts: message.created_at,
            visibility: 'visible',
            parsed: null,
            meta: {},
          })
        }
      }
      const outgoing = [...localById].filter(([id]) => !received.has(id))
      for (let offset = 0; offset < outgoing.length; offset += 100) {
        const result = await request<{ revision: number }>(`${path}/messages`, 'POST', {
          expected_revision: revision,
          messages: outgoing.slice(offset, offset + 100).map(([id, message]) => ({
            id,
            role: message.role,
            content: message.content,
            created_at: message.createdAt,
          })),
        })
        revision = result.revision
      }
      const changed = checkpoint
        ? local.title !== checkpoint.title || !!local.archivedAt !== checkpoint.archived
        : created.has(conversation.external_id) && !!local.archivedAt
      if (changed) {
        const result = await request<RemoteConversation>(path, 'PATCH', {
          expected_revision: revision,
          title: local.title,
          archived: !!local.archivedAt,
        })
        revision = result.revision
      } else if (checkpoint && !chatRuns.hasLive(local.id)) {
        local.title = conversation.title || 'Chat'
        local.archivedAt = conversation.archived_at ? Date.parse(conversation.archived_at) : null
      }
      signal?.throwIfAborted()
      await saveAppStateStrict(state)
      await store.set(key, { cursor, revision, title: local.title, archived: !!local.archivedAt })
      await store.save()
    }
  }
}
