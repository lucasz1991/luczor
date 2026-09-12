import { shallowRef } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'

export type ChatRunState = 'queued' | 'running' | 'waiting_resource' | 'waiting_approval' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
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
}
type OwnedRun = {
  record: ChatRunRecord
  controller: AbortController
  start: (handle: ChatRunHandle) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  writes: Promise<void>
}

/** Views observe records; only this owner may start, stop or settle an execution. */
export function createChatRunManager(journal: ChatRunJournal, concurrency = 4) {
  const records = shallowRef<ChatRunRecord[]>([])
  const jobs = new Map<string, OwnedRun>()
  const executing = new Set<string>()
  const publish = (record: ChatRunRecord) => {
    records.value = [...records.value.filter(item => item.runId !== record.runId), { ...record }]
  }
  const update = (job: OwnedRun, patch: Partial<Pick<ChatRunRecord, 'state' | 'checkpoint'>>) => {
    const operation = job.writes.then(async () => {
      job.record = await journal.write({ ...job.record, ...patch }, job.record.revision)
      publish(job.record)
    })
    job.writes = operation
    return operation
  }
  const pump = () => {
    if (executing.size >= concurrency) return
    const occupied = new Set([...executing].map(id => jobs.get(id)?.record.conversationId))
    for (const job of jobs.values()) {
      if (executing.size >= concurrency) break
      if (job.record.state !== 'queued' || executing.has(job.record.runId) || occupied.has(job.record.conversationId)) continue
      executing.add(job.record.runId)
      occupied.add(job.record.conversationId)
      void (async () => {
        try {
          await update(job, { state: 'running' })
          job.controller.signal.throwIfAborted()
          const result = await job.start({
            runId: job.record.runId,
            signal: job.controller.signal,
            setMessage: messageId => update(job, { checkpoint: { messageId } }),
          })
          await update(job, { state: job.controller.signal.aborted ? 'cancelled' : 'completed' })
          job.resolve(result)
        } catch (error) {
          await update(job, { state: job.controller.signal.aborted ? 'cancelled' : 'failed' }).catch(() => undefined)
          job.reject(error)
        } finally {
          executing.delete(job.record.runId)
          jobs.delete(job.record.runId)
          pump()
        }
      })()
    }
  }
  return {
    records,
    hasLive: (conversationId?: string) => records.value.some(run => chatRunIsLive(run) && (!conversationId || run.conversationId === conversationId)),
    async recover(principalId: string) {
      const stored = await journal.list(principalId)
      for (const record of stored) {
        if (record.kind !== 'chat' || record.principalId !== principalId || jobs.has(record.runId)) continue
        const settled = chatRunIsLive(record)
          ? await journal.write({ ...record, state: 'interrupted', checkpoint: { ...record.checkpoint, summary: 'App neu gestartet. Aktuellen Zustand prüfen und ausdrücklich fortsetzen.' } }, record.revision)
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
      if (jobs.has(runId)) throw new Error('Auftrag bereits vorhanden.')
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timestamp = Date.now()
      try {
        const record = await journal.write({ ...input, kind: 'chat', runId, state: 'queued', revision: 0, createdAt: timestamp, updatedAt: timestamp }, 0)
        signal?.throwIfAborted()
        return await new Promise<Result>((resolve, reject) => {
          const job: OwnedRun = { record, controller, start, resolve: value => resolve(value as Result), reject, writes: Promise.resolve() }
          jobs.set(runId, job)
          publish(record)
          pump()
        })
      } finally {
        signal?.removeEventListener('abort', abort)
      }
    },
    async stop(runId: string, reason?: unknown) {
      const job = jobs.get(runId)
      if (!job) return
      job.controller.abort(reason ?? new DOMException('Von dir gestoppt.', 'AbortError'))
      if (!executing.has(runId)) {
        await update(job, { state: 'cancelled' })
        jobs.delete(runId)
        job.resolve(undefined)
        pump()
      }
    },
    async stopAll(reason?: unknown) {
      for (const job of jobs.values()) job.controller.abort(reason ?? new DOMException('Alle Aufträge gestoppt.', 'AbortError'))
      for (const job of [...jobs.values()]) {
        if (executing.has(job.record.runId)) continue
        await update(job, { state: 'cancelled' }).catch(() => undefined)
        jobs.delete(job.record.runId)
        job.resolve(undefined)
      }
    },
  }
}

export const chatRuns = createChatRunManager(createChatRunJournal())
