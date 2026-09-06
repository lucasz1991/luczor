import { shallowRef, watch } from 'vue'
import { state } from '@/state/store'
import { hud } from '@/state/hud'
import { getProjectWorkspace, resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import { getRepositoryExternalPolicy } from '@/services/repositoryGraph'
import { buildProjectStartContext } from '@/services/prompt/projectStartContext'
import type { LuczorMode } from '@/services/inference/types'
import { AgentOrchestrator } from './orchestrator'
import { createCodexAgentAdapter, listCodexSessions } from './codexAgent'
import { createModelAgentAdapter, type ModelAgentApprovalRequest } from './modelAgent'
import type { AgentJobInput, AgentPermission, AgentProjectSnapshot } from './types'

export const agentHubRevision = shallowRef(0)
export const agentExternalApprovals = shallowRef<readonly ModelAgentApprovalRequest[]>([])
const approvalResolvers = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
>()
const principals = new Set<string>()
let getMode: () => LuczorMode = () => 'observe'
let timer: ReturnType<typeof setInterval> | undefined
let checking = false
let configurationGeneration = 0
let stopControls: (() => void) | undefined
let stopIdentityListener: (() => void) | undefined
const ROLE_INSTRUCTIONS = new Map<NonNullable<AgentJobInput['role']>, string>([
  ['planner', 'Erstelle einen prüfbaren Plan mit Grenzen, Risiken und Akzeptanzkriterien.'],
  ['implementer', 'Setze den Auftrag konkret um und nenne die tatsächlich ausgeführten Prüfungen.'],
  ['reviewer', 'Prüfe das Ergebnis unabhängig gegen Auftrag, Grenzen und Akzeptanzkriterien.'],
  ['join', 'Konsolidiere die Vorgängerergebnisse widerspruchsfrei mit Nachweisen und Restgrenzen.'],
  ['assistant', 'Bearbeite den Auftrag vollständig und trenne Ergebnis, Nachweise und offene Grenzen.'],
])

function validateControls(permission: AgentPermission) {
  if (hud.killSwitch) throw new Error('Not-Aus ist aktiv.')
  if (permission === 'workspace-write' && getMode() === 'observe')
    throw new Error('Schreibzugriff benötigt den Modus Handeln.')
}

export async function validateAgentScope(project: AgentProjectSnapshot, permission: AgentPermission) {
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
    resolveAgentExternalApproval(request.jobId, false)
    const remaining = Date.parse(request.expiresAt) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => resolveAgentExternalApproval(request.jobId, false), remaining)
    approvalResolvers.set(request.jobId, { resolve, timer })
    agentExternalApprovals.value = [...agentExternalApprovals.value, request]
  })
}

export function resolveAgentExternalApproval(jobId: string, approved: boolean) {
  const pending = approvalResolvers.get(jobId)
  if (pending) {
    clearTimeout(pending.timer)
    pending.resolve(approved)
  }
  approvalResolvers.delete(jobId)
  agentExternalApprovals.value = agentExternalApprovals.value.filter(item => item.jobId !== jobId)
}

export const agentHub = new AgentOrchestrator({
  adapters: [
    createCodexAgentAdapter(),
    createModelAgentAdapter({ id: 'local' }),
    createModelAgentAdapter({ id: 'policy', requestExternalApproval }),
  ],
  validateScope: validateAgentScope,
  onMetadata(metadata) {
    principals.add(metadata.principalId)
    if (['completed', 'failed', 'cancelled'].includes(metadata.status)) resolveAgentExternalApproval(metadata.id, false)
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
  externalThreadId?: string
  teamRunId?: string
  teamNodeId?: string
  expectedProject?: AgentProjectSnapshot
  /** exact-reviewed preserves a reviewed workflow or plan, including structured predecessor results. */
  promptAssembly?: 'project' | 'exact-reviewed'
}) {
  if (!input.prompt.trim() || input.prompt.length > 24_000)
    throw new Error('Bitte einen Arbeitsauftrag mit 1 bis 24000 Zeichen eingeben.')
  const project = state.projects.find(item => item.id === input.projectId)
  if (!project) throw new Error('Projekt nicht gefunden.')
  const snapshot = await agentProjectSnapshot(project.id)
  if (
    input.expectedProject &&
    (snapshot.principalId !== input.expectedProject.principalId ||
      snapshot.projectId !== input.expectedProject.projectId ||
      snapshot.rootPath !== input.expectedProject.rootPath ||
      snapshot.workspaceUpdatedAt !== input.expectedProject.workspaceUpdatedAt)
  ) {
    throw new Error('Das aktive Projekt entspricht nicht mehr dem freigegebenen Teamlauf.')
  }
  await validateAgentScope(snapshot, input.permission)
  if (input.adapterId === 'codex') {
    if (!snapshot.rootPath) throw new Error('Bitte zuerst einen Projektordner zuordnen.')
    if ((await getRepositoryExternalPolicy()) === 'deny')
      throw new Error('Die Repository-Richtlinie verbietet externe Coding-Agenten.')
  }
  let assembledPrompt = input.prompt
  const role = input.role ?? 'assistant'
  if (input.promptAssembly !== 'exact-reviewed') {
    const workspace = await getProjectWorkspace(project.id, snapshot.principalId)
    const context = await buildProjectStartContext({ project, workspace, includeMemory: input.includeMemory === true })
    assembledPrompt = `${context.providerText}\n\nRollenauftrag (${role}):\n${ROLE_INSTRUCTIONS.get(role)}\n\nArbeitsauftrag:\n${input.prompt}`
  }
  let externalThreadId: string | undefined
  if (input.resume && input.adapterId === 'codex') {
    const sessions = await listCodexSessions(snapshot)
    externalThreadId = input.externalThreadId
      ? sessions.find(session => session.threadId === input.externalThreadId)?.threadId
      : sessions[0]?.threadId
    if (!externalThreadId) throw new Error('Für diesen Projektordner besteht keine passende native Codex-Sitzung.')
  }
  await validateAgentScope(snapshot, input.permission)
  const job = agentHub.enqueue({
    project: snapshot,
    adapterId: input.adapterId,
    prompt: assembledPrompt,
    role,
    permission: input.permission,
    model: input.model?.trim() || undefined,
    externalThreadId,
    teamRunId: input.teamRunId,
    teamNodeId: input.teamNodeId,
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
        if (!['awaiting_approval', 'queued', 'running', 'awaiting_external_approval'].includes(job.status)) continue
        try {
          await validateAgentScope(job.project, job.permission)
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
