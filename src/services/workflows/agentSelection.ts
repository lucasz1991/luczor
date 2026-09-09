import { invoke } from '@tauri-apps/api/core'
import { getRepositoryExternalPolicy, type RepositoryExternalPolicy } from '@/services/repositoryGraph'
import { getCodexModelCapabilities, getCodexRuntimeStatus } from '@/services/agents/codexAgent'
import { CLAUDE_CAPABILITIES, getClaudeRuntimeStatus } from '@/services/agents/claudeAgent'
import { selectAgentEffort, type AgentCapabilityCatalog } from '@/services/agents/effort'
import type { AgentEffortSelection, AgentPermission, AgentRole } from '@/services/agents/types'
import type { NativeLocalModelStatus } from '@/services/inference/tauriLocalRuntime'
import type { LuczorMode } from '@/services/inference/types'
import type { ThinkingTier } from '@/services/inference/thinking'
import { verifiedAgentScore, type VerifiedAgentEvidence } from './agentEvidence'

export type WorkflowAgentAvailability = Readonly<{
  externalPolicy: RepositoryExternalPolicy
  local: Pick<NativeLocalModelStatus, 'manifestAvailable' | 'state' | 'activeModelId'> | null
  codex: { available: boolean; catalog: AgentCapabilityCatalog }
  claude: { available: boolean; catalog: AgentCapabilityCatalog; cliVersion?: string }
}>
export type WorkflowAgentSelection = Readonly<{
  adapter: 'local' | 'codex' | 'claude'
  model?: string
  role: AgentRole
  permission: AgentPermission
  reason: string
  task: 'general' | 'planning' | 'review' | 'coding'
  effortSelection?: AgentEffortSelection
  /** CLI presence cannot confirm login or model access. */
  availability: 'local_policy_admission' | 'runtime_present_auth_unknown'
  cost: 'local' | 'sdk_budget_cap' | 'unknown'
  qualityEvidence: 'unavailable' | 'verified_real_tests'
  /** Comparable task fixtures, not proof of general model quality or equal effective tool/effort profiles. */
  qualityEvidenceLabel?: string
  evidence?: {
    revision: string
    scopeHash: string
    environmentHash: string
    samples: number
    passed: number
    failed: number
    modelSource: 'runtime' | 'pinned_request'
    evidenceIds: readonly number[]
  }
  excluded: readonly string[]
  externalPolicy: RepositoryExternalPolicy
  runtimeRevision?: string
}>
type SelectionInput = {
  team: boolean
  instruction: string
  mode: LuczorMode
  projectBound: boolean
  tier: ThinkingTier
  maxTurns?: number
  maxBudgetUsd?: number
  availability: WorkflowAgentAvailability
  evidence?: VerifiedAgentEvidence | null
}
const EMPTY_CATALOG: AgentCapabilityCatalog = { revision: 'unavailable', models: [] }
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,159}$/u

/** File/status metadata only: never prepares a model, probes a provider or starts a CLI. */
export async function readWorkflowAgentAvailability(signal: AbortSignal): Promise<WorkflowAgentAvailability> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    return await Promise.race([
      (async () => {
        const [externalPolicy, local, codex, claude, catalog] = await Promise.all([
          getRepositoryExternalPolicy().catch(() => 'deny' as const),
          invoke<NativeLocalModelStatus>('local_model_status').catch(() => null),
          getCodexRuntimeStatus().catch(() => ({ available: false })),
          getClaudeRuntimeStatus().catch(() => ({ available: false, cliVersion: undefined })),
          getCodexModelCapabilities().catch(() => EMPTY_CATALOG),
        ])
        signal.throwIfAborted()
        return {
          externalPolicy,
          local: local && {
            manifestAvailable: local.manifestAvailable,
            state: local.state,
            activeModelId: local.activeModelId,
          },
          codex: { available: codex.available, catalog },
          claude: { available: claude.available, cliVersion: claude.cliVersion, catalog: CLAUDE_CAPABILITIES },
        }
      })(),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Abgebrochen', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(new Error('workflow_agent_availability_timeout')), 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** Only the reviewed instruction determines task fit; bound input data cannot steer the adapter. */
export function workflowAgentTask(instruction: string): WorkflowAgentSelection['task'] {
  const text = instruction.toLowerCase()
  if (/\b(review|codeprüfung|codepruefung|gegenprüfung|gegenpruefung|prüfe.{0,35}code|check.{0,35}code)\b/u.test(text))
    return 'review'
  if (
    /\b(code|coding|repository|repo|implementieren|implementiere|implement|refactor|refaktorisieren|bugfix|quellcode|unittest|unit-test|typescript|rust|laravel)\b/u.test(
      text
    )
  )
    return 'coding'
  if (/\b(plan|planung|planen|architecture|architektur)\b/u.test(text)) return 'planning'
  return 'general'
}

/** Deterministic capability/cost filtering. No quality score is invented from successful CLI exits. */
export function selectWorkflowAgent(input: SelectionInput): WorkflowAgentSelection {
  const { availability } = input
  const task = workflowAgentTask(input.instruction)
  const role: AgentRole =
    task === 'planning' ? 'planner' : task === 'review' ? 'reviewer' : task === 'coding' ? 'implementer' : 'assistant'
  const permission: AgentPermission = task === 'coding' ? 'workspace-write' : 'read-only'
  const excluded: string[] = []
  const local = (reason: string): WorkflowAgentSelection => ({
    adapter: 'local',
    role,
    permission,
    reason,
    task,
    availability: 'local_policy_admission',
    cost: 'local',
    qualityEvidence: 'unavailable',
    excluded,
    externalPolicy: availability.externalPolicy,
  })
  // Roles, provider prices and exact specialist packets remain owned by the existing team engine.
  if (input.team) return local('local_orchestrator_with_approved_admin_specialists')
  if (availability.externalPolicy === 'deny') return local('external_agents_denied_by_policy')
  if (!input.projectBound) return local('managed_agents_require_bound_workspace')
  if (permission === 'workspace-write' && input.mode === 'observe') return local('write_agents_require_act_mode')
  const localUsable =
    !!availability.local?.manifestAvailable && !['unavailable', 'error', 'cooldown'].includes(availability.local.state)
  if (localUsable && !['coding', 'review'].includes(task) && input.maxBudgetUsd === undefined)
    return local(task === 'planning' ? 'local_planning_no_provider_cost' : 'local_general_task_no_provider_cost')

  const candidates: Array<WorkflowAgentSelection> = []
  for (const adapter of ['codex', 'claude'] as const) {
    const runtime = adapter === 'codex' ? availability.codex : availability.claude
    if (!runtime.available) {
      excluded.push(`${adapter}:runtime_unavailable`)
      continue
    }
    if (adapter === 'codex' && (input.maxTurns !== undefined || input.maxBudgetUsd !== undefined)) {
      excluded.push('codex:requested_budget_controls_unavailable')
      continue
    }
    const catalog = runtime.catalog
    if (
      !catalog.revision ||
      catalog.revision === 'unavailable' ||
      (adapter === 'codex' &&
        (catalog.source !== 'codex-cache' || !catalog.validForSeconds || catalog.validForSeconds <= 0))
    ) {
      excluded.push(`${adapter}:model_capabilities_unavailable`)
      continue
    }
    // Preserve the documented/runtime catalog order; do not pretend it is a price or quality ranking.
    const models = catalog.models
      .filter(item => MODEL.test(item.model) && item.supportedEfforts.length > 0)
      .slice(0, 100)
    if (!models.length) {
      excluded.push(`${adapter}:compatible_model_unavailable`)
      continue
    }
    for (const { model } of models) {
      const effortSelection = selectAgentEffort({ adapter, tier: input.tier, model, role, catalog })
      if (!effortSelection.requestedEffort) {
        excluded.push(`${adapter}:supported_effort_unresolved`)
        continue
      }
      candidates.push({
        adapter,
        model,
        role,
        permission,
        task,
        effortSelection,
        reason: input.maxBudgetUsd !== undefined ? 'managed_sdk_budget_cap' : `managed_${task}_capability`,
        availability: 'runtime_present_auth_unknown',
        cost: input.maxBudgetUsd !== undefined ? 'sdk_budget_cap' : 'unknown',
        qualityEvidence: 'unavailable',
        excluded,
        externalPolicy: availability.externalPolicy,
        runtimeRevision: adapter === 'claude' ? availability.claude.cliVersion : catalog.revision,
      })
    }
  }
  if (
    localUsable &&
    input.maxBudgetUsd === undefined &&
    availability.local?.activeModelId &&
    ['ready', 'busy'].includes(availability.local.state)
  )
    candidates.push({ ...local('verified_local_task_results'), model: availability.local.activeModelId })
  const evidence = input.evidence
  if (evidence) {
    const ranked = candidates
      .map((candidate, index) => {
        const row = evidence.rows
          .filter(item => item.adapter === candidate.adapter && item.model === candidate.model)
          .sort(
            (left, right) =>
              (verifiedAgentScore(right, evidence.minimum_samples) ?? -1) -
              (verifiedAgentScore(left, evidence.minimum_samples) ?? -1)
          )[0]
        return { candidate, index, row, score: row ? verifiedAgentScore(row, evidence.minimum_samples) : null }
      })
      .filter(item => item.score !== null)
      .sort((left, right) => right.score! - left.score! || left.index - right.index)
    const best = ranked[0]
    if (best?.row)
      return {
        ...best.candidate,
        reason: 'verified_comparable_task_test_success',
        qualityEvidence: 'verified_real_tests',
        qualityEvidenceLabel: 'Verifizierter Testfallerfolg vergleichbarer Aufgabe',
        evidence: {
          revision: evidence.revision,
          scopeHash: evidence.scope_hash,
          environmentHash: evidence.device_environment_hash,
          samples: best.row.samples,
          passed: best.row.passed,
          failed: best.row.failed,
          modelSource: best.row.model_source,
          evidenceIds: best.row.evidence_ids,
        },
      }
  }
  // Codex's project-restricted tool profile wins ties; Claude supplies SDK turns/cost caps when required.
  return candidates.find(candidate => candidate.adapter !== 'local') ?? local('no_eligible_managed_agent_local_policy')
}

/** A previewed route cannot silently drift while the existing exact-payload approval is open. */
export function assertWorkflowAgentSelectionCurrent(
  selection: WorkflowAgentSelection,
  current: WorkflowAgentAvailability
): void {
  if (selection.adapter === 'local') return
  const runtime = selection.adapter === 'codex' ? current.codex : current.claude
  if (
    current.externalPolicy === 'deny' ||
    current.externalPolicy !== selection.externalPolicy ||
    !runtime.available ||
    runtime.catalog.revision !== selection.effortSelection?.capabilityRevision ||
    !runtime.catalog.models.some(
      item =>
        item.model === selection.model && item.supportedEfforts.includes(selection.effortSelection!.requestedEffort!)
    ) ||
    (selection.adapter === 'codex' && (!runtime.catalog.validForSeconds || runtime.catalog.validForSeconds <= 0)) ||
    (selection.adapter === 'claude' && current.claude.cliVersion !== selection.runtimeRevision)
  )
    throw new Error('workflow_agent_selection_changed')
}
