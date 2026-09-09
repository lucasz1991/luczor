import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { LuczorApi, requestWithConfig, type DeviceJob, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { requestConfirmation } from '@/services/confirmation'
import { executionGate, executionPayload, type ExecutionTicket } from '@/services/executionGate'
import { getProjectWorkspace, type ProjectWorkspaceBinding } from '@/services/projectWorkspace'
import { runWorkflowAgent } from '@/services/agents/workflowAgent'
import {
  isWorkflowTaskBundle,
  runWorkflowTask,
  type WorkflowTaskBundle,
  type WorkflowTaskPrimitives,
} from '@/services/workflowTaskRunner'
import {
  canonicalWorkflowPath,
  workflowAutomationAllows,
  workflowAutomationRevision,
  WORKFLOW_AUTOMATION_INVALIDATED,
} from './automation'
import { workflowAccountScope, workflowExecutionLedger } from './executionLedger'
import { runWorkflowLlm } from './llm'
import { createWorkflowBrowser } from './browser'
import { runWorkflowImage } from './image'
import { retainWorkflowResources, releaseWorkflowResources, sweepWorkflowResources } from './runResources'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function isDurableWorkflowJob(job: DeviceJob): boolean {
  return (
    job.tool_profile === 'workflow.task' &&
    isWorkflowTaskBundle(job.payload) &&
    typeof job.payload.workflow?.execution_id === 'string'
  )
}

/** Called after signature verification. Every effect uses explicit signed project/device context. */
export async function runWorkflowDeviceJob(
  job: DeviceJob,
  config: LuczorApiConfigSnapshot,
  parentTicket: ExecutionTicket,
  assertSession: () => void,
  preview: string
): Promise<void> {
  if (!isWorkflowTaskBundle(job.payload)) throw new Error('workflow_bundle_invalid')
  const bundle = job.payload
  const metadata = bundle.workflow
  const executionId = metadata?.execution_id
  if (!executionId || !UUID.test(executionId) || metadata.device_id !== config.clientId || !metadata.project_id)
    throw new Error('workflow_execution_identity_invalid')
  const account = await getVerifiedAccountSnapshot()
  assertSession()
  if (
    !account ||
    account.config.baseUrl !== config.baseUrl ||
    account.config.deviceKey !== config.deviceKey ||
    account.config.clientId !== config.clientId
  )
    throw new Error('workflow_execution_account_changed')
  const scope = await workflowAccountScope(config)
  const workspace = await getProjectWorkspace(metadata.project_id, account.principalId)
  assertSession()
  if (!workspace || workspace.status !== 'ready' || !workspace.updatedAt)
    throw new Error('workflow_execution_workspace_unavailable')
  if (
    metadata.file_scope === 'workspace' &&
    metadata.workspace_root_id &&
    canonicalWorkflowPath(metadata.workspace_root_id) !== canonicalWorkflowPath(workspace.rootPath)
  )
    throw new Error('workflow_execution_root_changed')
  const controller = new AbortController()
  let automated = false
  const automationRevision = workflowAutomationRevision(scope, metadata.definition_id ?? 0)
  const artifactScope = {
    principalId: account.principalId,
    projectId: metadata.project_id,
    expectedRootPath: workspace.rootPath,
    expectedWorkspaceUpdatedAt: workspace.updatedAt,
    runId: metadata.resource_run ?? metadata.run,
  }
  const ticket: ExecutionTicket = { ...parentTicket, signal: AbortSignal.any([parentTicket.signal, controller.signal]) }
  const assert = () => {
    assertSession()
    if (automated && workflowAutomationRevision(scope, metadata.definition_id ?? 0) !== automationRevision)
      controller.abort(new Error('workflow_automation_revoked'))
    executionGate.assert(ticket, true)
    ticket.signal.throwIfAborted()
  }
  const invalidate = (event: Event) => {
    const detail = (event as CustomEvent<{ scope?: string; definitionId?: number }>).detail
    if (automated && detail?.scope === scope && detail.definitionId === metadata.definition_id)
      controller.abort(new Error('workflow_automation_revoked'))
  }
  const nativeExecution = await executionPayload(parentTicket, true)
  let cancellation: Promise<unknown> | undefined
  const cancelNative = () => {
    cancellation = invoke('wf_execution_cancel', { payload: { execution: nativeExecution, executionId } }).catch(
      () => {}
    )
  }
  ticket.signal.addEventListener('abort', cancelNative, { once: true })
  let checking = false
  const checkCancellation = async () => {
    if (checking || ticket.signal.aborted) return
    checking = true
    try {
      const response = await requestWithConfig<{ data: { status: string; cancel_requested?: boolean } }>(
        `/devices/jobs/${encodeURIComponent(job.id)}/status`,
        { query: { client_id: config.clientId }, signal: parentTicket.signal },
        config
      )
      if (response.data.cancel_requested || response.data.status === 'cancelled') {
        controller.abort(new Error('workflow_cancelled'))
        cancellation = invoke('wf_execution_cancel', { payload: { execution: nativeExecution, executionId } })
        await cancellation
        await requestWithConfig(
          `/devices/jobs/${encodeURIComponent(job.id)}/cancel-ack`,
          { method: 'POST', body: { client_id: config.clientId }, signal: parentTicket.signal },
          config
        )
      }
    } catch (error) {
      if (!parentTicket.signal.aborted && !controller.signal.aborted) {
        // Loss of the control plane while effects run is a revocation boundary, not permission to continue.
        controller.abort(error)
        cancellation = invoke('wf_execution_cancel', { payload: { execution: nativeExecution, executionId } }).catch(
          () => {}
        )
      }
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => {
    void checkCancellation()
  }, 2000)
  window.addEventListener(WORKFLOW_AUTOMATION_INVALIDATED, invalidate)
  try {
    await checkCancellation()
    assert()
    const recovered = await workflowExecutionLedger.recover(scope, executionId, bundle)
    assert()
    if (recovered) {
      await LuczorApi.completeDeviceJob(
        job.id,
        config.clientId,
        recovered.ok !== false,
        recovered,
        recovered.ok === false ? String(recovered.error ?? recovered.code ?? 'workflow_step_failed') : undefined,
        config,
        ticket.signal
      )
      await workflowExecutionLedger.acknowledge(scope, executionId)
      return
    }
    automated = await workflowAutomationAllows(bundle, scope, account.principalId, config)
    assert()
    const approval = automated ? { approved: true } : await requestConfirmation(preview, 'Luczor – Workflow-Schritt')
    assert()
    if (!approval.approved || ('error' in approval && approval.error)) {
      if (job.status === 'approval_required')
        await LuczorApi.approveDeviceJob(
          job.id,
          config.clientId,
          false,
          'Rejected on local device',
          config,
          ticket.signal
        )
      else
        await LuczorApi.completeDeviceJob(
          job.id,
          config.clientId,
          false,
          undefined,
          'Rejected on local device',
          config,
          ticket.signal
        )
      return
    }
    if (job.status === 'approval_required')
      await LuczorApi.approveDeviceJob(job.id, config.clientId, true, undefined, config, ticket.signal)
    assert()
    const result = await workflowExecutionLedger.execute(scope, executionId, bundle, async () => {
      await LuczorApi.startDeviceJob(job.id, config.clientId, config, ticket.signal)
      assert()
      try {
        if (bundle.task_key.startsWith('browser.')) {
          // Another root may have completed earlier in this same device-job batch.
          await sweepWorkflowResources(config, ticket.signal)
          assert()
          retainWorkflowResources(
            artifactScope,
            config,
            automated
              ? { accountScope: scope, definitionId: metadata.definition_id!, revision: automationRevision }
              : undefined
          )
        }
        const result = await runWorkflowTask(
          bundle,
          workflowPrimitives(bundle, account.principalId, workspace, ticket, assert, automated)
        )
        assert()
        const resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
        const grant = metadata.grant as { config?: { max_output_bytes?: number } } | undefined
        const maximum = automated ? Math.min(grant?.config?.max_output_bytes ?? 65536, 1048576) : 200000
        if (resultBytes > maximum) return { ok: false, code: 'workflow_result_budget_exceeded' }
        return result
      } catch (error) {
        if (ticket.signal.aborted) throw error
        return { ok: false, error: error instanceof Error ? error.message : 'workflow_step_failed' }
      }
    })
    assert()
    // The result is durably stored now. An acknowledgment failure must not become a different failed result.
    await LuczorApi.completeDeviceJob(
      job.id,
      config.clientId,
      result.ok !== false,
      result,
      result.ok === false ? String(result.error ?? result.code ?? 'workflow_step_failed') : undefined,
      config,
      ticket.signal
    )
    await workflowExecutionLedger.acknowledge(scope, executionId)
  } finally {
    window.removeEventListener(WORKFLOW_AUTOMATION_INVALIDATED, invalidate)
    clearInterval(timer)
    ticket.signal.removeEventListener('abort', cancelNative)
    if (cancellation) await cancellation.catch(() => {})
    if (ticket.signal.aborted) await releaseWorkflowResources(artifactScope).catch(() => {})
  }
}

function workflowPrimitives(
  bundle: WorkflowTaskBundle,
  principalId: string,
  workspace: ProjectWorkspaceBinding,
  ticket: ExecutionTicket,
  assert: () => void,
  automated: boolean
): WorkflowTaskPrimitives {
  const projectId = bundle.workflow.project_id!
  const workspaceIdentity = {
    principalId,
    projectId,
    expectedRootPath: workspace.rootPath,
    expectedWorkspaceUpdatedAt: workspace.updatedAt,
  }
  const invokeTask = async <T>(command: string, payload: Record<string, unknown>, mutating = true): Promise<T> => {
    assert()
    const execution = await executionPayload(ticket, mutating)
    const result = await invoke<T>(command, {
      payload: { ...payload, execution: { ...execution, workflowExecutionId: bundle.workflow.execution_id } },
    })
    assert()
    return result
  }
  const workspaceFiles = bundle.workflow.file_scope === 'workspace'
  const artifactScope = {
    ...workspaceIdentity,
    expectedWorkspaceUpdatedAt: workspace.updatedAt!,
    runId: bundle.workflow.resource_run ?? bundle.workflow.run,
  }
  return {
    openUrl: url => invokeTask('open_url', { url }),
    httpFetch: (method, url, headers, body) =>
      invokeTask('wf_http_request', { method, url, headers, body, timeout_seconds: 30 }),
    runAgent: (agent, prompt, projectDir, options) =>
      runWorkflowAgent(agent, prompt, projectDir ?? workspace.rootPath, ticket.signal, projectId, options),
    runLlm: input => runWorkflowLlm(input, { projectId, ticket, thinkingTier: bundle.workflow.thinking_tier }),
    runAgentFlow: async (team, params) => {
      const { runWorkflowAgentFlow } = await import('./agentFlow')
      assert()
      return runWorkflowAgentFlow(team, params, { projectId, ticket, thinkingTier: bundle.workflow.thinking_tier })
    },
    browserSession: createWorkflowBrowser({
      scope: artifactScope,
      invokeTask,
      automated,
      allowedHosts: automated
        ? (bundle.workflow.grant as { config: { egress_hosts: string[] } }).config.egress_hosts
        : undefined,
    }),
    runImage: input => runWorkflowImage(input, { scope: artifactScope, invokeTask }),
    fileRead: async path => {
      if (!workspaceFiles) return invokeTask('wf_file_read', { path }, false)
      const result = await invokeTask<{ content: string; bytes: number; truncated: boolean }>(
        'project_fs_read',
        { ...workspaceIdentity, path, maxBytes: 20000 },
        false
      )
      return result
    },
    fileWrite: async (path, content) => {
      if (!workspaceFiles) return invokeTask('wf_file_write', { path, content })
      return invokeTask('project_fs_write', { ...workspaceIdentity, path, content, originRunId: bundle.workflow.run })
    },
    runScript: (runtime, code, timeoutSeconds, input) =>
      invokeTask('wf_run_script', {
        runtime,
        code,
        timeout_seconds: timeoutSeconds ?? null,
        fullAccessAcknowledged: true,
        scope: artifactScope,
        ...(input !== undefined ? { input } : {}),
      }),
    browserOpen: url => invokeTask('browser_open', { url: url ?? null }),
    browserClick: (selector, expectedUrl) => invokeTask('browser_click', { selector, expectedUrl }),
    browserRead: (selector, expectedUrl) =>
      invokeTask('browser_read', { selector: selector ?? null, expectedUrl }, false),
  }
}
