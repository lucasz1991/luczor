import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { lanState } from '@/services/coordination/lan'
import { deviceCluster } from '@/services/coordination/channel'
import { coordinationApi } from '@/services/coordination/api'
import { DEVICE_READ_TOOLS, deviceAgentJobs, runLanAgent } from '@/services/coordination/lanAgents'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import type { AssistanceTask } from './adaptiveAssistance'
import type { WireMessage } from '@/services/inference/types'

export function deviceWorkers() {
  const lease = lanState.lease
  const granted = !!lease && lease.epoch >= lanState.authorityEpoch && Date.parse(lease.expires_at) > Date.now()
  const workers = Object.entries(lanState.workers ?? {})
    .slice(0, 64)
    .map(([id, presence]) => {
      const busy = presence.busy || [...deviceAgentJobs.values()].includes(id)
      const authorized = granted && !!lease?.target_device_ids.includes(id)
      const reachable = lanState.active && lanState.reachablePeers.includes(id)
      const ready = reachable && presence.protocol === 1 && presence.ready && authorized && !busy
      return {
        id,
        model: presence.modelId,
        platform: presence.platform,
        tier: presence.tier ?? 0,
        busy,
        ready,
        reason: ready
          ? 'ready'
          : !reachable
            ? 'unreachable'
            : presence.protocol !== 1
              ? 'client_update_required'
              : !authorized
                ? 'agent_lease_unavailable'
                : !presence.ready
                  ? 'model_not_ready'
                  : 'busy',
        transport: 'lan',
      }
    })
  for (const device of deviceCluster.coordinator?.devices ?? []) {
    if (
      device.client_id === deviceCluster.coordinator?.leader_device_id ||
      workers.some(worker => worker.id === device.client_id && worker.ready)
    )
      continue
    const busy = !!device.busy || [...deviceAgentJobs.values()].includes(device.client_id)
    const ready =
      deviceCluster.connected &&
      deviceCluster.coordinator?.role === 'master' &&
      device.available === true &&
      device.model_ready === true &&
      device.agent_protocol === 1 &&
      !busy
    const prior = workers.findIndex(worker => worker.id === device.client_id)
    if (prior >= 0 && !ready) continue
    const worker = {
      id: device.client_id,
      model: device.active_model_id,
      platform: device.platform,
      tier: device.model_tier ?? 0,
      busy,
      ready,
      reason: ready
        ? 'ready'
        : device.agent_protocol !== 1
          ? 'client_update_required'
          : !device.model_ready
            ? 'model_not_ready'
            : busy
              ? 'busy'
              : 'unreachable',
      transport: 'server',
    }
    if (prior >= 0) workers.splice(prior, 1, worker)
    else workers.push(worker)
  }
  return workers.sort(
    (left, right) =>
      Number(right.ready) - Number(left.ready) ||
      Number(right.transport === 'lan') - Number(left.transport === 'lan') ||
      right.tier - left.tier ||
      left.id.localeCompare(right.id)
  )
}

export function resolveAssistanceTarget(
  task: AssistanceTask,
  ownDevicesAllowed: boolean,
  externalAllowed: boolean
): AssistanceTask {
  if (task.target !== 'auto' && task.target !== 'device') return task
  const worker =
    ownDevicesAllowed && task.tools.every(tool => DEVICE_READ_TOOLS.includes(tool))
      ? deviceWorkers().find(worker => worker.ready && (!task.device_id || worker.id === task.device_id))
      : undefined
  if (worker) return { ...task, target: 'device', device_id: worker.id }
  if (
    task.target === 'auto' &&
    !task.device_id &&
    externalAllowed &&
    task.tools.every(tool => ['context_search', 'context_read'].includes(tool))
  )
    return { ...task, target: 'external' }
  throw new Error(
    'Kein freier, freigegebener Arbeitsagent für diesen Teilauftrag. Mit agent_assist_status den Grund prüfen und sonst direkt lokal weiterarbeiten.'
  )
}

export async function executeDeviceAssistance(
  task: AssistanceTask,
  projectId: string,
  messages: readonly WireMessage[],
  signal: AbortSignal
) {
  const account = await getVerifiedAccountSnapshot()
  signal.throwIfAborted()
  if (!account || !task.device_id)
    throw new Error('Gerätedelegation benötigt die bestätigte eigene Koordinator-Freigabe.')
  // Never export arbitrary runtime/system/tool messages. Choose complete bounded user/assistant entries.
  const selected = task.context_indices ?? messages.map((_, index) => index)
  if (selected.some(index => !Number.isInteger(index) || index < 0 || !messages.at(index)))
    throw new Error('Invalid device context selection.')
  const context: string[] = []
  let remaining = 23000 // Leave room for the subtask and wrapper in the server's 30,000 character packet.
  for (const index of [...selected].reverse()) {
    const message = messages.at(index)!
    if (!['user', 'assistant'].includes(message.role) || ('tool_calls' in message && message.tool_calls?.length))
      continue
    const text = `[${index} ${message.role}]\n${message.content}`
    if (text.length > remaining) continue
    context.unshift(text)
    remaining -= text.length + 2
  }
  const worker = deviceWorkers().find(worker => worker.id === task.device_id && worker.ready)
  if (!worker) throw new Error('Arbeitsgerät inzwischen belegt oder nicht bereit; kein Auftrag gestartet.')
  const operationId = crypto.randomUUID()
  deviceAgentJobs.set(operationId, task.device_id)
  try {
    const externalProjectId = task.tools.length ? projectExternalIdForServer(projectId, account.principalId) : undefined
    if (worker.transport === 'lan')
      return await runLanAgent(
        account,
        task.device_id,
        {
          task: task.task,
          role: task.role,
          context: context.join('\n\n'),
          tools: task.tools,
          projectId: externalProjectId,
        },
        signal
      )
    const api = coordinationApi(account.config, signal)
    const cluster = (await api.state()).data
    // Stable operation ID; uncertain admission never triggers a second transport or provider.
    const { data: job } = await api.dispatch({
      operation_id: operationId,
      target_device_id: task.device_id,
      master_epoch: cluster.epoch,
      project_id: externalProjectId,
      tool_profile: 'chat.turn',
      payload: {
        prompt: `${context.join('\n\n')}\n\nTeilauftrag (${task.role}): ${task.task}`,
        model_mode: 'local',
        thinking_tier: 'balanced',
        tool_allowlist: task.tools,
      },
    })
    try {
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        const { data: current } = await api.job(job.id)
        if (['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(current.status)) {
          const result = current.result ?? {}
          return {
            ...result,
            status: current.status,
            output: result.answer ?? '',
            ...(result.continuation_required ? { incomplete: true } : {}),
          }
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer)
            reject(signal.reason)
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
          }, 1000)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      }
      throw new Error('device_agent_result_timeout')
    } catch (error) {
      const stopApi = coordinationApi(account.config, AbortSignal.timeout(4000))
      void stopApi
        .state()
        .then(({ data }) => stopApi.cancel(job.id, data.epoch))
        .catch(() => {})
      throw error
    }
  } finally {
    deviceAgentJobs.delete(operationId)
  }
}

export function assistanceWorkerSummary(externalAllowed: boolean) {
  return {
    devices: deviceWorkers(),
    external: externalAllowed
      ? 'allowed; provider role readiness checked on dispatch'
      : 'context or settings prohibit external delegation',
    coordinatorOnline: deviceCluster.connected,
    sameInstance: 'sequential; prefer direct work',
    offlineLeaseExpiresAt: lanState.lease?.expires_at ?? null,
  }
}
