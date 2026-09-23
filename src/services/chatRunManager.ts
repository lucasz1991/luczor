import { shallowRef } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { AppState } from '@/state/types'
import { finishChatActivity } from '@/services/chatActivity'
import { waitForRuntimeDrain, type NativeStopAcknowledgement } from '@/services/runs/drain'

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
  const stopped = records.filter(run => run.state === 'interrupted' || run.state === 'cancelled')
  const interrupted = new Set(stopped.map(run => run.runId))
  const interruptedChats = new Set(stopped.map(run => run.conversationId))
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
      // Recovery is independent of recent completed history. Include stopped
      // records too: a crash after the journal transition but before UI-state
      // persistence must not strand old approval/loading flags on the next boot.
      const live: ChatRunRecord[] = []
      let after: { updatedAt: number; runId: string } | undefined
      for (;;) {
        const page = await invoke<ChatRunRecord[]>('device_run_journal_list', {
          payload: {
            ownerPrincipalId: principalId,
            kind: 'chat',
            limit: 200,
            states: [...liveStates, 'interrupted', 'cancelled'],
            ...(after ? { after } : {}),
          },
        })
        live.push(...page)
        if (page.length < 200) break
        const last = page.at(-1)!
        const next = { updatedAt: last.updatedAt, runId: last.runId }
        if (after && next.updatedAt === after.updatedAt && next.runId === after.runId)
          throw new Error('journal_cursor_not_advanced')
        after = next
      }
      const recent = await invoke<ChatRunRecord[]>('device_run_journal_list', {
        payload: { ownerPrincipalId: principalId, kind: 'chat', limit: 200 },
      })
      return [...new Map([...recent, ...live].map(run => [run.runId, run])).values()]
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
  detached?: boolean
  stoppingQueued?: boolean
  slotSequence: number
  resumeSlot?: { resolve: () => void; reject: (reason: unknown) => void; abort: () => void }
}
type Admission = {
  conversationId: string
  controller: AbortController
  drained: Promise<void>
  drain: () => void
  recovered: Promise<void>
  detach: () => void
  detached: boolean
  stopGeneration?: number
  sequence: number
}

/** Views observe records; only this owner may start, stop or settle an execution. */
export function createChatRunManager(journal: ChatRunJournal, concurrency = 4) {
  const records = shallowRef<ChatRunRecord[]>([])
  const jobs = new Map<string, OwnedRun>()
  // Reserve order before asynchronous disk commits. A fast second commit must
  // never overtake the first submitted message in the same conversation.
  const admissions = new Map<string, Admission>()
  const executing = new Set<string>()
  // Logical ownership survives an approval wait; its runnable slot does not.
  const runningSlots = new Set<string>()
  let nextSlotSequence = 0
  let admissionPaused = false
  let stopGeneration = 0
  const publish = (record: ChatRunRecord) => {
    records.value = [...records.value.filter(item => item.runId !== record.runId), { ...record }].sort(
      (left, right) => left.createdAt - right.createdAt
    )
  }
  const update = (job: OwnedRun, patch: Partial<Pick<ChatRunRecord, 'state' | 'checkpoint'>>) => {
    const operation = job.writes.then(async () => {
      if (job.detached) return
      job.record = await journal.write({ ...job.record, ...patch }, job.record.revision)
      if (!job.detached) publish(job.controller.signal.aborted ? { ...job.record, state: 'cancelled' } : job.record)
    })
    job.writes = operation.catch(() => undefined)
    return operation
  }
  const pump = () => {
    if (admissionPaused || runningSlots.size >= concurrency) return
    const occupied = new Set([...executing].map(id => jobs.get(id)?.record.conversationId))
    const firstAdmission = new Map<string, string>()
    for (const [runId, admission] of admissions)
      if (!firstAdmission.has(admission.conversationId)) firstAdmission.set(admission.conversationId, runId)
    for (const job of [...jobs.values()].sort((left, right) => left.slotSequence - right.slotSequence)) {
      if (runningSlots.size >= concurrency) break
      if (job.resumeSlot && !job.controller.signal.aborted && !job.detached) {
        const waiter = job.resumeSlot
        job.resumeSlot = undefined
        job.controller.signal.removeEventListener('abort', waiter.abort)
        runningSlots.add(job.record.runId)
        waiter.resolve()
        continue
      }
      if (
        job.record.state !== 'queued' ||
        job.controller.signal.aborted ||
        executing.has(job.record.runId) ||
        occupied.has(job.record.conversationId) ||
        firstAdmission.get(job.record.conversationId) !== job.record.runId
      )
        continue
      executing.add(job.record.runId)
      runningSlots.add(job.record.runId)
      occupied.add(job.record.conversationId)
      void (async () => {
        try {
          await update(job, { state: 'running' })
          job.controller.signal.throwIfAborted()
          const result = await job.start({
            runId: job.record.runId,
            signal: job.controller.signal,
            setMessage: messageId => update(job, { checkpoint: { ...job.record.checkpoint, messageId } }),
            setWaiting: async waiting => {
              job.controller.signal.throwIfAborted()
              if (job.detached) throw new DOMException('Lauf nicht mehr aktiv.', 'AbortError')
              if (waiting) {
                await update(job, { state: `waiting_${waiting}` })
                if (waiting === 'approval') {
                  runningSlots.delete(job.record.runId)
                  pump()
                }
                return
              }
              if (!runningSlots.has(job.record.runId)) {
                await update(job, { state: 'waiting_resource' })
                job.controller.signal.throwIfAborted()
                await new Promise<void>((resolve, reject) => {
                  const abort = () => {
                    job.resumeSlot = undefined
                    reject(job.controller.signal.reason ?? new DOMException('Aborted', 'AbortError'))
                    pump()
                  }
                  job.slotSequence = nextSlotSequence++
                  job.resumeSlot = { resolve, reject, abort }
                  job.controller.signal.addEventListener('abort', abort, { once: true })
                  pump()
                })
              }
              job.controller.signal.throwIfAborted()
              if (job.detached) throw new DOMException('Lauf nicht mehr aktiv.', 'AbortError')
              await update(job, { state: 'running' })
            },
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
            if (!job.detached)
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
          if (!job.detached) {
            executing.delete(job.record.runId)
            runningSlots.delete(job.record.runId)
            jobs.delete(job.record.runId)
            job.drain()
            pump()
          }
        }
      })()
    }
  }
  const cancelQueued = (job: OwnedRun) => {
    if (executing.has(job.record.runId) || job.stoppingQueued) return
    job.stoppingQueued = true
    void update(job, { state: 'cancelled' })
      .catch(() => undefined)
      .finally(() => {
        if (job.detached) return
        publish({ ...job.record, state: 'cancelled' })
        jobs.delete(job.record.runId)
        job.resolve(undefined)
        job.drain()
        pump()
      })
  }
  const requestStop = (reason?: unknown, pause = true) => {
    if (pause) admissionPaused = true
    const generation = ++stopGeneration
    for (const admission of admissions.values()) {
      admission.stopGeneration = generation
      admission.controller.abort(reason ?? new DOMException('Alle Aufträge gestoppt.', 'AbortError'))
    }
    for (const job of jobs.values()) {
      publish({ ...job.record, state: 'cancelled' })
      cancelQueued(job)
    }
    return generation
  }
  const waitForStop = (timeoutMs = 1500) =>
    waitForRuntimeDrain(() => [...admissions].map(([id, admission]) => ({ id, drained: admission.drained })), timeoutMs)
  return {
    records,
    hasLive: (conversationId?: string) =>
      records.value.some(run => chatRunIsLive(run) && (!conversationId || run.conversationId === conversationId)),
    async recover(principalId: string, assertCurrent: () => void = () => undefined) {
      assertCurrent()
      const stored = await journal.list(principalId)
      assertCurrent()
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
        assertCurrent()
        publish(settled)
      }
    },
    async submit<Result>(
      input: Pick<ChatRunRecord, 'principalId' | 'projectId' | 'conversationId' | 'deviceId'> & { runId?: string },
      start: (handle: ChatRunHandle) => Promise<Result>,
      signal?: AbortSignal
    ): Promise<Result> {
      if (admissionPaused) throw new Error('Chatläufe sind gestoppt. Ausführung ausdrücklich wieder erlauben.')
      signal?.throwIfAborted()
      const runId = input.runId ?? crypto.randomUUID()
      if (admissions.has(runId)) throw new Error('Auftrag bereits vorhanden.')
      const controller = new AbortController()
      let drainAdmission!: () => void
      let detachAdmission!: () => void
      const admission: Admission = {
        conversationId: input.conversationId,
        controller,
        detached: false,
        sequence: nextSlotSequence++,
        drained: new Promise<void>(resolve => {
          drainAdmission = resolve
        }),
        drain: () => drainAdmission(),
        recovered: new Promise<void>(resolve => {
          detachAdmission = resolve
        }),
        detach: () => {
          admission.detached = true
          detachAdmission()
        },
      }
      admissions.set(runId, admission)
      const abort = () => {
        controller.abort(signal?.reason)
        const job = jobs.get(runId)
        if (job) cancelQueued(job)
      }
      signal?.addEventListener('abort', abort, { once: true })
      const timestamp = Date.now()
      try {
        const initialWrite = journal
          .write(
            { ...input, kind: 'chat', runId, state: 'queued', revision: 0, createdAt: timestamp, updatedAt: timestamp },
            0
          )
          .then(record => {
            if (admission.detached)
              void journal.write({ ...record, state: 'cancelled' }, record.revision).catch(() => undefined)
            return record
          })
        const record = await Promise.race([initialWrite, admission.recovered.then(() => undefined)])
        if (!record || admission.detached) return undefined as Result
        if (controller.signal.aborted) {
          publish(await journal.write({ ...record, state: 'cancelled' }, record.revision))
          controller.signal.throwIfAborted()
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
            slotSequence: admission.sequence,
          }
          jobs.set(runId, job)
          publish(record)
          pump()
        })
      } finally {
        signal?.removeEventListener('abort', abort)
        if (admissions.get(runId) === admission) admissions.delete(runId)
        admission.drain()
        pump()
      }
    },
    async stop(runId: string, reason?: unknown, timeoutMs = 1500) {
      admissions.get(runId)?.controller.abort(reason ?? new DOMException('Von dir gestoppt.', 'AbortError'))
      const job = jobs.get(runId)
      if (job) cancelQueued(job)
      return waitForRuntimeDrain(() => {
        const admission = admissions.get(runId)
        return admission ? [{ id: runId, drained: admission.drained }] : []
      }, timeoutMs)
    },
    requestStopAll: (reason?: unknown) => requestStop(reason),
    waitForStop,
    recoverStopped(acknowledgement: NativeStopAcknowledgement): number {
      if (!acknowledgement.nativeStopped || acknowledgement.generation !== stopGeneration) return 0
      let recovered = 0
      for (const [runId, admission] of admissions) {
        if (admission.stopGeneration !== acknowledgement.generation || !admission.controller.signal.aborted) continue
        const job = jobs.get(runId)
        if (job) {
          job.detached = true
          publish({ ...job.record, state: 'cancelled' })
          // Do not queue behind a hung journal write. CAS against the last
          // acknowledged revision preserves newer disk state if another write won.
          void journal
            .write({ ...job.record, state: 'cancelled' }, job.record.revision)
            .then(record => {
              if (!jobs.has(runId) && records.value.some(item => item.runId === runId && item.state === 'cancelled'))
                publish(record)
            })
            .catch(() => {
              // Startup recovery still interrupts a surviving live journal record.
            })
          job.resolve(undefined)
          job.drain()
          jobs.delete(runId)
          executing.delete(runId)
          runningSlots.delete(runId)
        }
        admission.detach()
        admission.drain()
        admissions.delete(runId)
        recovered++
      }
      return recovered
    },
    resumeAfterStop(): boolean {
      if (admissions.size || executing.size) return false
      admissionPaused = false
      pump()
      return true
    },
    async stopAll(reason?: unknown, timeoutMs = 1500) {
      // Account changes stop existing work without permanently disabling the new account.
      requestStop(reason, false)
      return waitForStop(timeoutMs)
    },
  }
}

export const chatRuns = createChatRunManager(createChatRunJournal())

export const hasActiveChatRuns = (): boolean => chatRuns.hasLive()
