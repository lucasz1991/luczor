<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { agentExternalApprovals, agentHub, agentHubRevision, resolveAgentExternalApproval } from '@/services/agents/hub'
import { getCodexRuntimeStatus } from '@/services/agents/codexAgent'
import { listModelAgentOptions } from '@/services/agents/modelAgent'
import { planningHub } from '@/services/planning/hub'
import {
  MAX_PLANNING_STEPS,
  type PlanningAdapterId,
  type PlanningAnalysis,
  type PlanningHub,
  type PlanningPlan,
  type PlanningSessionStatus,
} from '@/services/planning/types'
import {
  MAX_PLANNING_CLARIFICATIONS_CHARACTERS,
  MAX_PLANNING_IMPORT_CHARACTERS,
  MAX_PLANNING_OBJECTIVE_CHARACTERS,
} from '@/services/planning/validation'
import type { AgentPermission } from '@/services/agents/types'
import type { LuczorMode } from '@/services/inference/types'

type AdapterChoice = Readonly<{ id: PlanningAdapterId; label: string; available: boolean; detail: string }>
type EditableStep = {
  id: string
  title: string
  description: string
  dependencies: string
  acceptanceCriteria: string
  verification: string
}
type EditablePlan = {
  objective: string
  steps: EditableStep[]
  completionCriteria: string
  outOfScope: string
}

const props = withDefaults(
  defineProps<{
    open: boolean
    projectId: string
    mode: LuczorMode
    killSwitch: boolean
    busy?: boolean
    initialObjective?: string
    hubProp?: PlanningHub
  }>(),
  { busy: false, initialObjective: '', hubProp: undefined }
)
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const hubRevision = ref(0)
const objective = ref('')
const clarifications = ref('')
const plannerAdapter = ref<PlanningAdapterId>('local')
const plannerModel = ref('')
const executorAdapter = ref<PlanningAdapterId>('codex')
const executorModel = ref('')
const executorPermission = ref<AgentPermission>('read-only')
const editablePlan = ref<EditablePlan | null>(null)
const loadedPlanKey = ref('')
const importText = ref('')
const exportText = ref('')
const localError = ref('')
const notice = ref('')
const actionPending = ref(false)
const codexAvailable = ref(false)
const modelChoices = ref<AdapterChoice[]>([])
let stopHub: (() => void) | undefined
let availabilityGeneration = 0
let uiGeneration = 0
const identityChanging = ref(false)

const hub = computed(() => props.hubProp ?? planningHub)
const session = computed(() => {
  void hubRevision.value
  if (identityChanging.value) return null
  return hub.value.get(props.projectId)
})
const status = computed<PlanningSessionStatus>(() => session.value?.status ?? 'idle')
const operationActive = computed(() => ['analyzing', 'planning', 'executing'].includes(status.value))
const interactionBlocked = computed(
  () => props.killSwitch || props.busy || operationActive.value || actionPending.value
)
const adapterChoices = computed<readonly AdapterChoice[]>(() => {
  if (props.hubProp) {
    return [
      { id: 'codex', label: 'Codex · Coding-Agent', available: true, detail: 'synthetischer Laboradapter' },
      { id: 'local', label: 'Eigenes Modell · lokal', available: true, detail: 'synthetischer Laboradapter' },
      { id: 'policy', label: 'Modellrichtlinie · lokal zuerst', available: true, detail: 'synthetischer Laboradapter' },
    ]
  }
  return [
    {
      id: 'codex',
      label: 'Codex · Coding-Agent',
      available: codexAvailable.value,
      detail: codexAvailable.value ? 'CLI bereit' : 'CLI nicht erkannt',
    },
    ...modelChoices.value,
  ]
})
const plannerReady = computed(() =>
  adapterChoices.value.some(item => item.id === plannerAdapter.value && item.available)
)
const executorReady = computed(() =>
  adapterChoices.value.some(item => item.id === executorAdapter.value && item.available)
)
const openQuestions = computed(() => session.value?.analysis?.openQuestions ?? [])
const hasOpenQuestions = computed(() => openQuestions.value.length > 0)

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function dependencies(value: string): string[] {
  return value
    .split(/[,\r\n]+/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function editableFrom(plan: PlanningPlan): EditablePlan {
  return {
    objective: plan.objective,
    steps: plan.steps.map(step => ({
      id: step.id,
      title: step.title,
      description: step.description,
      dependencies: step.dependencies.join(', '),
      acceptanceCriteria: step.acceptanceCriteria.join('\n'),
      verification: step.verification.join('\n'),
    })),
    completionCriteria: plan.completionCriteria.join('\n'),
    outOfScope: plan.outOfScope.join('\n'),
  }
}

function planFromEditable(analysis: PlanningAnalysis): PlanningPlan {
  const draft = editablePlan.value
  if (!draft) throw new Error('Es liegt kein bearbeitbarer Plan vor.')
  return {
    objective: draft.objective.trim(),
    analysis,
    steps: draft.steps.map(step => ({
      id: step.id.trim(),
      title: step.title.trim(),
      description: step.description.trim(),
      dependencies: dependencies(step.dependencies),
      acceptanceCriteria: lines(step.acceptanceCriteria),
      verification: lines(step.verification),
    })),
    completionCriteria: lines(draft.completionCriteria),
    outOfScope: lines(draft.outOfScope),
  }
}

function canonicalPlan(plan: PlanningPlan): string {
  return JSON.stringify(plan)
}

const draftDirty = computed(() => {
  if (!session.value?.plan || !session.value.analysis || !editablePlan.value) return false
  try {
    return canonicalPlan(planFromEditable(session.value.analysis)) !== canonicalPlan(session.value.plan)
  } catch {
    return true
  }
})

const briefDirty = computed(
  () => !!session.value?.plan && (objective.value.trim() !== session.value.objective || !!clarifications.value.trim())
)
const canAnalyze = computed(() => !!objective.value.trim() && plannerReady.value && !interactionBlocked.value)
const canReplan = computed(
  () => !!objective.value.trim() && !!clarifications.value.trim() && plannerReady.value && !interactionBlocked.value
)
const canExecute = computed(
  () =>
    !!session.value?.plan &&
    status.value === 'review' &&
    !hasOpenQuestions.value &&
    !briefDirty.value &&
    !draftDirty.value &&
    executorReady.value &&
    !interactionBlocked.value &&
    (executorPermission.value === 'read-only' || props.mode !== 'observe')
)

const relevantJobIds = computed(() => {
  void agentHubRevision.value
  const current = session.value
  if (!current) return new Set<string>()
  const runIds = new Set([current.id, current.execution?.id].filter((value): value is string => !!value))
  return new Set(
    agentHub
      .listJobs(current.project.principalId, current.project.projectId)
      .filter(job => !!job.teamRunId && runIds.has(job.teamRunId))
      .map(job => job.id)
  )
})
const externalApprovals = computed(() =>
  agentExternalApprovals.value.filter(approval => relevantJobIds.value.has(approval.jobId))
)

function statusLabel(value: PlanningSessionStatus): string {
  switch (value) {
    case 'idle':
      return 'Bereit'
    case 'analyzing':
      return 'Analyse läuft'
    case 'planning':
      return 'Plan wird erstellt'
    case 'review':
      return 'Plan zur Prüfung'
    case 'executing':
      return 'Plan wird ausgeführt'
    case 'completed':
      return 'Ausführung beendet'
    case 'failed':
      return 'Fehlgeschlagen'
    case 'cancelled':
      return 'Abgebrochen'
    case 'interrupted':
      return 'Unterbrochen'
  }
}

function phaseState(phase: 'analysis' | 'planning' | 'review'): 'pending' | 'active' | 'done' {
  const current = status.value
  if (phase === 'analysis') {
    if (current === 'analyzing') return 'active'
    return session.value?.analysis ? 'done' : 'pending'
  }
  if (phase === 'planning') {
    if (current === 'planning') return 'active'
    return session.value?.plan ? 'done' : 'pending'
  }
  if (current === 'review') return 'active'
  return session.value?.plan && ['executing', 'completed', 'failed', 'cancelled', 'interrupted'].includes(current)
    ? 'done'
    : 'pending'
}

function seedObjective(): void {
  const current = session.value
  const active = current && ['analyzing', 'planning', 'review', 'executing'].includes(current.status)
  if (active) {
    objective.value = current.objective
    return
  }
  objective.value = props.initialObjective.trim() || current?.objective || ''
}

function resetTransient(): void {
  localError.value = ''
  notice.value = ''
  clarifications.value = ''
  importText.value = ''
  exportText.value = ''
  actionPending.value = false
}

function clearPrivateUi(): void {
  resetTransient()
  objective.value = ''
  editablePlan.value = null
  loadedPlanKey.value = ''
}

function invalidateIdentityUi(): void {
  identityChanging.value = true
  uiGeneration++
  availabilityGeneration++
  clearPrivateUi()
}

function resumeIdentityUi(): void {
  identityChanging.value = false
  uiGeneration++
  if (props.open) void refreshAvailability()
}

async function refreshAvailability(): Promise<void> {
  const generation = ++availabilityGeneration
  if (props.hubProp) return
  const runtime = await getCodexRuntimeStatus().catch(() => ({ available: false }))
  if (generation !== availabilityGeneration) return
  codexAvailable.value = runtime.available
  const localChoices = listModelAgentOptions().map(option => ({
    id: option.id,
    label: option.label,
    available: option.available,
    detail: option.available ? (option.model ?? 'bereit') : String(option.reason ?? 'nicht bereit'),
  }))
  modelChoices.value = localChoices
  const available = [
    { id: 'codex' as const, available: runtime.available },
    ...localChoices.map(choice => ({ id: choice.id, available: choice.available })),
  ]
  const fallback = available.find(choice => choice.available)?.id
  if (fallback && !available.some(choice => choice.id === plannerAdapter.value && choice.available)) {
    plannerAdapter.value = fallback
  }
  if (fallback && !available.some(choice => choice.id === executorAdapter.value && choice.available)) {
    executorAdapter.value = fallback
  }
}

function bindHub(): void {
  stopHub?.()
  stopHub = hub.value.subscribe(() => {
    hubRevision.value++
  })
  hubRevision.value++
}

function showDialog(): void {
  const target = dialog.value
  if (!target || target.open) return
  if (typeof target.showModal === 'function') target.showModal()
  else target.setAttribute('open', '')
}

function hideDialog(): void {
  const target = dialog.value
  if (!target || !target.open) return
  if (typeof target.close === 'function') target.close()
  else target.removeAttribute('open')
}

async function openDialogForCurrentState(generation: number, projectId: string): Promise<void> {
  await nextTick()
  if (generation !== uiGeneration || !props.open || projectId !== props.projectId || identityChanging.value) return
  showDialog()
  seedObjective()
  void refreshAvailability()
}

watch(
  () => props.hubProp,
  () => {
    const generation = ++uiGeneration
    clearPrivateUi()
    bindHub()
    if (props.open) void openDialogForCurrentState(generation, props.projectId)
  }
)
watch(
  () => [props.open, props.projectId, props.initialObjective] as const,
  async ([open, projectId], previous) => {
    const generation = ++uiGeneration
    const projectChanged = !!previous && previous[1] !== props.projectId
    if (projectChanged) clearPrivateUi()
    if (!open) {
      hideDialog()
      return
    }
    await openDialogForCurrentState(generation, projectId)
  },
  { immediate: true }
)
watch(plannerAdapter, value => {
  if (value !== 'codex') plannerModel.value = ''
})
watch(executorAdapter, value => {
  if (value !== 'codex') {
    executorModel.value = ''
    executorPermission.value = 'read-only'
  }
})
watch(
  () => {
    const current = session.value
    return current?.plan ? `${current.id}:${current.revision}` : ''
  },
  (key, previousKey) => {
    if (!key) {
      if (previousKey && !session.value) clearPrivateUi()
      return
    }
    if (!session.value?.plan || key === loadedPlanKey.value) return
    editablePlan.value = editableFrom(session.value.plan)
    objective.value = session.value.objective
    loadedPlanKey.value = key
    exportText.value = ''
  },
  { immediate: true }
)
watch(
  () => props.killSwitch,
  active => {
    if (active) actionPending.value = false
  }
)

onMounted(() => {
  bindHub()
  window.addEventListener('luczor:api-identity-changing', invalidateIdentityUi)
  window.addEventListener('luczor:api-identity-changed', resumeIdentityUi)
})
onBeforeUnmount(() => {
  uiGeneration++
  availabilityGeneration++
  stopHub?.()
  window.removeEventListener('luczor:api-identity-changing', invalidateIdentityUi)
  window.removeEventListener('luczor:api-identity-changed', resumeIdentityUi)
  hideDialog()
})

async function analyze(withClarifications = false): Promise<void> {
  if (withClarifications ? !canReplan.value : !canAnalyze.value) return
  actionPending.value = true
  localError.value = ''
  notice.value = ''
  const projectId = props.projectId
  const generation = uiGeneration
  const activeHub = hub.value
  try {
    await activeHub.analyze(projectId, {
      objective: objective.value,
      adapterId: plannerAdapter.value,
      model: plannerModel.value.trim() || undefined,
      clarifications: clarifications.value.trim() || undefined,
    })
    if (
      generation !== uiGeneration ||
      projectId !== props.projectId ||
      activeHub !== hub.value ||
      identityChanging.value
    )
      return
    clarifications.value = ''
    notice.value = hasOpenQuestions.value
      ? 'Offene Fragen blockieren die Ausführung. Bitte Präzisierungen ergänzen und neu planen.'
      : 'Analyse und Plan sind bereit. Bitte jeden Schritt prüfen.'
  } catch (cause) {
    if (
      generation === uiGeneration &&
      projectId === props.projectId &&
      activeHub === hub.value &&
      !identityChanging.value
    )
      localError.value = cause instanceof Error ? cause.message : 'Analyse und Planung sind fehlgeschlagen.'
  } finally {
    if (generation === uiGeneration && projectId === props.projectId && activeHub === hub.value)
      actionPending.value = false
  }
}

function saveRevision(): void {
  if (!session.value?.analysis || !editablePlan.value || interactionBlocked.value) return
  localError.value = ''
  try {
    hub.value.revise(props.projectId, planFromEditable(session.value.analysis))
    notice.value = 'Planänderungen als neue geprüfte Revision übernommen.'
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : 'Planänderungen sind ungültig.'
  }
}

function addStep(): void {
  if (!editablePlan.value || editablePlan.value.steps.length >= MAX_PLANNING_STEPS || interactionBlocked.value) return
  const existing = new Set(editablePlan.value.steps.map(step => step.id))
  let index = editablePlan.value.steps.length + 1
  while (existing.has(`step-${index}`)) index++
  editablePlan.value.steps.push({
    id: `step-${index}`,
    title: '',
    description: '',
    dependencies: '',
    acceptanceCriteria: '',
    verification: '',
  })
}

function removeStep(index: number): void {
  const draft = editablePlan.value
  if (!draft || interactionBlocked.value) return
  const removed = draft.steps.find((_step, stepIndex) => stepIndex === index)?.id
  draft.steps.splice(index, 1)
  if (removed) {
    for (const step of draft.steps) {
      step.dependencies = dependencies(step.dependencies)
        .filter(id => id !== removed)
        .join(', ')
    }
  }
}

async function executePlan(): Promise<void> {
  const current = session.value
  if (!current || !canExecute.value) return
  actionPending.value = true
  localError.value = ''
  notice.value = ''
  const projectId = props.projectId
  const generation = uiGeneration
  const activeHub = hub.value
  try {
    await activeHub.execute(projectId, {
      expectedSessionId: current.id,
      expectedRevision: current.revision,
      adapterId: executorAdapter.value,
      model: executorModel.value.trim() || undefined,
      permission: executorPermission.value,
    })
    if (
      generation === uiGeneration &&
      projectId === props.projectId &&
      activeHub === hub.value &&
      !identityChanging.value
    )
      notice.value = 'Der Ausführungslauf ist beendet. Bitte Schrittausgaben, Nachweise und Restgrenzen prüfen.'
  } catch (cause) {
    if (
      generation === uiGeneration &&
      projectId === props.projectId &&
      activeHub === hub.value &&
      !identityChanging.value
    )
      localError.value = cause instanceof Error ? cause.message : 'Die Planausführung ist fehlgeschlagen.'
  } finally {
    if (generation === uiGeneration && projectId === props.projectId && activeHub === hub.value)
      actionPending.value = false
  }
}

function cancel(): void {
  hub.value.cancel(props.projectId)
  actionPending.value = false
}

function showExport(): void {
  localError.value = ''
  try {
    exportText.value = hub.value.export(props.projectId)
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : 'Der Plan konnte nicht exportiert werden.'
  }
}

function downloadExport(): void {
  showExport()
  if (!exportText.value) return
  const url = URL.createObjectURL(new Blob([exportText.value], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `luczor-plan-${props.projectId}.json`
  link.click()
  URL.revokeObjectURL(url)
}

async function restore(): Promise<void> {
  if (!importText.value.trim() || interactionBlocked.value) return
  actionPending.value = true
  localError.value = ''
  const projectId = props.projectId
  const generation = uiGeneration
  const activeHub = hub.value
  try {
    await activeHub.restore(projectId, importText.value)
    if (
      generation !== uiGeneration ||
      projectId !== props.projectId ||
      activeHub !== hub.value ||
      identityChanging.value
    )
      return
    importText.value = ''
    notice.value = 'Plan importiert. Er bleibt zur Prüfung angehalten und startet nicht automatisch.'
  } catch (cause) {
    if (
      generation === uiGeneration &&
      projectId === props.projectId &&
      activeHub === hub.value &&
      !identityChanging.value
    )
      localError.value = cause instanceof Error ? cause.message : 'Der Planimport ist ungültig.'
  } finally {
    if (generation === uiGeneration && projectId === props.projectId && activeHub === hub.value)
      actionPending.value = false
  }
}

async function readImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  localError.value = ''
  const generation = uiGeneration
  const projectId = props.projectId
  try {
    const text = await file.text()
    if (generation !== uiGeneration || projectId !== props.projectId || identityChanging.value) return
    if (text.length > MAX_PLANNING_IMPORT_CHARACTERS)
      throw new Error(`Bitte eine Plan-Datei mit höchstens ${MAX_PLANNING_IMPORT_CHARACTERS} Zeichen auswählen.`)
    importText.value = text
  } catch (cause) {
    if (generation === uiGeneration && projectId === props.projectId && !identityChanging.value)
      localError.value = cause instanceof Error ? cause.message : 'Die Plan-Datei konnte nicht gelesen werden.'
  } finally {
    input.value = ''
  }
}

function approvalJson(approval: (typeof agentExternalApprovals.value)[number]): string {
  return JSON.stringify(
    {
      job_id: approval.jobId,
      project_id: approval.projectId,
      task_type: approval.taskType,
      destination: approval.destination,
      packet_hash: approval.packetHash,
      expires_at: approval.expiresAt,
      tools_allowed: approval.toolsAllowed,
      messages: approval.messages,
    },
    null,
    2
  )
}
</script>

<template>
  <dialog
    ref="dialog"
    class="planning-workspace"
    aria-labelledby="planning-workspace-title"
    @close="emit('update:open', false)"
    @cancel="emit('update:open', false)"
    @keydown.stop
  >
    <header class="planning-workspace__header">
      <div>
        <p class="planning-workspace__eyebrow">Analyse → Plan → gezielte Ausführung</p>
        <h2 id="planning-workspace-title">Planungsmodus</h2>
      </div>
      <div class="planning-workspace__header-actions">
        <span class="planning-workspace__status" :data-status="status">{{ statusLabel(status) }}</span>
        <button type="button" aria-label="Planungsmodus schließen" @click="emit('update:open', false)">
          Schließen
        </button>
      </div>
    </header>

    <div class="planning-workspace__body">
      <p v-if="killSwitch" class="planning-workspace__alert" role="alert">
        Not-Aus ist aktiv. Prüfung und Export bleiben sichtbar; neue Analyse und Ausführung sind gesperrt.
      </p>
      <p v-else-if="busy" class="planning-workspace__notice" role="status">
        Ein Chat-Turn läuft. Du kannst den Plan prüfen; neue Planung und Ausführung warten bis zu dessen Abschluss.
      </p>
      <p v-if="localError || session?.error" class="planning-workspace__alert" role="alert">
        {{ localError || session?.error }}
      </p>
      <p v-if="notice" class="planning-workspace__notice" role="status">{{ notice }}</p>

      <ol class="planning-workspace__phases" aria-label="Planungsphasen">
        <li :data-state="phaseState('analysis')"><span>01</span><b>Analysieren</b></li>
        <li :data-state="phaseState('planning')"><span>02</span><b>Planen</b></li>
        <li :data-state="phaseState('review')"><span>03</span><b>Prüfen & ausführen</b></li>
      </ol>

      <section class="planning-workspace__section planning-workspace__brief">
        <div class="planning-workspace__section-heading">
          <div>
            <span>01</span>
            <h3>Ziel und Präzisierungen</h3>
          </div>
          <button v-if="operationActive" type="button" class="planning-workspace__danger" @click="cancel">
            Lauf abbrechen
          </button>
        </div>
        <label>
          Planungsziel
          <textarea
            v-model="objective"
            rows="4"
            :maxlength="MAX_PLANNING_OBJECTIVE_CHARACTERS"
            :disabled="operationActive"
            placeholder="Welches Ergebnis soll vollständig analysiert und geplant werden?"
          />
        </label>
        <label>
          Präzisierungen oder Antworten auf offene Fragen
          <textarea
            v-model="clarifications"
            rows="3"
            :maxlength="MAX_PLANNING_CLARIFICATIONS_CHARACTERS"
            :disabled="operationActive"
            placeholder="Bekannte Randbedingungen, Entscheidungen, Ausschlüsse und Antworten"
          />
        </label>
        <div class="planning-workspace__fields">
          <label>
            Planer
            <select v-model="plannerAdapter" :disabled="operationActive">
              <option
                v-for="choice in adapterChoices"
                :key="`planner-${choice.id}`"
                :value="choice.id"
                :disabled="!choice.available"
              >
                {{ choice.label }}{{ choice.available ? '' : ` · ${choice.detail}` }}
              </option>
            </select>
          </label>
          <label>
            Planermodell
            <input
              v-model="plannerModel"
              maxlength="128"
              :disabled="plannerAdapter !== 'codex' || operationActive"
              :placeholder="
                plannerAdapter === 'codex'
                  ? 'Optional · Standard aus Codex-Konfiguration'
                  : 'Durch Modellrichtlinie festgelegt'
              "
            />
          </label>
        </div>
        <div class="planning-workspace__actions">
          <button type="button" class="planning-workspace__primary" :disabled="!canAnalyze" @click="analyze(false)">
            Analysieren und planen
          </button>
          <span>Beide Stufen laufen ausschließlich mit Leserechten.</span>
        </div>
        <p v-if="briefDirty" class="planning-workspace__alert">
          Ziel oder Präzisierungen wurden geändert. Bitte erneut analysieren und planen, bevor du ausführst.
        </p>
      </section>

      <section v-if="session?.analysis" class="planning-workspace__section">
        <div class="planning-workspace__section-heading">
          <div>
            <span>02</span>
            <h3>Analyse</h3>
          </div>
          <small>Revision {{ session.revision }}</small>
        </div>
        <p class="planning-workspace__summary">{{ session.analysis.summary }}</p>
        <div class="planning-workspace__analysis-grid">
          <article
            v-for="entry in [
              { title: 'Befunde', values: session.analysis.findings },
              { title: 'Belege', values: session.analysis.evidence },
              { title: 'Risiken', values: session.analysis.risks },
              { title: 'Annahmen', values: session.analysis.assumptions },
            ]"
            :key="entry.title"
          >
            <h4>{{ entry.title }}</h4>
            <ul v-if="entry.values.length">
              <li v-for="value in entry.values" :key="value">{{ value }}</li>
            </ul>
            <p v-else>Keine Einträge.</p>
          </article>
        </div>
        <article v-if="hasOpenQuestions" class="planning-workspace__questions" role="alert">
          <div>
            <strong>Offene Fragen blockieren die Ausführung</strong><span>{{ openQuestions.length }}</span>
          </div>
          <ul>
            <li v-for="question in openQuestions" :key="question">{{ question }}</li>
          </ul>
          <button type="button" class="planning-workspace__primary" :disabled="!canReplan" @click="analyze(true)">
            Mit Präzisierungen neu planen
          </button>
        </article>
      </section>

      <section v-if="editablePlan && session?.plan" class="planning-workspace__section">
        <div class="planning-workspace__section-heading">
          <div>
            <span>03</span>
            <h3>Plan prüfen und bearbeiten</h3>
          </div>
          <small>{{ editablePlan.steps.length }}/{{ MAX_PLANNING_STEPS }} Schritte</small>
        </div>
        <label>Geprüftes Ziel<input :value="editablePlan.objective" disabled /></label>
        <div class="planning-workspace__steps">
          <article
            v-for="(step, index) in editablePlan.steps"
            :key="`${step.id}-${index}`"
            class="planning-workspace__step"
          >
            <header>
              <span>{{ String(index + 1).padStart(2, '0') }}</span
              ><input
                v-model="step.title"
                :disabled="operationActive"
                maxlength="240"
                aria-label="Schritttitel"
              /><button
                type="button"
                :disabled="operationActive || editablePlan.steps.length <= 1"
                @click="removeStep(index)"
              >
                Entfernen
              </button>
            </header>
            <div class="planning-workspace__fields">
              <label>Schritt-ID<input v-model="step.id" :disabled="operationActive" maxlength="80" /></label>
              <label
                >Abhängigkeiten<input
                  v-model="step.dependencies"
                  :disabled="operationActive"
                  placeholder="step-1, step-2"
              /></label>
            </div>
            <label
              >Beschreibung<textarea v-model="step.description" :disabled="operationActive" rows="3" maxlength="4000" />
            </label>
            <div class="planning-workspace__fields">
              <label
                >Abnahmekriterien · eines pro Zeile<textarea
                  v-model="step.acceptanceCriteria"
                  :disabled="operationActive"
                  rows="4"
                />
              </label>
              <label
                >Prüfungen · eine pro Zeile<textarea v-model="step.verification" :disabled="operationActive" rows="4" />
              </label>
            </div>
          </article>
        </div>
        <button
          type="button"
          :disabled="interactionBlocked || editablePlan.steps.length >= MAX_PLANNING_STEPS"
          @click="addStep"
        >
          Schritt hinzufügen
        </button>
        <div class="planning-workspace__fields planning-workspace__closing-criteria">
          <label
            >Gesamtabnahme · ein Kriterium pro Zeile<textarea
              v-model="editablePlan.completionCriteria"
              :disabled="operationActive"
              rows="4"
            />
          </label>
          <label
            >Außerhalb des Umfangs · ein Punkt pro Zeile<textarea
              v-model="editablePlan.outOfScope"
              :disabled="operationActive"
              rows="4"
            />
          </label>
        </div>
        <div class="planning-workspace__actions">
          <button type="button" :disabled="!draftDirty || interactionBlocked" @click="saveRevision">
            Planänderungen übernehmen
          </button>
          <span v-if="draftDirty">Ungespeicherte Änderungen blockieren die Ausführung.</span>
          <span v-else>Diese Revision ist gespeichert.</span>
        </div>
      </section>

      <section v-if="session?.plan" class="planning-workspace__section planning-workspace__execution">
        <div class="planning-workspace__section-heading">
          <div>
            <span>04</span>
            <h3>Gezielte Ausführung</h3>
          </div>
          <small>keine automatische Ausführung</small>
        </div>
        <div class="planning-workspace__fields">
          <label>
            Executor
            <select v-model="executorAdapter" :disabled="operationActive">
              <option
                v-for="choice in adapterChoices"
                :key="`executor-${choice.id}`"
                :value="choice.id"
                :disabled="!choice.available"
              >
                {{ choice.label }}{{ choice.available ? '' : ` · ${choice.detail}` }}
              </option>
            </select>
          </label>
          <label>
            Berechtigung
            <select v-model="executorPermission" :disabled="executorAdapter !== 'codex' || operationActive">
              <option value="read-only">Nur lesen / Patchvorschlag</option>
              <option value="workspace-write" :disabled="mode === 'observe'">Im Projekt schreiben</option>
            </select>
          </label>
          <label>
            Executormodell
            <input
              v-model="executorModel"
              maxlength="128"
              :disabled="executorAdapter !== 'codex' || operationActive"
              :placeholder="
                executorAdapter === 'codex'
                  ? 'Optional · Standard aus Codex-Konfiguration'
                  : 'Durch Modellrichtlinie festgelegt'
              "
            />
          </label>
        </div>
        <p v-if="hasOpenQuestions" class="planning-workspace__alert">
          Beantworte zuerst alle offenen Fragen durch eine neue Planung.
        </p>
        <button type="button" class="planning-workspace__execute" :disabled="!canExecute" @click="executePlan">
          Geprüften Plan ausführen · Revision {{ session.revision }}
        </button>
      </section>

      <section v-if="externalApprovals.length" class="planning-workspace__section planning-workspace__egress">
        <div class="planning-workspace__section-heading">
          <div>
            <span>!</span>
            <h3>Externe Paketfreigabe</h3>
          </div>
        </div>
        <article v-for="approval in externalApprovals" :key="approval.jobId">
          <p>
            <strong>{{ approval.destination }}</strong> · {{ approval.characterCount.toLocaleString('de-DE') }} Zeichen
            · gültig bis {{ new Date(approval.expiresAt).toLocaleString('de-DE') }}
          </p>
          <p class="planning-workspace__hash">SHA-256 {{ approval.packetHash }}</p>
          <details open>
            <summary>Vollständiges Client-Paket prüfen</summary>
            <pre>{{ approvalJson(approval) }}</pre>
          </details>
          <div class="planning-workspace__actions">
            <button
              type="button"
              class="planning-workspace__primary"
              :disabled="killSwitch"
              @click="resolveAgentExternalApproval(approval.jobId, true)"
            >
              Dieses Paket freigeben
            </button>
            <button type="button" @click="resolveAgentExternalApproval(approval.jobId, false)">Ablehnen</button>
          </div>
        </article>
      </section>

      <section v-if="session?.execution" class="planning-workspace__section">
        <div class="planning-workspace__section-heading">
          <div>
            <span>05</span>
            <h3>Ausführungslauf</h3>
          </div>
          <small>{{ session.execution.status }}</small>
        </div>
        <div class="planning-workspace__run-grid">
          <article v-for="node in session.execution.nodes" :key="node.id" :data-status="node.status">
            <header>
              <strong>{{ node.label }}</strong
              ><span>{{ node.status }}</span>
            </header>
            <p>{{ node.role }} · {{ node.permission === 'workspace-write' ? 'Schreiben' : 'Lesen' }}</p>
            <p v-if="node.errorCode" class="planning-workspace__alert">{{ node.errorCode }}</p>
            <details v-if="node.output" :open="node.status === 'completed'">
              <summary>Schrittausgabe</summary>
              <pre>{{ node.output }}</pre>
            </details>
          </article>
        </div>
        <details v-if="session.output">
          <summary>Konsolidiertes Ergebnis</summary>
          <pre>{{ session.output }}</pre>
        </details>
        <button v-if="operationActive" type="button" class="planning-workspace__danger" @click="cancel">
          Ausführung abbrechen
        </button>
      </section>

      <section class="planning-workspace__section planning-workspace__transfer">
        <div class="planning-workspace__section-heading">
          <div>
            <span>↕</span>
            <h3>Plan importieren oder exportieren</h3>
          </div>
        </div>
        <div class="planning-workspace__actions">
          <button type="button" :disabled="!session?.plan" @click="showExport">JSON anzeigen</button>
          <button type="button" :disabled="!session?.plan" @click="downloadExport">JSON herunterladen</button>
          <label class="planning-workspace__file"
            >JSON-Datei auswählen<input type="file" accept="application/json,.json" @change="readImportFile"
          /></label>
        </div>
        <label v-if="exportText">Exportiertes Plan-JSON<textarea :value="exportText" rows="8" readonly /></label>
        <label
          >Plan-JSON importieren<textarea
            v-model="importText"
            rows="8"
            :maxlength="MAX_PLANNING_IMPORT_CHARACTERS"
            :disabled="operationActive"
            placeholder="Exportiertes Luczor-Plan-JSON einfügen"
          />
        </label>
        <button type="button" :disabled="!importText.trim() || interactionBlocked" @click="restore">
          Plan zur Prüfung importieren
        </button>
        <p>
          Ein importierter Plan bleibt angehalten. Wiederherstellung startet niemals automatisch eine Analyse oder
          Ausführung.
        </p>
      </section>
    </div>
  </dialog>
</template>

<style scoped>
.planning-workspace {
  width: min(1180px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  padding: 0;
  border: 1px solid var(--border, #34404e);
  border-radius: 18px;
  background: var(--surface, #111820);
  color: var(--text-primary, #edf2f8);
  box-shadow: 0 28px 100px #000a;
}
.planning-workspace::backdrop {
  background: #05080dcc;
}
.planning-workspace__header {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 28px;
  border-bottom: 1px solid #ffffff16;
  background: #111820f2;
  backdrop-filter: blur(16px);
}
.planning-workspace__header h2,
.planning-workspace__header p,
.planning-workspace__section h3,
.planning-workspace__section h4 {
  margin: 0;
}
.planning-workspace__eyebrow,
.planning-workspace__section-heading span {
  color: #77b5d9;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.planning-workspace__eyebrow {
  margin-bottom: 6px !important;
}
.planning-workspace__header-actions,
.planning-workspace__actions,
.planning-workspace__section-heading,
.planning-workspace__section-heading > div,
.planning-workspace__step header,
.planning-workspace__run-grid article header,
.planning-workspace__questions > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.planning-workspace__header-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.planning-workspace__status {
  padding: 6px 10px;
  border: 1px solid #72a8ca55;
  border-radius: 999px;
  color: #bfe5fb;
  font-size: 12px;
}
.planning-workspace__status[data-status='failed'],
.planning-workspace__status[data-status='cancelled'] {
  border-color: #df7f7f66;
  color: #ffb0b0;
}
.planning-workspace__body {
  padding: 0 28px 36px;
}
.planning-workspace__phases {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  margin: 0 -28px;
  padding: 0;
  border-bottom: 1px solid #ffffff12;
  list-style: none;
  background: #ffffff12;
}
.planning-workspace__phases li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 28px;
  background: #111820;
  color: #718092;
  font-size: 12px;
}
.planning-workspace__phases li[data-state='active'] {
  background: #132433;
  color: #d8effd;
}
.planning-workspace__phases li[data-state='done'] {
  color: #8ed6b3;
}
.planning-workspace__phases span {
  font-family: var(--font-mono, monospace);
}
.planning-workspace__section {
  padding: 28px 0;
  border-bottom: 1px solid #ffffff12;
}
.planning-workspace__section-heading {
  justify-content: space-between;
  margin-bottom: 18px;
}
.planning-workspace__section-heading > div {
  align-items: baseline;
}
.planning-workspace__section-heading small,
.planning-workspace__actions span,
.planning-workspace__section > p,
.planning-workspace__step p,
.planning-workspace__transfer p {
  color: #94a3b4;
  font-size: 12px;
}
.planning-workspace label {
  display: grid;
  gap: 7px;
  margin: 12px 0;
  color: #b9c5d2;
  font-size: 12px;
}
.planning-workspace input,
.planning-workspace textarea,
.planning-workspace select,
.planning-workspace button {
  font: inherit;
}
.planning-workspace input,
.planning-workspace textarea,
.planning-workspace select {
  min-width: 0;
  border: 1px solid #3a4756;
  border-radius: 8px;
  background: #0b1118;
  color: #edf2f8;
  padding: 10px 12px;
}
.planning-workspace textarea {
  resize: vertical;
  line-height: 1.5;
}
.planning-workspace input:focus,
.planning-workspace textarea:focus,
.planning-workspace select:focus {
  outline: 2px solid #4ea8de88;
  outline-offset: 1px;
}
.planning-workspace button,
.planning-workspace__file {
  border: 1px solid #425164;
  border-radius: 8px;
  background: #17212c;
  color: #e6edf5;
  padding: 9px 13px;
  cursor: pointer;
}
.planning-workspace button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.planning-workspace .planning-workspace__primary,
.planning-workspace__execute {
  border-color: #4ea8deaa;
  background: #17628d;
  color: white;
}
.planning-workspace .planning-workspace__danger {
  border-color: #ad575777;
  color: #ffb7b7;
}
.planning-workspace__execute {
  width: 100%;
  padding: 13px 18px !important;
  font-weight: 700 !important;
}
.planning-workspace__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.planning-workspace__actions {
  flex-wrap: wrap;
  margin-top: 16px;
}
.planning-workspace__summary {
  color: #dbe7f3 !important;
  font-size: 15px !important;
  line-height: 1.6;
}
.planning-workspace__analysis-grid,
.planning-workspace__run-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.planning-workspace__analysis-grid article,
.planning-workspace__run-grid article,
.planning-workspace__questions,
.planning-workspace__egress article {
  border: 1px solid #ffffff16;
  border-radius: 12px;
  background: #0d141c;
  padding: 16px;
}
.planning-workspace__analysis-grid h4 {
  font-size: 13px;
}
.planning-workspace ul {
  margin: 10px 0 0;
  padding-left: 20px;
  color: #bac6d3;
  line-height: 1.55;
}
.planning-workspace__questions {
  margin-top: 14px;
  border-color: #d2a44e66;
  background: #2b2211;
}
.planning-workspace__questions > div {
  justify-content: space-between;
  color: #f6d696;
}
.planning-workspace__steps {
  display: grid;
  gap: 14px;
  margin-bottom: 14px;
}
.planning-workspace__step {
  padding: 18px;
  border: 1px solid #ffffff17;
  border-radius: 12px;
  background: #0c131a;
}
.planning-workspace__step header input {
  flex: 1;
  font-weight: 700;
}
.planning-workspace__step header > span {
  width: 28px;
  color: #77b5d9;
  font-family: var(--font-mono, monospace);
}
.planning-workspace__closing-criteria {
  margin-top: 16px;
}
.planning-workspace details {
  margin-top: 12px;
}
.planning-workspace summary {
  cursor: pointer;
  color: #bcd5e5;
}
.planning-workspace pre {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #cbd6e1;
  font-size: 11px;
}
.planning-workspace__hash {
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
}
.planning-workspace__alert,
.planning-workspace__notice {
  padding: 12px 14px;
  border-radius: 9px;
}
.planning-workspace__alert {
  border: 1px solid #c65d5d66;
  background: #341818;
  color: #ffb8b8 !important;
}
.planning-workspace__notice {
  border: 1px solid #4ea8de55;
  background: #112a39;
  color: #bce6ff;
}
.planning-workspace__file {
  display: inline-flex !important;
  margin: 0 !important;
}
.planning-workspace__file input {
  display: none;
}
@media (max-width: 760px) {
  .planning-workspace {
    width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
  }
  .planning-workspace__header,
  .planning-workspace__body {
    padding-left: 18px;
    padding-right: 18px;
  }
  .planning-workspace__phases {
    margin-left: -18px;
    margin-right: -18px;
  }
  .planning-workspace__phases li {
    padding: 12px;
  }
  .planning-workspace__fields,
  .planning-workspace__analysis-grid,
  .planning-workspace__run-grid {
    grid-template-columns: 1fr;
  }
  .planning-workspace__header {
    align-items: flex-start;
  }
}
</style>
