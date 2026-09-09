<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { WorkflowController } from '@/services/workflows/controller'
import { boundedWorkflowJson } from '@/services/workflows/operations'
import { workflowChanged, workflowWebhookSecrets } from '@/services/workflows/presentation'
import {
  isTerminalWorkflow,
  workflowStatusLabel,
  type WorkflowDefinition,
  type WorkflowRevision,
  type WorkflowStepDefinition,
  type WorkflowTrigger,
} from '@/services/workflows/types'
import type { LuczorMode } from '@/services/inference/types'
import { requestConfirmation } from '@/services/confirmation'
import WorkflowStepEditor from './WorkflowStepEditor.vue'
import WorkflowGraphEditor from './WorkflowGraphEditor.vue'
import WorkflowTriggerEditor from './WorkflowTriggerEditor.vue'
import WorkflowTestsPanel from './WorkflowTestsPanel.vue'
const props = withDefaults(
  defineProps<{
    open: boolean
    projectId: string
    mode: LuczorMode
    killSwitch: boolean
    busy?: boolean
    initialWorkflowId?: number
    initialRunId?: string
    controllerProp?: WorkflowController
  }>(),
  { busy: false, initialWorkflowId: undefined, initialRunId: undefined, controllerProp: undefined }
)
const emit = defineEmits<{ 'update:open': [open: boolean]; discuss: [text: string] }>()
const controller = props.controllerProp ?? new WorkflowController()
const view = controller.view
const dialog = ref<HTMLDialogElement | null>(null)
const tab = ref('edit')
const tabs = [
  { id: 'edit', label: 'Ablauf' },
  { id: 'inputs', label: 'Eingaben' },
  { id: 'tests', label: 'Tests' },
  { id: 'automation', label: 'Automatisierung' },
  { id: 'runs', label: 'Läufe' },
  { id: 'versions', label: 'Versionen' },
]
const query = ref('')
const name = ref('')
const draft = ref<WorkflowDefinition>({ steps: [] })
const inputSchemaText = ref('{}')
const initialDraft = ref('')
const changeSummary = ref('')
const localError = ref('')
const creating = ref(false)
const stepIndex = ref(0)
const newTask = ref('llm')
const runInput = ref('{}')
const selectedRevision = ref<number>()
const editingTrigger = ref<WorkflowTrigger>()
const showTriggerEditor = ref(false)
const manualResults = ref<Record<number, string>>({})
const exportResults = ref(false)
const allowedOutputKeys = ref('')
let poll: ReturnType<typeof setInterval> | undefined
let openGeneration = 0
const blocked = computed(() => props.killSwitch || props.busy || view.busy)
const writeBlocked = computed(() => blocked.value || props.mode === 'observe')
const locked = computed(() => !creating.value && !!(view.selected?.is_edit_locked || view.selected?.is_locked))
const filtered = computed(() =>
  view.workflows.filter(item => item.name.toLocaleLowerCase('de').includes(query.value.toLocaleLowerCase('de')))
)
const dirty = computed(
  () =>
    JSON.stringify({ name: name.value, definition: draft.value, schema: inputSchemaText.value }) !== initialDraft.value
)
const activeStep = computed(() => draft.value.steps[stepIndex.value])
const revision = computed(() => (view.revision?.version === selectedRevision.value ? view.revision : null))
const versionChanges = computed(() => {
  if (!revision.value || !view.selected) return []
  const before = new Map(revision.value.definition.steps.map(step => [step.key, step]))
  const after = new Map(view.selected.definition.steps.map(step => [step.key, step]))
  const changes: string[] = []
  for (const [key, step] of after) {
    if (!before.has(key)) changes.push(`Hinzugefügt: ${String(step.payload.title ?? key)}`)
    else if (JSON.stringify(before.get(key)) !== JSON.stringify(step))
      changes.push(`Geändert: ${String(step.payload.title ?? key)}`)
  }
  for (const [key, step] of before) if (!after.has(key)) changes.push(`Entfernt: ${String(step.payload.title ?? key)}`)
  return changes
})
function draftSnapshot() {
  return JSON.stringify({ name: name.value, definition: draft.value, schema: inputSchemaText.value })
}
function cloneDefinition(value: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(boundedWorkflowJson(value)) as WorkflowDefinition
}
function fillDraft() {
  if (!view.selected) return
  creating.value = false
  name.value = view.selected.name
  draft.value = cloneDefinition(view.selected.definition)
  for (const step of draft.value.steps) step.payload ??= {}
  inputSchemaText.value = JSON.stringify(draft.value.input_schema ?? {}, null, 2)
  initialDraft.value = draftSnapshot()
  changeSummary.value = ''
  localError.value = ''
  stepIndex.value = 0
  selectedRevision.value = view.selected.revisions?.[0]?.version
}
function newWorkflow(copy = false) {
  creating.value = true
  name.value = copy ? `${view.selected?.name ?? 'Workflow'} – Kopie` : ''
  draft.value = copy && view.selected ? cloneDefinition(view.selected.definition) : { steps: [] }
  inputSchemaText.value = JSON.stringify(draft.value.input_schema ?? {}, null, 2)
  initialDraft.value = draftSnapshot()
  changeSummary.value = copy ? 'Bearbeitbare Kopie erstellt.' : 'Erste Version.'
  stepIndex.value = 0
  tab.value = 'edit'
  localError.value = ''
}
async function selectWorkflow(id: number) {
  if (dirty.value) {
    localError.value = 'Zuerst den Entwurf speichern oder verwerfen.'
    return
  }
  await controller.select(id)
  fillDraft()
  tab.value = 'edit'
  showTriggerEditor.value = false
}
function updateStep(index: number, next: WorkflowStepDefinition) {
  const previous = draft.value.steps.at(index)?.key
  draft.value.steps.splice(index, 1, next)
  if (previous && previous !== next.key) {
    for (const step of draft.value.steps) {
      step.depends_on = step.depends_on?.map(key => (key === previous ? next.key : key))
      for (const route of Object.values(step.routes ?? {})) if (route.step_key === previous) route.step_key = next.key
      const bindings = step.payload.input_bindings as Record<string, string> | undefined
      if (bindings)
        for (const [key, source] of Object.entries(bindings))
          if (source.startsWith(`steps.${previous}.`))
            Reflect.set(bindings, key, `steps.${next.key}.${source.slice(previous.length + 7)}`)
    }
  }
}
function addStep() {
  let index = draft.value.steps.length + 1
  while (draft.value.steps.some(step => step.key === `schritt_${index}`)) index++
  const task = view.catalog.find(item => item.key === newTask.value)
  const payload: Record<string, unknown> = { title: task?.label ?? newTask.value }
  for (const [key, parameter] of Object.entries(task?.params ?? {}))
    if (parameter.default !== undefined && !['__proto__', 'constructor', 'prototype'].includes(key))
      Reflect.set(payload, key, parameter.default)
  draft.value.steps.push({
    key: `schritt_${index}`,
    type: newTask.value,
    depends_on: draft.value.steps.length ? [draft.value.steps.at(-1)!.key] : [],
    payload,
  })
  stepIndex.value = draft.value.steps.length - 1
}
function removeStep(index: number) {
  const removed = draft.value.steps.splice(index, 1)[0]
  if (!removed) return
  for (const step of draft.value.steps) {
    step.depends_on = step.depends_on?.filter(key => key !== removed.key)
    for (const [outcome, route] of Object.entries(step.routes ?? {}))
      if (route.step_key === removed.key) Reflect.deleteProperty(step.routes!, outcome)
  }
  stepIndex.value = Math.max(0, Math.min(index, draft.value.steps.length - 1))
}
function moveStep(index: number, direction: number) {
  const target = index + direction
  if (target < 0 || target >= draft.value.steps.length) return
  const steps = [...draft.value.steps]
  steps.splice(target, 0, steps.splice(index, 1)[0]!)
  draft.value.steps = steps
  stepIndex.value = target
}
function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Ein JSON-Objekt wird erwartet.')
  boundedWorkflowJson(parsed)
  return parsed as Record<string, unknown>
}
async function save(validateOnly = false) {
  try {
    localError.value = ''
    const definition = cloneDefinition(draft.value)
    const schema = parseObject(inputSchemaText.value)
    if (Object.keys(schema).length) definition.input_schema = schema
    else delete definition.input_schema
    if (validateOnly) {
      const result = await controller.action('workflow_validate', {
        definition,
        ...(!creating.value && view.selected ? { workflow_id: view.selected.id } : {}),
      })
      if (result) view.notice = 'Definition geprüft. Es wurde nichts ausgeführt.'
      return
    }
    const args = {
      name: name.value.trim(),
      definition,
      change_summary: changeSummary.value.trim() || 'Ablauf in der Workflow-Ansicht bearbeitet.',
    }
    const result = await controller.action(
      creating.value ? 'workflow_create' : 'workflow_update',
      creating.value ? args : { ...args, workflow_id: view.selected!.id, expected_version: view.selected!.version }
    )
    if (result) {
      fillDraft()
      view.notice = `Version ${view.selected?.version} gespeichert.`
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Entwurf prüfen.'
  }
}
async function start(sandbox: boolean) {
  if (!view.selected || dirty.value) return
  try {
    const result = await controller.action('workflow_run_start', {
      workflow_id: view.selected.id,
      input: parseObject(runInput.value),
      sandbox,
    })
    if (result) tab.value = 'runs'
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Eingaben prüfen.'
  }
}
function discuss() {
  const selected = view.selected
  emit(
    'discuss',
    selected
      ? `Lass uns Workflow „${selected.name}“ (ID ${selected.id}, Version ${selected.version}) verbessern. Lies zuerst die aktuelle Definition${view.run ? ` und den Lauf ${view.run.public_id}` : ' und relevante letzte Läufe'}. Begründe Änderungen anhand des Ziels und vorhandener Ergebnisse. Starte den Ablauf erst auf meinen Auftrag.`
      : 'Erstelle mit mir einen wiederverwendbaren Workflow für dieses Projekt. Kläre das Ziel und nutze die Workflow-Aufgabenbibliothek für ausführbare Schritte.'
  )
  emit('update:open', false)
}
function restore(item: WorkflowRevision) {
  draft.value = cloneDefinition(item.definition)
  name.value = item.name ?? view.selected!.name
  inputSchemaText.value = JSON.stringify(draft.value.input_schema ?? {}, null, 2)
  changeSummary.value = `Version ${item.version} als neue Version wiederhergestellt.`
  tab.value = 'edit'
  creating.value = false
}
async function saveTrigger(args: Record<string, unknown>) {
  if (!view.selected) return
  const clean = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
  const result = await controller.action('workflow_trigger_save', { ...clean, workflow_id: view.selected.id })
  if (result) {
    showTriggerEditor.value = false
    editingTrigger.value = undefined
  }
}
function editTrigger(trigger?: WorkflowTrigger) {
  editingTrigger.value = trigger
  showTriggerEditor.value = true
}
async function deleteTrigger(trigger: WorkflowTrigger) {
  if (!view.selected) return
  const approved = await requestConfirmation(
    `Auslöser „${trigger.name}“ entfernen? Laufende Workflows bleiben erhalten.`,
    'Workflow-Auslöser'
  )
  if (approved.approved)
    await controller.action('workflow_trigger_delete', { workflow_id: view.selected.id, trigger_id: trigger.id })
}
async function automation(status: 'active' | 'revoked') {
  if (!view.selected) return
  const allowed_output_keys = allowedOutputKeys.value
    .split(',')
    .map(key => key.trim())
    .filter(Boolean)
  await controller.action('workflow_automation_configure', {
    workflow_id: view.selected.id,
    status,
    ...(status === 'active'
      ? {
          export_results: exportResults.value,
          allowed_output_keys: allowed_output_keys.length
            ? allowed_output_keys
            : view.selected.definition.steps.map(step => step.key),
        }
      : {}),
  })
}
async function completeManual(id: number) {
  try {
    await controller.approveStep(id, parseObject(Reflect.get(manualResults.value, id) ?? '{}'))
  } catch (error) {
    localError.value = error instanceof Error ? error.message : 'Ergebnis prüfen.'
  }
}
async function refreshSelected() {
  if (!view.selected || dirty.value) return
  await controller.select(view.selected.id)
  fillDraft()
}
async function showTestRun(id: string) {
  await controller.refreshRun(id)
  tab.value = 'runs'
}
function keyboardTab(event: KeyboardEvent, index: number) {
  let target = index
  if (event.key === 'ArrowRight') target = (index + 1) % tabs.length
  else if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length
  else if (event.key === 'Home') target = 0
  else if (event.key === 'End') target = tabs.length - 1
  else return
  event.preventDefault()
  tab.value = tabs.at(target)!.id
  void nextTick(() => dialog.value?.querySelector<HTMLButtonElement>(`#wf-tab-${tab.value}`)?.focus())
}
function clearIdentity() {
  controller.reset()
  draft.value = { steps: [] }
  name.value = ''
  inputSchemaText.value = '{}'
  runInput.value = '{}'
  manualResults.value = {}
  exportResults.value = false
  allowedOutputKeys.value = ''
  initialDraft.value = draftSnapshot()
  showTriggerEditor.value = false
  editingTrigger.value = undefined
}
if (typeof window !== 'undefined') window.addEventListener('luczor:api-identity-changing', clearIdentity)
watch(
  () => [props.open, props.projectId, props.initialWorkflowId] as const,
  async ([open, projectId, workflowId]) => {
    const generation = ++openGeneration
    await nextTick()
    if (!open) {
      dialog.value?.close()
      return
    }
    if (!dialog.value?.open) dialog.value?.showModal()
    if (projectId !== view.projectId) {
      clearIdentity()
      await controller.load(projectId, workflowId)
      if (generation === openGeneration) fillDraft()
    } else if (!dirty.value) {
      await controller.load(projectId, workflowId)
      if (generation === openGeneration) fillDraft()
    }
    if (generation === openGeneration && props.initialRunId && view.selected) {
      await controller.refreshRun(props.initialRunId)
      tab.value = 'runs'
    }
  },
  { immediate: true }
)
watch(workflowChanged, change => {
  if (!props.open || change.projectId !== props.projectId || view.busy) return
  if (dirty.value) {
    view.notice = 'Eine neue Serverfassung ist verfügbar. Dein Entwurf bleibt erhalten.'
    return
  }
  void controller.load(props.projectId, view.selected?.id).then(fillDraft)
})
watch(
  () => [tab.value, selectedRevision.value] as const,
  ([activeTab, version]) => {
    if (activeTab === 'versions' && version && view.selected && !view.busy) void controller.loadRevision(version)
  }
)
watch(
  () => [props.open, view.run?.public_id, view.run?.status] as const,
  ([open, runId, status]) => {
    if (poll) clearInterval(poll)
    if (open && runId && status && !isTerminalWorkflow(status))
      poll = setInterval(() => {
        if (!view.busy) void controller.refreshRun(runId)
      }, 5000)
  }
)
onBeforeUnmount(() => {
  if (poll) clearInterval(poll)
  controller.reset()
  window.removeEventListener('luczor:api-identity-changing', clearIdentity)
})
</script>
<template>
  <dialog ref="dialog" class="wf-workspace" aria-labelledby="wf-title" @cancel.prevent="emit('update:open', false)">
    <header class="wf-header">
      <div>
        <span class="wf-eyebrow">PROJEKTAUTOMATISIERUNG</span>
        <h2 id="wf-title">Workflows</h2>
        <p>Im Gespräch entwickeln. Als verlässlichen Ablauf wiederverwenden.</p>
      </div>
      <button type="button" class="wf-close" aria-label="Workflows schließen" @click="emit('update:open', false)">
        ×
      </button>
    </header>
    <div class="wf-body">
      <aside class="wf-sidebar" aria-label="Workflow-Auswahl">
        <button
          type="button"
          class="ai-button ai-button--primary"
          :disabled="writeBlocked || dirty"
          @click="newWorkflow()"
        >
          Neuer Workflow</button
        ><button type="button" :disabled="busy" @click="discuss">Im Chat erstellen</button
        ><label class="wf-search">Suchen<input v-model="query" type="search" placeholder="Workflow suchen" /></label>
        <button
          v-for="workflow in filtered"
          :key="workflow.id"
          type="button"
          class="wf-list-item"
          :class="{ selected: !creating && view.selected?.id === workflow.id }"
          :aria-current="!creating && view.selected?.id === workflow.id ? 'true' : undefined"
          :disabled="view.busy"
          @click="selectWorkflow(workflow.id)"
        >
          <strong>{{ workflow.name }}</strong
          ><small>Version {{ workflow.version }} · {{ workflowStatusLabel(workflow.status) }}</small>
        </button>
        <p v-if="!filtered.length" class="wf-muted">
          {{ view.busy ? 'Workflows werden geladen…' : 'Noch keine Workflows in diesem Projekt.' }}
        </p>
      </aside>
      <main class="wf-main">
        <p v-if="killSwitch" role="status" class="wf-error">Not-Aus aktiv. Neue Aktionen sind gesperrt.</p>
        <p v-else-if="mode === 'observe'" class="wf-muted">Beobachten · Lesen und Prüfen sind verfügbar.</p>
        <p v-if="view.error || localError" class="wf-error" role="alert">{{ localError || view.error }}</p>
        <p v-if="view.notice" role="status" class="wf-notice">{{ view.notice }}</p>
        <p v-if="view.busy" class="wf-muted" role="status">Wird verarbeitet…</p>
        <div v-if="view.selected || creating" class="wf-titlebar">
          <div>
            <h3>{{ creating ? name || 'Neuer Workflow' : view.selected?.name }}</h3>
            <span class="wf-muted"
              >{{ creating ? 'Noch nicht gespeichert' : `Version ${view.selected?.version}`
              }}<span v-if="dirty"> · Ungespeicherte Änderungen</span></span
            >
          </div>
          <button type="button" :disabled="busy" @click="discuss">Im Chat verbessern</button>
        </div>
        <div v-if="view.selected && !creating" class="wf-actions">
          <button type="button" :disabled="writeBlocked || dirty" class="ai-button ai-button--primary" @click="start(false)">Workflow starten</button>
          <button type="button" :disabled="writeBlocked || dirty" @click="start(true)">Ohne Effekte simulieren</button>
          <button type="button" :disabled="writeBlocked || dirty" @click="newWorkflow(true)">Als Kopie bearbeiten</button>
          <span class="wf-muted">{{ view.selected.definition.steps.length }} Schritte · {{ view.triggers.filter(item => item.enabled).length }} aktive Auslöser</span>
        </div>
        <div class="wf-tabs" role="tablist" aria-label="Workflow-Bereiche">
          <button
            v-for="(item, index) in tabs"
            :id="`wf-tab-${item.id}`"
            :key="item.id"
            type="button"
            role="tab"
            :aria-selected="tab === item.id"
            :aria-controls="`wf-panel-${item.id}`"
            :tabindex="tab === item.id ? 0 : -1"
            @click="tab = item.id"
            @keydown="keyboardTab($event, index)"
          >
            {{ item.label }}
          </button>
        </div>
        <section v-if="tab === 'edit'" id="wf-panel-edit" role="tabpanel" aria-labelledby="wf-tab-edit">
          <template v-if="view.selected || creating"
            ><p v-if="locked" class="wf-notice">
              Dieser Ablauf ist gesperrt oder eingebettet. Erstelle eine bearbeitbare Kopie.
            </p>
            <label>Name<input v-model="name" :disabled="writeBlocked || locked" maxlength="160" /></label>
            <WorkflowGraphEditor
              v-model="draft"
              :catalog="view.catalog"
              :disabled="writeBlocked || locked"
              @select="stepIndex = draft.steps.findIndex(step => step.key === $event)"
            />
            <div class="wf-editor">
              <div class="wf-step-list">
                <div
                  v-for="(step, index) in draft.steps"
                  :key="index"
                  class="wf-step-row"
                  :class="{ selected: index === stepIndex }"
                >
                  <button type="button" @click="stepIndex = index">
                    <span>{{ index + 1 }}</span
                    >{{ step.payload.title || step.key }}
                  </button>
                  <div>
                    <button
                      type="button"
                      :aria-label="`${step.key} nach oben`"
                      :disabled="writeBlocked || locked || index === 0"
                      @click="moveStep(index, -1)"
                    >
                      ↑</button
                    ><button
                      type="button"
                      :aria-label="`${step.key} nach unten`"
                      :disabled="writeBlocked || locked || index === draft.steps.length - 1"
                      @click="moveStep(index, 1)"
                    >
                      ↓</button
                    ><button
                      type="button"
                      :aria-label="`${step.key} entfernen`"
                      :disabled="writeBlocked || locked"
                      @click="removeStep(index)"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <label
                  >Aufgabe hinzufügen<select v-model="newTask" :disabled="writeBlocked || locked">
                    <option v-for="task in view.catalog" :key="task.key" :value="task.key">{{ task.label }}</option>
                  </select></label
                ><button type="button" :disabled="writeBlocked || locked || draft.steps.length >= 100" @click="addStep">
                  Schritt hinzufügen
                </button>
              </div>
              <WorkflowStepEditor
                v-if="activeStep"
                :step="activeStep"
                :steps="draft.steps"
                :catalog="view.catalog"
                :workspace-root="view.rootPath"
                :disabled="writeBlocked || locked"
                @update:step="updateStep(stepIndex, $event)"
              />
              <p v-else class="wf-muted">Wähle die erste Aufgabe aus der Bibliothek.</p>
            </div>
            <label
              >Was ändert sich?<textarea
                v-model="changeSummary"
                :disabled="writeBlocked || locked"
                rows="2"
                maxlength="1000"
                placeholder="Die wesentlichen Änderungen dieser Version"
              />
            </label>
            <div class="wf-actions">
              <button type="button" :disabled="blocked" @click="save(true)">Definition prüfen</button
              ><button
                type="button"
                :disabled="writeBlocked || locked || !name.trim() || !draft.steps.length"
                class="ai-button ai-button--primary"
                @click="save()"
              >
                {{ creating ? 'Workflow speichern' : 'Neue Version speichern' }}</button
              ><button v-if="dirty && view.selected" type="button" :disabled="view.busy" @click="fillDraft">
                Entwurf verwerfen
              </button>
            </div>
          </template>
          <p v-else class="wf-muted">Wähle einen Workflow oder erstelle einen neuen.</p>
        </section>
        <section v-if="tab === 'inputs'" id="wf-panel-inputs" role="tabpanel" aria-labelledby="wf-tab-inputs">
          <template v-if="view.selected || creating">
            <h4>Eingaben für den Ablauf</h4>
            <p class="wf-muted">Das Schema gehört zur gespeicherten Workflow-Version. Startwerte gelten nur für den nächsten manuellen Lauf.</p>
            <label>Eingabeschema (JSON)<textarea v-model="inputSchemaText" :disabled="writeBlocked || locked" rows="9" spellcheck="false" /></label>
            <div class="wf-actions">
              <button type="button" :disabled="blocked" @click="save(true)">Definition prüfen</button>
              <button type="button" :disabled="writeBlocked || locked || !name.trim() || !draft.steps.length" @click="save()">Workflow mit Eingabeschema speichern</button>
            </div>
            <label>Startwerte (JSON)<textarea v-model="runInput" :disabled="writeBlocked" rows="7" spellcheck="false" /></label>
            <p class="wf-muted">Im Bereich Tests kannst du feste Beispieldaten mit überprüfbaren Ergebnisregeln speichern.</p>
          </template>
          <p v-else class="wf-muted">Wähle zuerst einen Workflow.</p>
        </section>
        <section v-if="tab === 'tests'" id="wf-panel-tests" role="tabpanel" aria-labelledby="wf-tab-tests">
          <WorkflowTestsPanel
            v-if="view.selected && !creating && open"
            :key="`${projectId}:${view.selected.id}`"
            :workflow="view.selected"
            :project-id="projectId"
            :disabled="writeBlocked"
            :dirty="dirty"
            :runs="view.runs"
            @changed="refreshSelected"
            @run="showTestRun"
          />
          <p v-else class="wf-muted">Speichere zuerst einen Workflow, um Tests und Nachweise zu verwalten.</p>
        </section>
        <section v-if="tab === 'versions'" id="wf-panel-versions" role="tabpanel" aria-labelledby="wf-tab-versions">
          <template v-if="view.selected"
            ><label
              >Vergleichen mit<select v-model="selectedRevision">
                <option v-for="item in view.selected.revisions ?? []" :key="item.id" :value="item.version">
                  Version {{ item.version }} · {{ new Date(item.created_at).toLocaleString('de-DE') }}
                </option>
              </select></label
            ><template v-if="revision"
              ><p>{{ revision.change_summary || 'Gespeicherte Workflow-Fassung' }}</p>
              <ul>
                <li v-for="change in versionChanges" :key="change">{{ change }}</li>
              </ul>
              <p v-if="!versionChanges.length" class="wf-muted">
                Die Ablaufschritte stimmen mit der aktuellen Fassung überein.
              </p>
              <details>
                <summary>Gespeicherten Ablauf ansehen</summary>
                <pre>{{ JSON.stringify(revision.definition, null, 2) }}</pre>
              </details>
              <button type="button" :disabled="writeBlocked || locked || dirty" @click="restore(revision)">
                Als neue Version vorbereiten
              </button></template
            >
            <p class="wf-muted">
              Laufende Instanzen behalten ihre gestartete Fassung. Künftige automatische Starts verwenden die aktuelle
              Version.
            </p></template
          >
        </section>
        <section v-if="tab === 'automation'" id="wf-panel-automation" role="tabpanel" aria-labelledby="wf-tab-automation">
          <template v-if="view.selected"
            ><div class="wf-section-heading">
              <h4>Auslöser</h4>
              <button type="button" :disabled="writeBlocked" @click="editTrigger()">Auslöser hinzufügen</button>
            </div>
            <p v-if="view.sourcesError" class="wf-error">{{ view.sourcesError }}</p>
            <article v-for="trigger in view.triggers" :key="trigger.id" class="wf-trigger">
              <div class="wf-section-heading">
                <div>
                  <strong>{{ trigger.name }}</strong
                  ><small>{{ trigger.enabled ? 'Aktiv' : 'Pausiert' }} · {{ trigger.kind }}</small>
                </div>
                <span v-if="trigger.next_due_at">{{ new Date(trigger.next_due_at).toLocaleString('de-DE') }}</span>
              </div>
              <p v-if="trigger.last_error" class="wf-error">{{ trigger.last_error }}</p>
              <template v-if="trigger.kind === 'webhook'"
                ><details>
                  <summary>Webhook verbinden</summary>
                  <p>
                    POST
                    {{
                      trigger.webhook_url ||
                      `${view.baseUrl.replace(/\/$/, '')}/api/v1/workflow-hooks/${trigger.public_id}`
                    }}
                  </p>
                  <p>Header: X-Workflow-Secret und X-Workflow-Event-ID</p>
                  <label v-if="workflowWebhookSecrets[trigger.id]"
                    >Einmalig sichtbarer Schlüssel<input
                      :value="workflowWebhookSecrets[trigger.id]"
                      readonly
                      autocomplete="off"
                  /></label>
                  <p v-else class="wf-muted">
                    Der Schlüssel wird nur direkt nach dem Anlegen angezeigt. Für einen neuen Schlüssel den Auslöser neu
                    anlegen.
                  </p>
                </details></template
              >
              <div class="wf-actions">
                <button type="button" :disabled="writeBlocked" @click="editTrigger(trigger)">Bearbeiten</button
                ><button type="button" :disabled="blocked" @click="controller.deliveries(trigger.id)">
                  Zustellungen</button
                ><button type="button" :disabled="writeBlocked" @click="deleteTrigger(trigger)">Entfernen</button>
              </div>
            </article>
            <p v-if="!view.triggers.length" class="wf-muted">Noch keine Zeitpläne oder Ereignisauslöser.</p>
            <WorkflowTriggerEditor
              v-if="showTriggerEditor"
              :trigger="editingTrigger"
              :disabled="writeBlocked"
              :device-id="view.deviceId"
              :root-path="view.rootPath"
              :repositories="view.sources.repositories"
              :workflows="view.sources.workflows"
              @save="saveTrigger"
            />
            <div v-if="view.deliveries.length" class="wf-deliveries">
              <h4>Letzte Zustellungen</h4>
              <div v-for="delivery in view.deliveries" :key="delivery.id">
                <span>{{ workflowStatusLabel(delivery.status) }}</span>
                <p v-if="delivery.last_error || delivery.error" class="wf-error">
                  {{ delivery.last_error || delivery.error }}
                </p>
                <button
                  v-if="['failed', 'overflow', 'blocked'].includes(delivery.status)"
                  type="button"
                  :disabled="writeBlocked"
                  @click="controller.retryDelivery(delivery.id)"
                >
                  Erneut zustellen
                </button>
              </div>
            </div>
            <section class="wf-permission">
              <h4>Automatische Gerätearbeit</h4>
              <p>
                {{
                  view.grant?.status === 'active'
                    ? 'Für dieses Gerät freigegeben.'
                    : 'Noch keine aktive Freigabe für dieses Gerät.'
                }}
              </p>
              <p class="wf-muted">
                Die Freigabe zeigt Gerät, Ordner, Aufgaben und Grenzen. Neue Zugriffe sowie geänderte Skripte oder
                Agentenaufträge benötigen erneut deine Zustimmung.
              </p>
              <label class="wf-check"
                ><input v-model="exportResults" type="checkbox" :disabled="writeBlocked" />Ergebnisse freigegebener
                Schritte an den Luczor-Server übertragen</label
              ><label
                >Erlaubte Schritt-IDs für Ergebnisse<input
                  v-model="allowedOutputKeys"
                  :disabled="writeBlocked"
                  placeholder="Leer: alle Schritte dieser Version"
              /></label>
              <p class="wf-muted">
                Mehrere Schritt-IDs durch Komma trennen. Ohne Ergebnisübertragung warten lokale Schritte auf eine
                einzelne Freigabe.
              </p>
              <div class="wf-actions">
                <button type="button" :disabled="writeBlocked || dirty" @click="automation('active')">
                  Freigabe prüfen und einrichten</button
                ><button
                  v-if="view.grant?.status === 'active'"
                  type="button"
                  :disabled="writeBlocked"
                  @click="automation('revoked')"
                >
                  Freigabe widerrufen
                </button>
              </div>
            </section>
          </template>
        </section>
        <section v-if="tab === 'runs'" id="wf-panel-runs" role="tabpanel" aria-labelledby="wf-tab-runs">
          <div class="wf-run-list">
            <button
              v-for="run in view.runs"
              :key="run.public_id"
              type="button"
              :disabled="view.busy"
              :class="{ selected: view.run?.public_id === run.public_id }"
              @click="controller.refreshRun(run.public_id)"
            >
              <strong>{{ workflowStatusLabel(run.status) }}</strong
              ><span
                >{{ run.sandbox ? 'Testlauf' : 'Ausführung' }} ·
                {{ run.started_at ? new Date(run.started_at).toLocaleString('de-DE') : 'Noch nicht gestartet' }}</span
              ><small v-if="run.duration_ms != null">{{ (run.duration_ms / 1000).toFixed(1) }} s</small>
            </button>
          </div>
          <p v-if="!view.runs.length" class="wf-muted">Noch keine Läufe für diesen Workflow.</p>
          <template v-if="view.run"
            ><div class="wf-section-heading">
              <h4>{{ workflowStatusLabel(view.run.status) }}</h4>
              <button
                v-if="!isTerminalWorkflow(view.run.status)"
                type="button"
                :disabled="writeBlocked || view.run.status === 'cancelling'"
                @click="
                  controller.action('workflow_run_cancel', {
                    workflow_id: view.selected!.id,
                    run_id: view.run.public_id,
                  })
                "
              >
                {{ view.run.status === 'cancelling' ? 'Abbruch läuft…' : 'Lauf stoppen' }}
              </button>
            </div>
            <p class="wf-muted">
              {{
                view.run.definition_version
                  ? `Gestartete Version ${view.run.definition_version}`
                  : 'Historischer Lauf ohne belegbare Versionszuordnung'
              }}
            </p>
            <p v-if="view.run.sandbox" class="wf-notice">
              Testlauf · Effekte können simuliert sein. Dies ist keine reale Geräte- oder Modellabnahme.
            </p>
            <article v-for="step in view.run.steps ?? []" :key="step.id" class="wf-run-step">
              <div class="wf-section-heading">
                <strong>{{ step.step_key }}</strong
                ><span>{{ workflowStatusLabel(step.status) }}</span>
              </div>
              <p v-if="step.error" class="wf-error">{{ step.error }}</p>
              <small v-if="step.duration_ms != null">{{ (step.duration_ms / 1000).toFixed(1) }} s</small>
              <details v-if="step.output">
                <summary>Ergebnis</summary>
                <pre>{{ JSON.stringify(step.output, null, 2) }}</pre>
              </details>
              <button
                v-if="step.status === 'awaiting_approval'"
                type="button"
                :disabled="writeBlocked"
                @click="controller.approveStep(step.id)"
              >
                Diesen Schritt freigeben</button
              ><template v-if="step.type === 'manual' && ['ready', 'running'].includes(step.status)"
                ><label
                  >Manuelles Ergebnis (JSON)<textarea
                    v-model="manualResults[step.id]"
                    placeholder="{}"
                    rows="3"
                  /></label
                ><button type="button" :disabled="writeBlocked" @click="completeManual(step.id)">
                  Ergebnis übernehmen
                </button></template
              >
            </article>
            <button type="button" :disabled="busy" @click="discuss">Diesen Lauf im Chat auswerten</button></template
          >
        </section>
      </main>
    </div>
  </dialog>
</template>
<style src="./workflows.css"></style>
