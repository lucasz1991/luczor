<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { createWorkflowWebSession, type WorkflowEditorState } from '@/services/workflows/webSession'
import { boundedWorkflowJson } from '@/services/workflows/operations'
import type { WorkflowDefinition, WorkflowStepDefinition, WorkflowRun } from '@/services/workflows/types'
import { isTerminalWorkflow, workflowStatusLabel } from '@/services/workflows/types'
import { readWorkflowRunBudget } from '@/services/workflows/runBudget'
import WorkflowRunBudget from './WorkflowRunBudget.vue'
import WorkflowGraphEditor from './WorkflowGraphEditor.vue'
import WorkflowBudgetSettings from './WorkflowBudgetSettings.vue'
import WorkflowStepEditor from './WorkflowStepEditor.vue'
import ThinkingSelector from '@/components/ai/ThinkingSelector.vue'
const props = defineProps<{ stateUrl: string }>()
const session = createWorkflowWebSession(props.stateUrl)
const state = ref<WorkflowEditorState | null>(null)
const draft = ref<WorkflowDefinition>({ steps: [] })
const name = ref('')
const baseline = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const runsStale = ref(false)
let monitorTimer: ReturnType<typeof setInterval> | undefined
let monitoring = false
let refreshEpoch = 0
const tab = ref('flow')
const tabs = [
  { key: 'flow', label: 'Ablauf' },
  { key: 'inputs', label: 'Eingaben' },
  { key: 'tests', label: 'Tests' },
  { key: 'automation', label: 'Automatisierung' },
  { key: 'runs', label: 'Läufe' },
  { key: 'versions', label: 'Versionen' },
]
const selected = ref('')
const task = ref('llm')
const inputSchema = ref('{}')
const caseName = ref('')
const caseJson = ref('{"input":{},"fixtures":{},"assertions":[]}')
const caseId = ref<number>()
const failedRunId = ref<number>()
const blocked = computed(
  () => busy.value || !!state.value?.workflow.is_edit_locked || !!state.value?.workflow.is_locked
)
const dirty = computed(() => boundedWorkflowJson({ name: name.value, definition: draft.value }) !== baseline.value)
const activeStep = computed(() => draft.value.steps.find(step => step.key === selected.value))
function object(text: string): Record<string, unknown> {
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ein JSON-Objekt wird erwartet.')
  boundedWorkflowJson(value)
  return value
}
async function refresh(replace = true) {
  const epoch = ++refreshEpoch
  const next = await session.refresh()
  if (epoch !== refreshEpoch) return
  state.value = next
  runsStale.value = false
  if (replace) {
    draft.value = structuredClone(next.workflow.definition)
    name.value = next.workflow.name
    inputSchema.value = JSON.stringify(draft.value.input_schema ?? {}, null, 2)
    baseline.value = boundedWorkflowJson({ name: name.value, definition: draft.value })
    if (!draft.value.steps.some(step => step.key === selected.value)) selected.value = draft.value.steps[0]?.key ?? ''
  }
}
async function action(operation: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await operation()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Aktion fehlgeschlagen.'
  } finally {
    busy.value = false
  }
}
function updateStep(next: WorkflowStepDefinition) {
  const previous = selected.value
  if (next.key !== previous && draft.value.steps.some(step => step.key === next.key)) {
    error.value = 'Dieser Schrittschlüssel ist bereits vergeben.'
    return
  }
  draft.value.steps = draft.value.steps.map(step => (step.key === previous ? next : step))
  if (next.key !== previous) {
    for (const step of draft.value.steps) {
      step.depends_on = step.depends_on?.map(key => (key === previous ? next.key : key))
      for (const route of Object.values(step.routes ?? {})) if (route.step_key === previous) route.step_key = next.key
      const bindings = step.payload.input_bindings as Record<string, unknown> | undefined
      for (const [key, source] of Object.entries(bindings ?? {}))
        if (typeof source === 'string' && source.startsWith(`steps.${previous}.`))
          Reflect.set(bindings!, key, `steps.${next.key}.${source.slice(previous.length + 7)}`)
    }
    const positions = draft.value.meta?.node_positions
    if (positions && typeof positions === 'object' && Object.hasOwn(positions, previous)) {
      Reflect.set(positions, next.key, Reflect.get(positions, previous))
      Reflect.deleteProperty(positions, previous)
    }
    selected.value = next.key
  }
}
function addStep() {
  let number = draft.value.steps.length + 1
  while (draft.value.steps.some(step => step.key === `schritt_${number}`)) number++
  const item = state.value?.catalog.find(item => item.key === task.value)
  if (!item || blocked.value) return
  const payload = Object.fromEntries(
    Object.entries(item.params)
      .filter(([, value]) => value.default !== undefined)
      .map(([key, value]) => [key, value.default])
  )
  selected.value = `schritt_${number}`
  draft.value.steps.push({ key: selected.value, type: item.key, version: item.version ?? 1, payload })
}
function removeStep(key: string) {
  if (blocked.value) return
  draft.value.steps = draft.value.steps.filter(step => step.key !== key)
  for (const step of draft.value.steps) {
    step.depends_on = step.depends_on?.filter(dependency => dependency !== key)
    for (const [outcome, route] of Object.entries(step.routes ?? {})) {
      if (route.step_key === key) Reflect.deleteProperty(step.routes!, outcome)
    }
  }
  if (draft.value.meta?.node_positions) Reflect.deleteProperty(draft.value.meta.node_positions, key)
  if (selected.value === key) selected.value = draft.value.steps[0]?.key ?? ''
  notice.value = 'Schritt aus dem Entwurf entfernt. Verbleibende Datenbindungen vor dem Speichern prüfen.'
}
async function save() {
  if (blocked.value || !state.value) return
  await action(async () => {
    await session.mutate('save', {
      name: name.value,
      definition_json: boundedWorkflowJson(draft.value),
      expected_version: state.value!.workflow.version,
    })
    await refresh()
    notice.value = `Version ${state.value!.workflow.version} gespeichert.`
  })
}
async function test(mode: 'definition' | 'simulation') {
  if (!state.value || dirty.value || !caseId.value) return
  await action(async () => {
    await session.mutate('tests', { expected_version: state.value!.workflow.version, mode, test_case_id: caseId.value })
    await refresh(false)
    notice.value = 'Test angefordert. Der Status wird aus den Serverergebnissen gelesen.'
  })
}
async function createCase() {
  await action(async () => {
    const specification = object(caseJson.value)
    if (specification.real_test_authorized === true)
      throw new Error('Echte Testziele werden auf dem ausführenden Gerät freigegeben.')
    await session.mutate('testCases', { name: caseName.value, specification })
    await refresh(false)
    notice.value = 'Testfall gespeichert.'
  })
}
async function proposeRepair() {
  if (!state.value || !failedRunId.value) return
  await action(async () => {
    await session.mutate('repairs', {
      source_run_id: failedRunId.value,
      expected_version: state.value!.workflow.version,
      definition: JSON.parse(boundedWorkflowJson(draft.value)),
    })
    await refresh(false)
    notice.value = 'Reparaturversion angelegt. Tests und Aktivierungsnachweis stehen separat im Verlauf.'
  })
}
async function controlRun(run: WorkflowRun, control: 'stop_after_step' | 'cancel') {
  await action(async () => {
    await session.mutate('runControls', { run_id: run.public_id, action: control })
    await refresh(false)
  })
}
function stopPending(run: WorkflowRun) {
  return readWorkflowRunBudget(run, state.value?.runs ?? []).boundaryStop === 'pending'
}
onMounted(() => {
  void action(() => refresh())
  monitorTimer = setInterval(async () => {
    if (monitoring || busy.value || !state.value?.runs.some(run => !isTerminalWorkflow(run.status))) return
    monitoring = true
    try {
      await refresh(false)
    } catch {
      runsStale.value = true
    } finally {
      monitoring = false
    }
  }, 10000)
})
onBeforeUnmount(() => {
  if (monitorTimer) clearInterval(monitorTimer)
  session.dispose()
})
</script>
<template>
  <section class="workflow-editor-island" aria-label="Gemeinsamer Workflow-Editor" :aria-busy="busy">
    <header>
      <div>
        <h2>{{ state?.workflow.name ?? 'Workflow laden' }}</h2>
        <p v-if="state">Version {{ state.workflow.version }}<span v-if="dirty"> · Entwurf geändert</span></p>
      </div>
      <button type="button" :disabled="busy || dirty" @click="action(() => refresh())">Status aktualisieren</button>
    </header>
    <p v-if="error" role="alert" class="wf-error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="state">
      <nav class="workflow-editor-tabs" aria-label="Workflow-Bereiche">
        <button
          v-for="item in tabs"
          :key="item.key"
          type="button"
          :aria-current="tab === item.key ? 'page' : undefined"
          @click="tab = item.key"
        >
          {{ item.label }}
        </button>
      </nav>
      <div v-if="tab === 'flow'">
        <label>Name<input v-model="name" :disabled="blocked" maxlength="160" /></label>
        <fieldset :disabled="blocked">
          <legend>Denktiefe für KI- und Agentenbausteine</legend>
          <ThinkingSelector
            :model-value="draft.thinking_tier ?? 'balanced'"
            @update:model-value="draft.thinking_tier = $event"
          />
        </fieldset>
        <WorkflowGraphEditor
          v-model="draft"
          :catalog="state.catalog"
          :triggers="state.triggers"
          :disabled="blocked"
          @select="selected = $event"
          @select-source="tab = $event === 'input' ? 'inputs' : 'automation'"
        />
        <div class="workflow-editor-split">
          <div>
            <h3>Schritte</h3>
            <ol>
              <li v-for="step in draft.steps" :key="step.key">
                <button
                  type="button"
                  :aria-current="selected === step.key ? 'step' : undefined"
                  @click="selected = step.key"
                >
                  {{ step.payload.title || step.key }}
                </button>
                <button
                  type="button"
                  :disabled="blocked"
                  :aria-label="`${step.key} entfernen`"
                  @click="removeStep(step.key)"
                >
                  Entfernen
                </button>
              </li>
            </ol>
            <label
              >Baustein<select v-model="task" :disabled="blocked">
                <option
                  v-for="item in state.catalog.filter(item => item.allowed_in_definition)"
                  :key="item.key"
                  :value="item.key"
                >
                  {{ item.label }}
                </option>
              </select></label
            ><button type="button" :disabled="blocked || draft.steps.length >= 100" @click="addStep">
              Schritt hinzufügen
            </button>
          </div>
          <WorkflowStepEditor
            v-if="activeStep"
            :input-schema="draft.input_schema"
            :step="activeStep"
            :steps="draft.steps"
            :catalog="state.catalog"
            :disabled="blocked"
            @update:step="updateStep"
          />
        </div>
      </div>
      <div v-else-if="tab === 'inputs'">
        <WorkflowBudgetSettings v-model="draft" :disabled="blocked" />
        <h3>Eingaben</h3>
        <p>Dieses Schema beschreibt die Eingaben desselben gespeicherten Workflows.</p>
        <label
          >Eingabeschema als JSON<textarea
            v-model="inputSchema"
            :disabled="blocked"
            rows="12"
            spellcheck="false"
          /></label
        ><button
          type="button"
          :disabled="blocked"
          @click="
            action(async () => {
              draft.input_schema = object(inputSchema)
              notice = 'Eingabeschema im Entwurf übernommen.'
            })
          "
        >
          In Entwurf übernehmen
        </button>
      </div>
      <div v-else-if="tab === 'tests'">
        <h3>Gespeicherte Tests</h3>
        <label
          >Testfall<select v-model="caseId">
            <option :value="undefined">Bitte wählen</option>
            <option v-for="item in state.testCases" :key="item.id" :value="item.id">{{ item.name || item.id }}</option>
          </select></label
        >
        <div class="workflow-editor-actions">
          <button type="button" :disabled="busy || dirty || !caseId" @click="test('definition')">
            Definition prüfen</button
          ><button type="button" :disabled="busy || dirty || !caseId" @click="test('simulation')">Simulieren</button>
        </div>
        <p>
          Ein echter Test wird auf dem zugeordneten Gerät mit freigegebenen Testzielen gestartet. Simulationen belegen
          keine Ausführung auf Windows.
        </p>
        <ul>
          <li v-for="item in state.tests" :key="item.id">
            {{ item.mode }} · {{ workflowStatusLabel(item.status ?? 'unbekannt') }}
          </li>
        </ul>
        <details>
          <summary>Testfall hinzufügen</summary>
          <label>Name<input v-model="caseName" maxlength="160" /></label
          ><label>Eingaben, Fixtures und Assertions<textarea v-model="caseJson" rows="8" spellcheck="false" /></label
          ><button type="button" :disabled="busy || !caseName.trim()" @click="createCase">Testfall speichern</button>
        </details>
      </div>
      <div v-else-if="tab === 'automation'">
        <h3>Automatisierung</h3>
        <p>Gerätefreigaben und automatische Reparaturen werden in Luczor auf dem zugeordneten Gerät eingerichtet.</p>
        <ul>
          <li v-for="trigger in state.triggers" :key="trigger.id">
            {{ trigger.name }} · {{ trigger.enabled ? 'Aktiv' : 'Inaktiv' }} · {{ trigger.kind }}
          </li>
        </ul>
        <p v-if="!state.triggers.length">Keine Auslöser vorhanden.</p>
        <details>
          <summary>Gespeicherte Reparaturbefugnis</summary>
          <pre>{{
            state.workflow.definition.meta?.repair_policy ?? state.workflow.repair_policy ?? 'Nicht eingerichtet'
          }}</pre>
        </details>
      </div>
      <div v-else-if="tab === 'runs'">
        <h3>Läufe</h3>
        <ul>
          <li v-for="run in state.runs" :key="run.id">
            <strong>{{ workflowStatusLabel(run.status) }}</strong> · {{ run.sandbox ? 'Simulation' : 'Ausführung' }} ·
            {{ run.public_id }}
            <WorkflowRunBudget :run="run" :known-runs="state.runs" :stale="runsStale" />
            <template v-if="state.urls.runControls && !isTerminalWorkflow(run.status)">
              <button
                type="button"
                :disabled="busy || stopPending(run) || run.status !== 'running'"
                @click="controlRun(run, 'stop_after_step')"
              >
                {{ stopPending(run) ? 'Halt angefordert' : 'Nach diesem Schritt stoppen' }}
              </button>
              <button type="button" :disabled="busy || run.status === 'cancelling'" @click="controlRun(run, 'cancel')">
                Sofortigen Stopp anfordern
              </button>
            </template>
            <details v-if="run.steps?.length">
              <summary>Schritte</summary>
              <ul>
                <li v-for="step in run.steps" :key="step.id">
                  {{ step.step_key }} · {{ workflowStatusLabel(step.status) }}
                  <p v-if="step.error">{{ step.error }}</p>
                </li>
              </ul>
            </details>
          </li>
        </ul>
      </div>
      <div v-else>
        <h3>Versionen und Reparaturen</h3>
        <ul>
          <li v-for="revision in state.workflow.revisions ?? []" :key="revision.id">
            Version {{ revision.version }} · {{ revision.change_summary }}
            <details>
              <summary>Definition ansehen</summary>
              <pre>{{ JSON.stringify(revision.definition, null, 2) }}</pre>
            </details>
          </li>
        </ul>
        <h4>Reparaturversionen</h4>
        <ul>
          <li v-for="repair in state.repairs" :key="repair.id">
            {{ repair.id }} · {{ workflowStatusLabel(repair.status ?? 'unbekannt') }}
          </li>
        </ul>
        <label
          >Fehlgeschlagener Ausgangslauf<select v-model="failedRunId">
            <option :value="undefined">Bitte wählen</option>
            <option v-for="run in state.runs.filter(run => run.status === 'failed')" :key="run.id" :value="run.id">
              {{ run.public_id }}
            </option>
          </select></label
        ><button type="button" :disabled="blocked || !failedRunId" @click="proposeRepair">
          Entwurf als Reparatur vorschlagen
        </button>
      </div>
      <footer>
        <button type="button" :disabled="blocked || !dirty || !name.trim()" @click="save">Neue Version speichern</button
        ><span>Laufende Aufträge behalten ihre gestartete Version.</span>
      </footer>
    </template>
  </section>
</template>
<style scoped>
.workflow-editor-island {
  container-type: inline-size;
  --ai-surface: var(--ui-surface, #20232b);
  --ai-border: var(--ui-border, #3d404b);
  --ai-text: var(--ui-text, #e7e9f0);
  --ai-accent: #ac95ea;
  color: var(--ai-text);
  font:
    14px/1.55 system-ui,
    sans-serif;
}
header,
footer,
.workflow-editor-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
header h2 {
  margin: 0;
  font-size: 22px;
}
h3 {
  font-size: 18px;
  margin: 12px 0;
}
header p,
footer span {
  color: #a9aebc;
  font-size: 12px;
}
.workflow-editor-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 20px 0;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ai-border);
}
:deep(button) {
  min-height: 34px;
  border: 1px solid var(--ai-border);
  border-radius: 6px;
  padding: 6px 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
button[aria-current] {
  background: #ac95ea24;
  border-color: var(--ai-accent);
}
:deep(button:disabled) {
  opacity: 0.45;
  cursor: default;
}
:deep(input),
:deep(textarea),
:deep(select) {
  max-width: 100%;
  display: block;
  width: 100%;
  padding: 8px;
  border: 1px solid var(--ai-border);
  border-radius: 6px;
  background: var(--ai-surface);
  color: inherit;
  font: inherit;
}
:deep(label) {
  display: block;
  margin: 12px 0;
}
:deep(fieldset) {
  border: 1px solid var(--ai-border);
  border-radius: 7px;
  padding: 12px;
  min-width: 0;
}
:deep(:focus-visible) {
  outline: 2px solid var(--ai-accent);
  outline-offset: 3px;
}
.workflow-editor-split {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr);
  gap: 18px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 400px;
  overflow-y: auto;
  font-size: 12px;
}
footer {
  justify-content: flex-start;
  border-top: 1px solid var(--ai-border);
  margin-top: 22px;
  padding-top: 15px;
}
.wf-error {
  color: #f5a5a5;
}
@media (max-width: 700px) {
  .workflow-editor-split {
    grid-template-columns: 1fr;
  }
}
@container (max-width: 700px) {
  .workflow-editor-split {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
