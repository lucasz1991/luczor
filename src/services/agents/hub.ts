import { shallowRef, watch } from 'vue'
import { state } from '@/state/store'
import { hud } from '@/state/hud'
import { getProjectWorkspace, resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
import { buildProjectStartContext } from '@/services/prompt/projectStartContext'
import type { LuczorMode } from '@/services/inference/types'
import { AgentOrchestrator } from './orchestrator'
import { createCodexAgentAdapter } from './codexAgent'
import { createModelAgentAdapter, type ModelAgentApprovalRequest } from './modelAgent'
import { getAgentProjectLink, saveAgentProjectLink } from './links'
import type { AgentJobInput, AgentPermission, AgentProjectSnapshot } from './types'

export const agentHubRevision = shallowRef(0)
export const agentExternalApprovals = shallowRef<readonly ModelAgentApprovalRequest[]>([])
const approvalResolvers = new Map<string, (approved: boolean) => void>()
const principals = new Set<string>()
let getMode: () => LuczorMode = () => 'observe'
let timer: ReturnType<typeof setInterval> | undefined
let checking = false
let configurationGeneration = 0
let stopControls: (() => void) | undefined
let stopIdentityListener: (() => void) | undefined

function validateControls(permission: AgentPermission) {
  if (hud.killSwitch) throw new Error('Not-Aus ist aktiv.')
  if (permission === 'workspace-write' && getMode() === 'observe')
    throw new Error('Schreibzugriff benötigt den Modus Handeln.')
}

async function validateScope(project: AgentProjectSnapshot, permission: AgentPermission) {
  validateControls(permission)
  if ((await resolveWorkspacePrincipalId()) !== project.principalId)
    throw new Error('Das aktive Konto hat sich geändert.')
  if (!state.projects.some(item => item.id === project.projectId && !item.archivedAt))
    throw new Error('Das Projekt ist nicht mehr aktiv.')
  const workspace = await getProjectWorkspace(project.projectId, project.principalId)
  if (
    project.rootPath !== workspace?.rootPath ||
    project.workspaceUpdatedAt !== workspace?.updatedAt ||
    (workspace && workspace.status !== 'ready')
  ) {
    throw new Error('Die Projektordner-Zuordnung hat sich geändert.')
  }
  validateControls(permission)
}

function requestExternalApproval(request: ModelAgentApprovalRequest): Promise<boolean> {
  return new Promise(resolve => {
    approvalResolvers.set(request.jobId, resolve)
    agentExternalApprovals.value = [...agentExternalApprovals.value, request]
  })
}

export function resolveAgentExternalApproval(jobId: string, approved: boolean) {
  approvalResolvers.get(jobId)?.(approved)
  approvalResolvers.delete(jobId)
  agentExternalApprovals.value = agentExternalApprovals.value.filter(item => item.jobId !== jobId)
}

export const agentHub = new AgentOrchestrator({
  adapters: [
    createCodexAgentAdapter(),
    createModelAgentAdapter({ id: 'local' }),
    createModelAgentAdapter({ id: 'policy', requestExternalApproval }),
  ],
  validateScope,
  onMetadata(metadata) {
    principals.add(metadata.principalId)
    if (['completed', 'failed', 'cancelled'].includes(metadata.status)) resolveAgentExternalApproval(metadata.id, false)
    if (metadata.status === 'completed' && metadata.adapterId === 'codex' && metadata.externalThreadId) {
      const job = agentHub.getJob(metadata.id)
      if (job)
        void saveAgentProjectLink(job.project, metadata.externalThreadId, project =>
          validateScope(project, 'read-only')
        ).catch(() => undefined)
    }
  },
})
agentHub.subscribe(() => {
  agentHubRevision.value++
})

export async function agentProjectSnapshot(projectId: string): Promise<AgentProjectSnapshot> {
  const project = state.projects.find(item => item.id === projectId && !item.archivedAt)
  if (!project) throw new Error('Projekt nicht gefunden.')
  const principalId = await resolveWorkspacePrincipalId()
  const workspace = await getProjectWorkspace(projectId, principalId)
  return {
    principalId,
    projectId,
    projectName: project.name,
    rootPath: workspace?.rootPath,
    workspaceUpdatedAt: workspace?.updatedAt,
  }
}

export async function prepareAgentJob(input: {
  projectId: string
  adapterId: 'codex' | 'local' | 'policy'
  prompt: string
  role: AgentJobInput['role']
  permission: AgentPermission
  model?: string
  includeMemory?: boolean
  resume?: boolean
}) {
  if (!input.prompt.trim() || input.prompt.length > 24_000)
    throw new Error('Bitte einen Arbeitsauftrag mit 1 bis 24000 Zeichen eingeben.')
  const project = state.projects.find(item => item.id === input.projectId)
  if (!project) throw new Error('Projekt nicht gefunden.')
  const snapshot = await agentProjectSnapshot(project.id)
  await validateScope(snapshot, input.permission)
  if (input.adapterId === 'codex') {
    if (!snapshot.rootPath) throw new Error('Bitte zuerst einen Projektordner zuordnen.')
    if ((await getRepositoryExternalPolicy()) === 'deny')
      throw new Error('Die Repository-Richtlinie verbietet externe Coding-Agenten.')
  }
  const workspace = await getProjectWorkspace(project.id, snapshot.principalId)
  const context = await buildProjectStartContext({ project, workspace, includeMemory: input.includeMemory === true })
  const link = input.resume && input.adapterId === 'codex' ? await getAgentProjectLink(snapshot) : undefined
  if (input.resume && !link) throw new Error('Für diesen Projektordner besteht noch keine Codex-Verknüpfung.')
  await validateScope(snapshot, input.permission)
  const job = agentHub.enqueue({
    project: snapshot,
    adapterId: input.adapterId,
    prompt: `${context.providerText}\n\nArbeitsauftrag:\n${input.prompt}`,
    role: input.role,
    permission: input.permission,
    model: input.model?.trim() || undefined,
    externalThreadId: link?.externalThreadId,
  })
  return job
}

/** Keep the live mode and account boundaries effective while workers run. */
export function configureAgentHub(modeReader: () => LuczorMode): () => void {
  const generation = ++configurationGeneration
  getMode = modeReader
  if (timer) clearInterval(timer)
  stopIdentityListener?.()
  const invalidateIdentity = () => {
    for (const principal of [...principals]) agentHub.clearPrincipal(principal)
    principals.clear()
    for (const jobId of [...approvalResolvers.keys()]) resolveAgentExternalApproval(jobId, false)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('luczor:api-identity-changing', invalidateIdentity)
    stopIdentityListener = () => window.removeEventListener('luczor:api-identity-changing', invalidateIdentity)
  }
  stopControls?.()
  stopControls = watch(
    [() => hud.killSwitch, () => getMode()],
    () => {
      for (const principal of principals)
        for (const job of agentHub.listJobs(principal)) {
          if (hud.killSwitch || (getMode() === 'observe' && job.permission === 'workspace-write'))
            agentHub.cancel(job.id)
        }
    },
    { flush: 'sync' }
  )
  timer = setInterval(() => {
    if (checking || principals.size === 0) return
    checking = true
    void (async () => {
      const principal = await resolveWorkspacePrincipalId()
      if (generation !== configurationGeneration) return
      for (const job of [...principals].flatMap(id => [...agentHub.listJobs(id)])) {
        if (job.principalId !== principal) {
          agentHub.clearPrincipal(job.principalId)
          principals.delete(job.principalId)
          continue
        }
        if (!['awaiting_approval', 'queued', 'running'].includes(job.status)) continue
        try {
          await validateScope(job.project, job.permission)
          if (job.adapterId === 'codex' && (await getRepositoryExternalPolicy()) === 'deny')
            throw new Error('Externe Agenten gesperrt.')
        } catch {
          if (generation === configurationGeneration) agentHub.cancel(job.id)
        }
      }
    })()
      .catch(() => {
        if (generation === configurationGeneration)
          for (const id of principals) for (const job of agentHub.listJobs(id)) agentHub.cancel(job.id)
      })
      .finally(() => {
        checking = false
      })
  }, 2000)
  return () => {
    if (generation !== configurationGeneration) return
    configurationGeneration++
    getMode = () => 'observe'
    stopControls?.()
    stopControls = undefined
    stopIdentityListener?.()
    stopIdentityListener = undefined
    if (timer) clearInterval(timer)
    timer = undefined
    for (const id of principals) for (const job of agentHub.listJobs(id)) agentHub.cancel(job.id)
  }
}
