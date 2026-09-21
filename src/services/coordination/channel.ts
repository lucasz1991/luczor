import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getVerifiedAccountSnapshot, type VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { executionGate, type ExecutionTicket } from '@/services/executionGate'
import { projectLocalIdForServer } from '@/services/cloudProjectAccess'
import { coordinationApi, type CoordinatedJob, type CoordinationState } from './api'
import { hasActiveChatRuns } from '@/services/chatRunManager'
import { syncConversations } from './conversations'
import { refreshLan, sendLan, stopLan, forgetLanTrust, lanState, updateLanAuthority } from './lan'
import { createProgressReporter } from './progress'
import { coordinationMetadata } from './preferences'
import { hasLanAgentRuns } from './lanAgents'

export const deviceCluster = reactive({
  running: false,
  connected: false,
  pending: false,
  error: '',
  coordinator: null as CoordinationState | null,
  jobs: [] as CoordinatedJob[],
  activeJobs: [] as string[],
})
type Journal = Record<string, unknown> & { revision: number; state: string; payloadHash: string }
export type CoordinatedExecutor = (
  job: CoordinatedJob,
  account: VerifiedAccountSnapshot,
  ticket: ExecutionTicket,
  progress: (summary: string) => Promise<void>,
  beforeEffect: () => Promise<void>
) => Promise<Record<string, unknown>>
let channelGeneration = 0
const ownExecutions = new Map<string, AbortController>()
let stopCurrent: (() => void) | null = null
let drainCurrent: (() => Promise<void>) | null = null

export function stopCoordinationChannel(): void {
  stopCurrent?.()
}
export async function drainCoordinationChannel(): Promise<void> {
  await drainCurrent?.()
}

/** The native timer remains active while the ordinary main webview is hidden in the tray. */
export async function startCoordinationChannel(execute: CoordinatedExecutor): Promise<() => void> {
  stopCurrent?.()
  const generation = ++channelGeneration
  const controller = new AbortController()
  let unlisten: (() => void) | undefined
  let checking = false
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  const wake = () => {
    if (!current() || wakeTimer) return
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined
      void tick()
    }, 500)
  }
  let retryAt = 0
  let identity: VerifiedAccountSnapshot | null = null
  const activeTasks = new Set<Promise<void>>()
  const current = () => generation === channelGeneration && !controller.signal.aborted
  const assert = () => {
    if (!current()) throw new Error('Die Geräteverbindung wurde geändert.')
  }
  const stop = () => {
    if (!current()) return
    ++channelGeneration
    controller.abort()
    unlisten?.()
    if (wakeTimer) clearTimeout(wakeTimer)
    window.removeEventListener('luczor:coordination-wake', wake)
    window.removeEventListener('luczor:api-identity-changing', stop)
    stopLan()
    ownExecutions.forEach(abort => abort.abort())
    ownExecutions.clear()
    Object.assign(deviceCluster, {
      running: false,
      connected: false,
      pending: false,
      error: '',
      coordinator: null,
      jobs: [],
      activeJobs: [],
    })
    if (stopCurrent === stop) {
      stopCurrent = null
      drainCurrent = null
    }
  }
  stopCurrent = stop
  drainCurrent = async () => {
    const account = identity
    const waiting = [...activeTasks]
    stop()
    const release = account
      ? coordinationApi(account.config, AbortSignal.timeout(2000))
          .heartbeat(false, false)
          .catch(() => {})
      : Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled([release, ...waiting]),
      new Promise(resolve => {
        timer = setTimeout(resolve, 4000)
      }),
    ])
    if (timer) clearTimeout(timer)
  }
  window.addEventListener('luczor:api-identity-changing', stop)
  deviceCluster.running = true

  const run = async (incoming: CoordinatedJob, account: VerifiedAccountSnapshot) => {
    if (ownExecutions.has(incoming.id) || !current()) return
    const cancel = new AbortController()
    ownExecutions.set(incoming.id, cancel)
    deviceCluster.activeJobs = [...ownExecutions.keys()]
    const signal = AbortSignal.any([controller.signal, cancel.signal])
    const api = coordinationApi(account.config, controller.signal)
    let journal: Journal | null = null
    let job = incoming
    let cancellationTimer: ReturnType<typeof setInterval> | undefined
    let leaseExpired = false
    const read = () =>
      invoke<Journal | null>('device_run_journal_read', {
        payload: { ownerPrincipalId: account.principalId, runId: incoming.id },
      })
    const save = async (state: string, fields: Record<string, unknown> = {}) => {
      assert()
      journal = await invoke<Journal>('device_run_journal_transition', {
        payload: {
          ownerPrincipalId: account.principalId,
          expectedRevision: journal?.revision ?? 0,
          record: {
            ...Object.fromEntries(
              Object.entries(journal ?? {}).filter(([key]) => !['revision', 'createdAt', 'updatedAt'].includes(key))
            ),
            kind: 'device',
            principalId: account.principalId,
            deviceId: account.config.clientId,
            jobId: job.id,
            runId: job.id,
            projectId: job.project_id ?? undefined,
            payloadHash: job.payload_hash,
            state,
            ...fields,
          },
        },
      })
      assert()
    }
    try {
      if (
        job.protocol_version !== 2 ||
        job.user_id !== account.accountId ||
        job.target_device_id !== account.config.clientId
      )
        throw new Error('Der signierte Auftrag gehört nicht zu diesem Konto und Gerät.')
      journal = await read()
      assert()
      if (journal && journal.payloadHash !== job.payload_hash)
        throw new Error('Der Auftrag wurde nachträglich verändert.')
      if (journal?.state === 'acknowledged') return
      const checkpoint = journal?.checkpoint as { attemptId?: string; masterEpoch?: number } | undefined
      if (journal?.state === 'completed' && checkpoint?.attemptId) {
        await api.complete(
          job.id,
          checkpoint.attemptId,
          checkpoint.masterEpoch ?? job.master_epoch,
          journal.result as Record<string, unknown>
        )
        await save('acknowledged')
        return
      }
      if (journal?.state === 'cancelled' && checkpoint?.attemptId) {
        await api.cancelAck(job.id, checkpoint.attemptId, checkpoint.masterEpoch ?? job.master_epoch)
        await save('acknowledged')
        return
      }
      if (!journal && (job.attempt_id || job.status !== 'queued')) {
        // Server-side ownership does not prove whether this device already performed an effect.
        // A missing local journal must never be treated as a fresh queued request.
        await save('outcome_unknown', {
          checkpoint: {
            ...(job.attempt_id ? { attemptId: job.attempt_id } : {}),
            masterEpoch: job.master_epoch,
            summary: 'Das lokale Ausführungsjournal fehlt. Den bisherigen Ausgang vor einer Wiederholung prüfen.',
          },
        })
        return
      }
      if (journal && journal.state !== 'queued') {
        // A crash between effect and result cannot prove that repeating it is safe.
        await save('outcome_unknown')
        // Do not reuse a sequence that may already have been acknowledged before the crash.
        return
      }
      await invoke('verify_device_job', {
        payload: {
          ...job,
          expected_user_id: account.accountId,
          expected_target_device_id: account.config.clientId,
          expected_master_epoch: job.master_epoch,
          require_claimed: false,
        },
      })
      assert()
      const attemptId = checkpoint?.attemptId ?? crypto.randomUUID()
      if (!journal || checkpoint?.masterEpoch !== job.master_epoch)
        await save('queued', { checkpoint: { attemptId, masterEpoch: job.master_epoch } })
      job = (await api.claim(job.id, attemptId, job.master_epoch)).data
      assert()
      await invoke('verify_device_job', {
        payload: {
          ...job,
          expected_user_id: account.accountId,
          expected_target_device_id: account.config.clientId,
          expected_master_epoch: job.master_epoch,
          require_claimed: true,
        },
      })
      assert()
      if (job.attempt_id !== attemptId) throw new Error('Der Ausführungsversuch wurde nicht bestätigt.')
      const desktop = job.tool_profile.startsWith('desktop.')
      const projectId = job.project_id
        ? projectLocalIdForServer(job.project_id, account.principalId)
        : `device:${account.config.clientId}`
      // Observe and the following input share a session, while stop signals stay per job.
      const runId = desktop ? `desktop:${job.source_device_id}:${job.master_epoch}:${projectId}` : job.id
      const ticket = executionGate.capture(signal, {
        projectId,
        runId,
        ...(!desktop && job.conversation_id ? { conversationId: job.conversation_id } : {}),
      })
      await save('started')
      let lastRenewal = Date.now()
      let authorityEpoch = job.authority_epoch ?? job.master_epoch
      const reporter = createProgressReporter(async (sequence, summary) => {
        assert()
        void sendLan(job.source_device_id, 'progress', {
          jobId: job.id,
          masterEpoch: job.master_epoch,
          summary: summary.slice(0, 4000),
        }).catch(() => {})
        await api.progress(job.id, attemptId, job.master_epoch, sequence, 'running', summary, authorityEpoch)
        lastRenewal = Date.now()
      })
      const progress = reporter.report
      const beforeEffect = async () => {
        executionGate.assert(ticket)
        let latest = (await api.job(job.id)).data
        while (latest.reconciliation_required && Date.now() - lastRenewal < 40000) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer)
              reject(ticket.signal.reason)
            }
            const timer = setTimeout(() => {
              ticket.signal.removeEventListener('abort', abort)
              resolve()
            }, 1000)
            ticket.signal.addEventListener('abort', abort, { once: true })
            if (ticket.signal.aborted) abort()
          })
          executionGate.assert(ticket)
          latest = (await api.job(job.id)).data
        }
        executionGate.assert(ticket)
        if (
          latest.attempt_id !== attemptId ||
          latest.reconciliation_required ||
          latest.cancel_requested ||
          latest.status !== 'running'
        )
          throw new Error(
            'Der Geräteauftrag wartet auf bestätigte Ausführungsrechte. Der bisherige Fortschritt bleibt erhalten.'
          )
        authorityEpoch = latest.authority_epoch ?? job.master_epoch
        await progress('Ausführungsberechtigung vor dem nächsten Werkzeug geprüft.')
        executionGate.assert(ticket)
      }
      let polling = false
      cancellationTimer = setInterval(() => {
        if (Date.now() - lastRenewal >= 43000) {
          leaseExpired = true
          cancel.abort(
            new Error('Die Ausführungsberechtigung konnte nicht erneuert werden. Der Fortschritt bleibt erhalten.')
          )
        }
        if (polling || signal.aborted) return
        polling = true
        void api
          .job(job.id)
          .then(async ({ data }) => {
            assert()
            authorityEpoch = data.authority_epoch ?? authorityEpoch
            if (data.cancel_requested || ['cancel_requested', 'cancelled'].includes(data.status))
              cancel.abort(new Error('Der Auftrag wurde gestoppt.'))
            if (!data.reconciliation_required && Date.now() - lastRenewal > 10000) {
              await progress('Das Zielgerät bearbeitet den Auftrag weiterhin.')
              lastRenewal = Date.now()
            }
          })
          .catch(() => {
            /* Completion remains journaled until the server confirms it. */
          })
          .finally(() => {
            polling = false
          })
      }, 2000)
      let completion: Record<string, unknown>
      try {
        await beforeEffect()
        const result = await execute(job, account, ticket, progress, beforeEffect)
        executionGate.assert(ticket)
        completion = { ok: result.ok !== false, result }
      } catch (error) {
        assert()
        if (cancel.signal.aborted) {
          if (leaseExpired) {
            await save('outcome_unknown')
            return
          }
          await save('cancelled')
          await api.cancelAck(job.id, attemptId, job.master_epoch)
          await save('acknowledged')
          return
        }
        completion = {
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 2000) : 'Geräteauftrag fehlgeschlagen.',
        }
      }
      await reporter.flush().catch(() => {})
      await save('completed', { result: completion })
      await sendLan(job.source_device_id, 'result', {
        jobId: job.id,
        masterEpoch: job.master_epoch,
        attemptId,
        completion,
      }).catch(() => false)
      await api.complete(job.id, attemptId, job.master_epoch, completion)
      await save('acknowledged')
    } catch (error) {
      if (current()) deviceCluster.error = error instanceof Error ? error.message : 'Geräteauftrag nicht bestätigt.'
    } finally {
      if (cancellationTimer) clearInterval(cancellationTimer)
      if (ownExecutions.get(incoming.id) === cancel) ownExecutions.delete(incoming.id)
      if (current()) deviceCluster.activeJobs = [...ownExecutions.keys()]
    }
  }
  const launch = (job: CoordinatedJob, account: VerifiedAccountSnapshot) => {
    const task = run(job, account).finally(() => activeTasks.delete(task))
    activeTasks.add(task)
  }
  const tick = async () => {
    if (!current() || checking || Date.now() < retryAt) return
    checking = true
    try {
      let verified: VerifiedAccountSnapshot | null
      try {
        // Offline transport failures resolve through the authenticated account cache. A rejection here is not offline permission.
        verified = await getVerifiedAccountSnapshot()
        if (!verified) throw new Error('Für den Geräteverbund bitte am Server anmelden.')
      } catch (error) {
        stop()
        await forgetLanTrust(identity ?? undefined)
        deviceCluster.error = error instanceof Error ? error.message : 'Die Account-Zuordnung wurde abgelehnt.'
        return
      }
      assert()
      if (!verified) throw new Error('Für den Geräteverbund bitte am Server anmelden.')
      if (
        identity &&
        (identity.principalId !== verified.principalId ||
          identity.config.clientId !== verified.config.clientId ||
          identity.config.baseUrl !== verified.config.baseUrl ||
          identity.config.deviceKey !== verified.config.deviceKey)
      ) {
        stop()
        return
      }
      identity ??= verified
      // Discovery can resume from signed cached trust even when heartbeat fails.
      const lan = refreshLan(identity, controller.signal).catch(error => {
        if (current()) lanState.error = error instanceof Error ? error.message : String(error)
      })
      const api = coordinationApi(identity.config, controller.signal)
      const heartbeat = await api.heartbeat(
        ownExecutions.size > 0 || hasActiveChatRuns() || hasLanAgentRuns(),
        true,
        await coordinationMetadata(identity)
      )
      assert()
      deviceCluster.coordinator = heartbeat.data
      void lan
        .then(() =>
          updateLanAuthority(identity!, heartbeat.data.epoch, heartbeat.data.leader_device_id, controller.signal)
        )
        .catch(error => {
          if (current()) lanState.error = error instanceof Error ? error.message : String(error)
        })
      deviceCluster.connected = true
      deviceCluster.error = ''
      const pending = await api.pending()
      assert()
      for (const job of pending.data) launch(job, identity)
      const list = await api.jobs()
      assert()
      deviceCluster.jobs = list.data
      const undelivered = await invoke<Array<{ runId: string; jobId?: string }>>('device_run_journal_list', {
        payload: {
          ownerPrincipalId: identity.principalId,
          kind: 'device',
          states: ['completed', 'cancelled'],
          transportJobsOnly: true,
          limit: 100,
        },
      })
      assert()
      for (const record of undelivered) {
        if (!record.jobId || record.runId !== record.jobId) continue
        const job = list.data.find(job => job.id === record.jobId) ?? (await api.job(record.jobId)).data
        assert()
        launch(job, identity)
      }
      if (heartbeat.data.leader_device_id === identity.config.clientId) {
        for (const job of list.data) {
          if (job.reconciliation_required && job.attempt_id && job.status === 'running') {
            await api.adopt(job.id, job.attempt_id, heartbeat.data.epoch)
            assert()
          }
        }
      }
      void syncConversations(controller.signal).catch(error => {
        if (current()) deviceCluster.error = error instanceof Error ? error.message : 'Chatabgleich wartet.'
      })
    } catch (error) {
      if (current()) {
        deviceCluster.connected = false
        deviceCluster.error = error instanceof Error ? error.message : 'Der Geräteverbund ist nicht erreichbar.'
        retryAt = Date.now() + 10_000
      }
    } finally {
      checking = false
    }
  }
  try {
    window.addEventListener('luczor:coordination-wake', wake)
    unlisten = await listen('luczor://worker-tick', () => {
      void tick()
    })
    if (!current()) unlisten()
    else await tick()
  } catch (error) {
    stop()
    throw error
  }
  return stop
}
