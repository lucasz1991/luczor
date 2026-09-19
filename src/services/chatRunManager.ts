import { shallowRef } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { AppState } from '@/state/types'
import { finishChatActivity } from '@/services/chatActivity'

export type ChatRunState =
  'queued' | 'running' | 'waiting_resource' | 'waiting_approval' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
export type ChatRunRecord = {
  kind: 'chat'
  principalId: string
  deviceId?: string
  runId: string
  conversationId: string
  projectId: string
  state: ChatRunState
  checkpoint?: { messageId?: string; summary?: string; lastEventSequence?: number }
  revision: number
  createdAt: number
  updatedAt: number
}
export type ChatRunJournal = {
  list(principalId: string): Promise<ChatRunRecord[]>
  write(record: ChatRunRecord, expectedRevision: number): Promise<ChatRunRecord>
}
const liveStates = new Set<ChatRunState>(['queued', 'running', 'waiting_resource', 'waiting_approval'])
export const chatRunIsLive = (run: ChatRunRecord): boolean => liveStates.has(run.state)

/** UI recovery cannot re-approve an old call or keep a dead process spinning. */
export function reconcileRecoveredChatRuns(state: AppState, records: readonly ChatRunRecord[]): number {
  const interrupted = new Set(records.filter(run => run.state === 'interrupted').map(run => run.runId))
  const interruptedChats = new Set(records.filter(run => run.state === 'interrupted').map(run => run.conversationId))
  let changed = 0
  for (const chat of state.conversations ?? []) {
    const goal = chat.autonomousGoal
    if (!goal?.active || !interruptedChats.has(chat.id)) continue
    chat.autonomousGoal = {
      ...goal,
      active: false,
      status: 'waiting',
      revision: goal.revision + 1,
      reason: 'Unterbrochener Auftrag wiederhergestellt. Stand zuerst prüfen und Ziel bei Bedarf erneut aktivieren.',
      updatedAt: Date.now(),
    }
    changed++
  }
  for (const bucket of Object.values(state.pending?.toolCallsByProject ?? {})) {
    for (const call of bucket ?? []) {
      if (call.runId && interrupted.has(call.runId) && ['proposed', 'approved', 'executing'].includes(call.status)) {
        call.status = 'canceled'
        changed++
      }
    }
  }
  for (const message of state.messages) {
    if (!message.meta.runId || !interrupted.has(message.meta.runId)) continue
    if (message.meta.isLoading || message.meta.activity?.status === 'running') {
      message.meta.isLoading = false
      if (message.meta.activity) finishChatActivity(message.meta.activity, 'canceled')
      changed++
    }
  }
  return changed
}

/** The preview never claims disk durability; native runs must commit before effects. */
export function createChatRunJournal(native = isTauri()): ChatRunJournal {
  const preview = new Map<string, ChatRunRecord>()
  return {
    async list(principalId) {
      if (!native) return [...preview.values()].filter(run => run.principalId === principalId)
      return invoke('device_run_journal_list', { payload: { ownerPrincipalId: principalId, kind: 'chat', limit: 200 } })
    },
    async write(record, expectedRevision) {
      if (native) {
        const { revision: _revision, createdAt: _created, updatedAt: _updated, ...payload } = record
        return invoke('device_run_journal_transition', {
          payload: { ownerPrincipalId: record.principalId, expectedRevision, record: payload },
        })
      }
      const previous = preview.get(record.runId)
      if ((previous?.revision ?? 0) !== expectedRevision) throw new Error('journal_revision_conflict')
      const next = { ...structuredClone(record), revision: expectedRevision + 1, updatedAt: Date.now() }
      preview.set(record.runId, next)
      return next
    },
  }
}

export type ChatRunHandle = {
  readonly runId: string
  readonly signal: AbortSignal
  setMessage(messageId: string): Promise<void>
  setWaiting(waiting: 'resource' | 'approval' | null): Promise<void>
  interrupt(summary: string): Promise<void>
}
type OwnedRun = {
  record: ChatRunRecord
  controller: AbortController
  start: (handle: ChatRunHandle) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  writes: Promise<void>
  drained: Promise<void>
  drain: () => void
  finishState?: ChatRunState
}

/** Views observe records; only this owner may start, stop or settle an execution. */
export function createChatRunManager(journal: ChatRunJournal, concurrency = 4) {
  const records = shallowRef<ChatRunRecord[]>([])
  const jobs = new Map<string, OwnedRun>()
  // Reserve order before asynchronous disk commits. A fast second commit must
  // never overtake the first submitted message in the same conversation.
  const admissions = new Map<string, string>()
  const executing = new Set<string>()
  const publish = (record: ChatRunRecord) => {
    records.value = [...records.value.filter(item => item.runId !== record.runId), { ...record }].sort(
      (left, right) => left.createdAt - right.createdAt
    )
  }
  const update = (job: OwnedRun, patch: Partial<Pick<ChatRunRecord, 'state' | 'checkpoint'>>) => {
    const operation = job.writes.then(async () => {
      job.record = await journal.write({ ...job.record, ...patch }, job.record.revision)
      publish(job.record)
    })
    job.writes = operation.catch(() => undefined)
    return operation
  }
  const pump = () => {
    if (executing.size >= concurrency) return
    const occupied = new Set([...executing].map(id => jobs.get(id)?.record.conversationId))
    const firstAdmission = new Map<string, string>()
    for (const [runId, conversationId] of admissions)
      if (!firstAdmission.has(conversationId)) firstAdmission.set(conversationId, runId)
    for (const job of jobs.values()) {
      if (executing.size >= concurrency) break
      if (
        job.record.state !== 'queued' ||
        executing.has(job.record.runId) ||
        occupied.has(job.record.conversationId) ||
        firstAdmission.get(job.record.conversationId) !== job.record.runId
      )
        continue
      executing.add(job.record.runId)
      occupied.add(job.record.conversationId)
      void (async () => {
        try {
          await update(job, { state: 'running' })
          job.controller.signal.throwIfAborted()
          const result = await job.start({
            runId: job.record.runId,
            signal: job.controller.signal,
            setMessage: messageId => update(job, { checkpoint: { ...job.record.checkpoint, messageId } }),
            setWaiting: waiting => update(job, { state: waiting ? `waiting_${waiting}` : 'running' }),
            interrupt: async summary => {
              job.finishState = 'interrupted'
              await update(job, { checkpoint: { ...job.record.checkpoint, summary: summary.slice(0, 6000) } })
            },
          })
          await update(job, { state: job.controller.signal.aborted ? 'cancelled' : (job.finishState ?? 'completed') })
          job.resolve(result)
        } catch (error) {
          await update(job, {
            state: job.controller.signal.aborted ? 'cancelled' : (job.finishState ?? 'failed'),
          }).catch(() => {
            // The durable record remains recoverable on next launch. Do not keep
            // a dead process spinning in this session when storage is unavailable.
            publish({
              ...job.record,
              state: 'interrupted',
              checkpoint: {
                ...job.record.checkpoint,
                summary: 'Auftrag beendet; das lokale Laufjournal konnte nicht aktualisiert werden.',
              },
            })
          })
          job.reject(error)
        } finally {
          executing.delete(job.record.runId)
          jobs.delete(job.record.runId)
          job.drain()
          pump()
        }
      })()
    }
  }
  return {
    records,
    hasLive: (conversationId?: string) =>
      records.value.some(run => chatRunIsLive(run) && (!conversationId || run.conversationId === conversationId)),
    async recover(principalId: string) {
      const stored = await journal.list(principalId)
      for (const record of stored) {
        if (record.kind !== 'chat' || record.principalId !== principalId || jobs.has(record.runId)) continue
        const settled = chatRunIsLive(record)
          ? await journal.write(
              {
                ...record,
                state: 'interrupted',
                checkpoint: {
                  ...record.checkpoint,
                  summary: 'App neu gestartet. Aktuellen Zustand prüfen und ausdrücklich fortsetzen.',
                },
              },
              record.revision
            )
          : record
        publish(settled)
      }
    },
    async submit<Result>(
      input: Pick<ChatRunRecord, 'principalId' | 'projectId' | 'conversationId' | 'deviceId'> & { runId?: string },
      start: (handle: ChatRunHandle) => Promise<Result>,
      signal?: AbortSignal
    ): Promise<Result> {
      signal?.throwIfAborted()
      const runId = input.runId ?? crypto.randomUUID()
      if (admissions.has(runId)) throw new Error('Auftrag bereits vorhanden.')
      admissions.set(runId, input.conversationId)
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timestamp = Date.now()
      try {
        const record = await journal.write(
          { ...input, kind: 'chat', runId, state: 'queued', revision: 0, createdAt: timestamp, updatedAt: timestamp },
          0
        )
        if (signal?.aborted) {
          publish(await journal.write({ ...record, state: 'cancelled' }, record.revision))
          signal.throwIfAborted()
        }
        return await new Promise<Result>((resolve, reject) => {
          let drain!: () => void
          const drained = new Promise<void>(resolveDrain => {
            drain = resolveDrain
          })
          const job: OwnedRun = {
            record,
            controller,
            start,
            resolve: value => resolve(value as Result),
            reject,
            writes: Promise.resolve(),
            drained,
            drain,
          }
          jobs.set(runId, job)
          publish(record)
          pump()
        })
      } finally {
        signal?.removeEventListener('abort', abort)
        admissions.delete(runId)
        pump()
      }
    },
    async stop(runId: string, reason?: unknown) {
      const job = jobs.get(runId)
      if (!job) return
      job.controller.abort(reason ?? new DOMException('Von dir gestoppt.', 'AbortError'))
      if (!executing.has(runId)) {
        try {
          await update(job, { state: 'cancelled' })
        } finally {
          publish({ ...job.record, state: 'cancelled' })
          jobs.delete(runId)
          job.resolve(undefined)
          job.drain()
          pump()
        }
      }
      await job.drained
    },
    async stopAll(reason?: unknown) {
      const owned = [...jobs.values()]
      for (const job of owned) job.controller.abort(reason ?? new DOMException('Alle Aufträge gestoppt.', 'AbortError'))
      for (const job of [...jobs.values()]) {
        if (executing.has(job.record.runId)) continue
        await update(job, { state: 'cancelled' }).catch(() => undefined)
        jobs.delete(job.record.runId)
        job.resolve(undefined)
        job.drain()
      }
      await Promise.all(owned.map(job => job.drained))
    },
  }
}

export const chatRuns = createChatRunManager(createChatRunJournal())

export const hasActiveChatRuns = (): boolean => chatRuns.hasLive()
