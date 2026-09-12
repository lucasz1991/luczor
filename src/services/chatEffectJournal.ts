import { invoke, isTauri } from '@tauri-apps/api/core'
import { mutationKey } from '@/services/agents/chatCheckpoint'

export type EffectRecord = {
  kind: 'device'
  principalId: string
  projectId: string
  conversationId: string
  runId: string
  payloadHash: string
  state: 'started' | 'completed' | 'outcome_unknown'
  checkpoint: { messageId: string; summary: string }
  revision?: number
}
type EffectStore = {
  read(principalId: string, runId: string): Promise<EffectRecord | null>
  write(record: EffectRecord, expectedRevision: number): Promise<EffectRecord>
}
export class ChatEffectJournalError extends Error {
  constructor() {
    super(
      'Der Schreibvorgang ist nicht sicher im Laufjournal bestätigt. Aktuellen Zustand zuerst mit Lesewerkzeugen prüfen; die Änderung nicht blind wiederholen.'
    )
    this.name = 'ChatEffectJournalError'
  }
}
async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
function effectStore(native: boolean): EffectStore {
  const preview = new Map<string, EffectRecord>()
  return {
    async read(principalId, runId) {
      return native
        ? invoke('device_run_journal_read', { payload: { ownerPrincipalId: principalId, runId } })
        : (preview.get(runId) ?? null)
    },
    async write(record, expectedRevision) {
      const payload = {
        kind: record.kind,
        principalId: record.principalId,
        projectId: record.projectId,
        conversationId: record.conversationId,
        runId: record.runId,
        payloadHash: record.payloadHash,
        state: record.state,
        checkpoint: record.checkpoint,
      }
      if (native)
        return invoke('device_run_journal_transition', {
          payload: { ownerPrincipalId: record.principalId, expectedRevision, record: payload },
        })
      if ((preview.get(record.runId)?.revision ?? 0) !== expectedRevision) throw new ChatEffectJournalError()
      const next = { ...record, revision: expectedRevision + 1 }
      preview.set(record.runId, next)
      return next
    },
  }
}

/** Local metadata only: no arguments, private results or provider context are stored. */
export function createChatEffectJournal(
  owner: { principalId: string; projectId: string; conversationId: string; runId: string },
  store: EffectStore = effectStore(isTauri())
) {
  return {
    async before(call: { id: string; name: string; arguments: Record<string, unknown> }) {
      const fingerprint = await hash(JSON.stringify([owner.runId, call.id]))
      const payloadHash = await hash(mutationKey(call.name, call.arguments))
      // A stable ID makes an uncertain IPC reply discoverable before any retry.
      const runId = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`
      let record: EffectRecord
      try {
        const previous = await store.read(owner.principalId, runId)
        if (previous) throw new ChatEffectJournalError()
        record = await store.write(
          {
            kind: 'device',
            principalId: owner.principalId,
            projectId: owner.projectId,
            conversationId: owner.conversationId,
            runId,
            payloadHash,
            state: 'started',
            checkpoint: { messageId: owner.runId, summary: call.name.slice(0, 160) },
          },
          0
        )
      } catch {
        throw new ChatEffectJournalError()
      }
      return {
        async finish(success: boolean) {
          try {
            record = await store.write(
              { ...record, state: success ? 'completed' : 'outcome_unknown' },
              record.revision!
            )
          } catch {
            throw new ChatEffectJournalError()
          }
        },
      }
    },
  }
}
export type ChatEffectJournal = ReturnType<typeof createChatEffectJournal>
