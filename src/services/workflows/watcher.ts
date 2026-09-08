import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig } from '@/services/api/luczorApi'
import { executionGate, invokeGuarded, onExecutionInvalidated } from '@/services/executionGate'
import { getProjectWorkspace } from '@/services/projectWorkspace'
import { canonicalWorkflowPath, getLocalWorkflowAutomationGrant, type WorkflowAutomationGrant } from './automation'
import { workflowAccountScope, workflowHash } from './executionLedger'

type FileTrigger = {
  id: number
  public_id: string
  workflow_definition_id: number
  project_external_id: string
  enabled: boolean
  config: { device_id: string; root_path: string; paths: string[]; excludes?: string[]; debounce_seconds?: number }
}
type NativeEvent = {
  id: string
  watcherId: string
  rootPath: string
  changes: Array<{ path: string; kind: 'created' | 'modified' | 'deleted' | 'rescan' }>
  occurredAt: number
  originRunId?: string
}
let stopActive: (() => void) | undefined

/** The app owns this lifecycle. Only locally confirmed, currently server-enabled triggers start watchers. */
export async function startWorkflowWatchers(): Promise<() => void> {
  stopActive?.()
  const controller = new AbortController()
  const ticket = executionGate.capture(controller.signal)
  let active = true
  let scope = ''
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (!active) return
    active = false
    controller.abort()
    if (timer) clearInterval(timer)
    removeInvalidation()
    if (scope) void invoke('wf_watch_stop', { payload: { scope } }).catch(() => {})
    if (stopActive === stop) stopActive = undefined
  }
  stopActive = stop
  const removeInvalidation = onExecutionInvalidated(stop)
  const assert = () => {
    if (!active) throw new Error('workflow_watcher_stopped')
    executionGate.assert(ticket, true)
  }
  try {
    assert()
    const account = await getVerifiedAccountSnapshot()
    assert()
    if (!account) {
      stop()
      return stop
    }
    scope = await workflowAccountScope(account.config)
    const triggers = new Map<string, FileTrigger>()
    let fingerprint = ''
    let busy = false
    const refresh = async () => {
      if (busy || !active) return
      busy = true
      try {
        assert()
        const response = await requestWithConfig<{ data: FileTrigger[] }>(
          '/workflow-triggers/device',
          { query: { device_id: account.config.clientId }, signal: ticket.signal },
          account.config
        )
        assert()
        const admitted: Array<{ trigger: FileTrigger; payload: Record<string, unknown> }> = []
        for (const trigger of response.data.slice(0, 32)) {
          if (!trigger.enabled || trigger.config.device_id !== account.config.clientId || !trigger.project_external_id)
            continue
          const local = await getLocalWorkflowAutomationGrant(scope, trigger.workflow_definition_id)
          if (
            !local ||
            local.principalId !== account.principalId ||
            local.grant.status !== 'active' ||
            !local.grant.config.allowed_input_sources.includes('event')
          )
            continue
          const remote = await requestWithConfig<{ data: { grant: WorkflowAutomationGrant | null } }>(
            `/workflows/${trigger.workflow_definition_id}/automation`,
            { signal: ticket.signal },
            account.config
          )
          assert()
          if (
            !remote.data.grant ||
            remote.data.grant.status !== 'active' ||
            remote.data.grant.id !== local.grant.id ||
            remote.data.grant.scope_hash !== local.grant.scope_hash
          )
            continue
          const workspace = await getProjectWorkspace(trigger.project_external_id, account.principalId)
          assert()
          if (
            !workspace ||
            workspace.status !== 'ready' ||
            workspace.updatedAt !== local.workspaceUpdatedAt ||
            canonicalWorkflowPath(workspace.rootPath) !== canonicalWorkflowPath(trigger.config.root_path) ||
            canonicalWorkflowPath(workspace.rootPath) !== canonicalWorkflowPath(local.grant.config.root_path)
          )
            continue
          admitted.push({
            trigger,
            payload: {
              scope,
              watcherId: trigger.public_id,
              principalId: account.principalId,
              projectId: trigger.project_external_id,
              expectedRootPath: workspace.rootPath,
              expectedWorkspaceUpdatedAt: workspace.updatedAt,
              paths: trigger.config.paths,
              excludes: trigger.config.excludes ?? [],
              debounceMs: Math.max(250, (trigger.config.debounce_seconds ?? 2) * 1000),
            },
          })
        }
        const next = await workflowHash(admitted)
        assert()
        if (next !== fingerprint) {
          await invoke('wf_watch_stop', { payload: { scope } })
          triggers.clear()
          for (const item of admitted) {
            assert()
            await invokeGuarded('wf_watch_start', item.payload, ticket, true)
            triggers.set(item.trigger.public_id, item.trigger)
          }
          fingerprint = next
        }
        const events = await invokeGuarded<NativeEvent[]>('wf_watch_drain', { scope }, ticket, false)
        for (const event of events) {
          assert()
          const trigger = triggers.get(event.watcherId)
          // A revoked/removed trigger cannot be resurrected by a durable old event.
          if (trigger && canonicalWorkflowPath(event.rootPath) === canonicalWorkflowPath(trigger.config.root_path)) {
            await requestWithConfig(
              '/workflow-events',
              {
                method: 'POST',
                body: {
                  trigger_id: trigger.id,
                  event_id: event.id,
                  device_id: account.config.clientId,
                  root_path: trigger.config.root_path,
                  changes: event.changes,
                  occurred_at: new Date(event.occurredAt).toISOString(),
                  ...(event.originRunId ? { origin_run_id: event.originRunId } : {}),
                },
                signal: ticket.signal,
              },
              account.config
            )
          }
          assert()
          await invokeGuarded('wf_watch_ack', { scope, eventIds: [event.id] }, ticket, false)
        }
      } catch {
        // Keep the native metadata outbox while offline. The next successful poll retries the same IDs.
        if (ticket.signal.aborted) stop()
      } finally {
        busy = false
      }
    }
    await refresh()
    if (active)
      timer = setInterval(() => {
        void refresh()
      }, 15000)
  } catch {
    stop()
  }
  return stop
}

export function stopWorkflowWatchers(): void {
  stopActive?.()
}
