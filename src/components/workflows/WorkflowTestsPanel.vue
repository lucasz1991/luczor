<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  createWorkflowTests,
  workflowTestModeLabel,
  workflowTestResultLabel,
  type WorkflowTestMode,
  type WorkflowTestState,
} from '@/services/workflows/workflowTests'
import { boundedWorkflowJson } from '@/services/workflows/operations'
import type { Workflow, WorkflowDefinition, WorkflowRun } from '@/services/workflows/types'

const props = defineProps<{
  workflow: Workflow
  projectId: string
  disabled: boolean
  dirty: boolean
  runs: WorkflowRun[]
}>()
const emit = defineEmits<{ changed: []; run: [id: string] }>()
const state = ref<WorkflowTestState>()
const busy = ref(false)
const error = ref('')
const notice = ref('')
const caseName = ref('')
const specification = ref('{\n  "input": {},\n  "fixtures": {},\n  "assertions": []\n}')
const authorizeReal = ref(false)
const selectedCase = ref<number>()
const selectedRepair = ref<number>()
const policyEnabled = ref(false)
const autoActivate = ref(true)
const allowScriptRepair = ref(false)
const maxRepairs = ref(2)
const sourceRun = ref<number>()
const candidate = ref('')
let abort = new AbortController()
let generation = 0
const blocked = computed(() => props.disabled || props.dirty || busy.value)
const chosenCase = computed(() => state.value?.cases.find(item => item.id === selectedCase.value))
const realAvailable = computed(
  () =>
    chosenCase.value?.specification.real_test_authorized === true &&
    chosenCase.value.specification.device_id === state.value?.deviceId
)
const failedRuns = computed(() =>
  props.runs.filter(
    run => ['failed', 'cancelled'].includes(run.status) && run.definition_version === props.workflow.version
  )
)
const pendingRepairs = computed(() => state.value?.repairs.filter(repair => repair.status === 'proposed') ?? [])
function object(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Bitte ein JSON-Objekt eingeben.')
  boundedWorkflowJson(parsed)
  return parsed as Record<string, unknown>
}
function current(ticket: number) {
  if (ticket !== generation || abort.signal.aborted) throw new DOMException('Workflow-Ansicht geändert.', 'AbortError')
}
async function refresh(api: ReturnType<typeof createWorkflowTests>, ticket: number, refreshRunning = false) {
  const next = await api.load(props.workflow.id)
  current(ticket)
  if (refreshRunning) {
    next.tests = await Promise.all(
      next.tests.map(test => (test.status === 'running' ? api.refresh(props.workflow.id, test.id) : test))
    )
    current(ticket)
  }
  state.value = next
  if (!next.cases.some(item => item.id === selectedCase.value)) selectedCase.value = next.cases[0]?.id
  if (!next.repairs.some(item => item.id === selectedRepair.value && item.status === 'proposed'))
    selectedRepair.value = undefined
}
async function action(
  operation: (api: ReturnType<typeof createWorkflowTests>, ticket: number) => Promise<void>,
  mutating = true
) {
  if (busy.value || (mutating && blocked.value)) return
  const ticket = generation
  const api = createWorkflowTests(props.projectId, abort.signal)
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await operation(api, ticket)
    current(ticket)
  } catch (failure) {
    if (ticket === generation)
      error.value = failure instanceof Error ? failure.message : 'Workflow-Testaktion fehlgeschlagen.'
  } finally {
    if (ticket === generation) busy.value = false
  }
}
const reload = () => action((api, ticket) => refresh(api, ticket, true), false)
async function saveCase() {
  await action(async (api, ticket) => {
    const created = await api.createCase(
      props.workflow.id,
      caseName.value,
      object(specification.value),
      authorizeReal.value
    )
    current(ticket)
    selectedCase.value = created.id
    await refresh(api, ticket)
    notice.value = 'Testfall mit unveränderlichen Prüfregeln gespeichert. Es wurde noch kein Test ausgeführt.'
  })
}
async function start(mode: WorkflowTestMode) {
  if (!selectedCase.value) return
  const caseId = selectedCase.value
  await action(async (api, ticket) => {
    const result = await api.start(props.workflow.id, props.workflow.version, caseId, mode, selectedRepair.value)
    current(ticket)
    await refresh(api, ticket)
    notice.value = `${workflowTestModeLabel(mode)}: ${workflowTestResultLabel(result)}.`
  })
}
async function savePolicy() {
  if (!selectedCase.value) return
  const caseId = selectedCase.value
  await action(async (api, ticket) => {
    await api.configureRepair(props.workflow.id, props.workflow.version, {
      testCaseId: caseId,
      enabled: policyEnabled.value,
      autoActivate: autoActivate.value,
      allowScriptRepair: allowScriptRepair.value,
      maxRepairs: maxRepairs.value,
    })
    current(ticket)
    await refresh(api, ticket)
    notice.value = policyEnabled.value
      ? 'Begrenzte Reparaturfreigabe für dieses Gerät gespeichert.'
      : 'Automatische Reparaturen deaktiviert.'
    emit('changed')
  })
}
async function propose() {
  if (!sourceRun.value) return
  const runId = sourceRun.value
  await action(async (api, ticket) => {
    const definition = object(candidate.value)
    if (!Array.isArray(definition.steps)) throw new Error('Der Reparaturentwurf braucht eine Schrittliste.')
    const repair = await api.propose(
      props.workflow.id,
      props.workflow.version,
      runId,
      definition as unknown as WorkflowDefinition
    )
    current(ticket)
    selectedRepair.value = repair.id
    await refresh(api, ticket)
    notice.value = 'Reparaturentwurf gespeichert. Tests und Aktivierung stehen noch aus.'
  })
}
async function activate(id: number) {
  await action(async (api, ticket) => {
    await api.activate(props.workflow.id, id)
    current(ticket)
    await refresh(api, ticket)
    notice.value = 'Der Server hat die geprüfte Reparatur für künftige Läufe aktiviert.'
    emit('changed')
  })
}
function reset() {
  abort.abort()
  abort = new AbortController()
  generation++
  busy.value = false
  state.value = undefined
  error.value = ''
  notice.value = ''
  caseName.value = ''
  specification.value = '{\n  "input": {},\n  "fixtures": {},\n  "assertions": []\n}'
  authorizeReal.value = false
  selectedCase.value = undefined
  selectedRepair.value = undefined
  sourceRun.value = undefined
  candidate.value = JSON.stringify(props.workflow.definition, null, 2)
}
watch(
  () => [props.projectId, props.workflow.id, props.workflow.version] as const,
  () => {
    reset()
    const policy = props.workflow.repair_policy
    policyEnabled.value = policy?.enabled === true
    autoActivate.value = policy?.auto_activate !== false
    allowScriptRepair.value = policy?.allow_script_repair === true
    maxRepairs.value = typeof policy?.max_repairs === 'number' ? policy.max_repairs : 2
    void reload()
  },
  { immediate: true }
)
const identityChanged = () => reset()
if (typeof window !== 'undefined') window.addEventListener('luczor:api-identity-changing', identityChanged)
const poll = setInterval(() => {
  if (!busy.value && state.value?.tests.some(test => test.status === 'running')) void reload()
}, 5000)
onBeforeUnmount(() => {
  abort.abort()
  generation++
  if (poll) clearInterval(poll)
  window.removeEventListener('luczor:api-identity-changing', identityChanged)
})
</script>
<template>
  <div class="wf-tests">
    <div class="wf-section-heading">
      <h4>Tests und Nachweise</h4>
      <button type="button" :disabled="busy" @click="reload">Aktualisieren</button>
    </div>
    <p class="wf-muted">
      Prüfregeln und Beispieldaten werden zusammen gespeichert. Eine Simulation bestätigt keine echte Geräteausführung.
    </p>
    <p v-if="dirty" role="status" class="wf-notice">
      Bitte den Entwurf speichern. Tests beziehen sich auf die gespeicherte Version.
    </p>
    <p v-if="error" role="alert" class="wf-error">{{ error }}</p>
    <p v-if="notice" role="status" class="wf-notice">{{ notice }}</p>
    <p v-if="busy" role="status" class="wf-muted">Testdaten werden verarbeitet…</p>
    <details class="wf-test-card">
      <summary>Neuen Testfall anlegen</summary>
      <label>Name<input v-model="caseName" maxlength="160" :disabled="blocked" /></label>
      <label
        >Testdaten und Prüfregeln (JSON)<textarea
          v-model="specification"
          rows="10"
          spellcheck="false"
          :disabled="blocked"
        />
      </label>
      <p class="wf-muted">
        input enthält Starteingaben, fixtures die simulierten Ergebnisse je Schritt-ID. assertions braucht mindestens
        eine echte Prüfregel mit step_key, path, operator und value. Gespeicherte Regeln werden durch Reparaturen nicht
        verändert.
      </p>
      <label class="wf-check"
        ><input v-model="authorizeReal" type="checkbox" :disabled="blocked" />Testfall auch für echte Tests auf diesem
        Gerät freigeben</label
      >
      <button type="button" :disabled="blocked || !caseName.trim()" @click="saveCase">
        Testfall prüfen und speichern
      </button>
    </details>
    <section v-if="state?.cases.length" class="wf-test-card">
      <label
        >Gespeicherter Testfall<select v-model="selectedCase" :disabled="busy">
          <option v-for="item in state.cases" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select></label
      >
      <details v-if="chosenCase">
        <summary>Unveränderliche Testdaten ansehen</summary>
        <pre>{{ JSON.stringify(chosenCase.specification, null, 2) }}</pre>
      </details>
      <label
        >Zu prüfende Fassung<select v-model="selectedRepair" :disabled="busy">
          <option :value="undefined">Aktuelle Version {{ workflow.version }}</option>
          <option v-for="repair in pendingRepairs" :key="repair.id" :value="repair.id">
            Reparaturentwurf {{ repair.id }}
          </option>
        </select></label
      >
      <div class="wf-actions">
        <button type="button" :disabled="blocked" @click="start('definition')">Definition prüfen</button>
        <button type="button" :disabled="blocked" @click="start('simulation')">Simulation ausführen</button>
        <button type="button" :disabled="blocked || !realAvailable" @click="start('real')">
          Echten Test freigeben…
        </button>
      </div>
      <p class="wf-muted">
        {{
          realAvailable
            ? 'Echte Tests sind an dieses Gerät gebunden. Zugriffe und Effekte behalten ihre lokalen Freigaben.'
            : 'Für echte Tests ist ein ausdrücklich für dieses Gerät freigegebener Testfall erforderlich.'
        }}
      </p>
    </section>
    <p v-else-if="!busy" class="wf-muted">Noch keine gespeicherten Testfälle.</p>
    <article v-for="test in state?.tests ?? []" :key="test.id" class="wf-test-card">
      <div class="wf-section-heading">
        <strong>{{ workflowTestModeLabel(test.mode) }} · #{{ test.id }}</strong
        ><span>{{ workflowTestResultLabel(test) }}</span>
      </div>
      <p class="wf-muted">
        Testfall {{ test.workflow_test_case_id
        }}<span v-if="test.repair_revision_id"> · Reparatur {{ test.repair_revision_id }}</span
        ><span v-if="test.definition_version"> · Version {{ test.definition_version }}</span>
      </p>
      <details>
        <summary>Nachweis und Prüfergebnis</summary>
        <dl>
          <dt>Definition</dt>
          <dd>{{ test.definition_hash }}</dd>
          <dt>Prüfregeln</dt>
          <dd>{{ test.assertions_hash }}</dd>
          <dt>Testdaten</dt>
          <dd>{{ test.fixture_hash }}</dd>
          <dt>Umgebung</dt>
          <dd>{{ test.environment_hash }}</dd>
        </dl>
        <pre v-if="test.result">{{ JSON.stringify(test.result, null, 2) }}</pre>
        <p v-else class="wf-muted">Noch kein abschließendes Prüfergebnis.</p>
      </details>
      <button v-if="test.run_public_id" type="button" :disabled="busy" @click="emit('run', test.run_public_id)">
        Lauf ansehen
      </button>
    </article>
    <details class="wf-test-card">
      <summary>Automatische Reparaturen</summary>
      <p class="wf-muted">
        Neue Revisionen werden mit denselben Prüfregeln getestet. Automatische Aktivierung braucht echte Testevidenz und
        bleibt innerhalb der Gerätefreigabe, Rechte und Kosten. Höchstens zwei Versuche.
      </p>
      <p role="status">
        {{ state?.workflow.repair_policy?.enabled === true ? 'Serverpolicy aktiv' : 'Serverpolicy nicht aktiv' }}
      </p>
      <label class="wf-check"
        ><input v-model="policyEnabled" type="checkbox" :disabled="blocked" />Begrenzte Reparaturen zulassen</label
      >
      <label class="wf-check"
        ><input v-model="autoActivate" type="checkbox" :disabled="blocked" />Nach bestandenem echten Test für künftige
        Läufe aktivieren</label
      >
      <label class="wf-check"
        ><input v-model="allowScriptRepair" type="checkbox" :disabled="blocked" />Skriptreparaturen innerhalb der
        bestehenden Freigabe zulassen</label
      >
      <label
        >Maximale Reparaturversuche<input
          v-model.number="maxRepairs"
          type="number"
          min="0"
          max="2"
          step="1"
          :disabled="blocked"
      /></label>
      <button type="button" :disabled="blocked || !realAvailable" @click="savePolicy">
        Gerätefreigabe prüfen und speichern…
      </button>
      <details v-if="state?.workflow.repair_policy">
        <summary>Gespeicherte Grenzen</summary>
        <pre>{{ JSON.stringify(state.workflow.repair_policy, null, 2) }}</pre>
      </details>
    </details>
    <details class="wf-test-card">
      <summary>Reparaturentwurf aus einem fehlgeschlagenen Lauf</summary>
      <label
        >Ausgangslauf<select v-model="sourceRun" :disabled="blocked">
          <option :value="undefined">Lauf auswählen</option>
          <option v-for="run in failedRuns" :key="run.id" :value="run.id">#{{ run.id }} · {{ run.status }}</option>
        </select></label
      >
      <label
        >Neue Ablaufdefinition (JSON)<textarea v-model="candidate" rows="10" spellcheck="false" :disabled="blocked" />
      </label>
      <button type="button" :disabled="blocked || !sourceRun" @click="propose">
        Reparaturentwurf prüfen und speichern
      </button>
    </details>
    <article v-for="repair in state?.repairs ?? []" :key="repair.id" class="wf-test-card">
      <div class="wf-section-heading">
        <strong>Reparatur {{ repair.id }}</strong
        ><span>{{ repair.status }}</span>
      </div>
      <button v-if="repair.status === 'proposed'" type="button" :disabled="blocked" @click="activate(repair.id)">
        Testnachweise prüfen und aktivieren…
      </button>
    </article>
  </div>
</template>
<style scoped>
.wf-tests {
  display: grid;
  gap: 14px;
}
.wf-test-card {
  border: 1px solid var(--ai-border, #343741);
  border-radius: 10px;
  padding: 14px;
}
.wf-test-card summary {
  cursor: pointer;
  font-weight: 600;
}
.wf-test-card label {
  margin-top: 12px;
}
.wf-test-card button {
  margin-top: 10px;
}
.wf-test-card pre,
.wf-test-card dd {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.wf-test-card dd {
  margin: 0 0 10px;
  font-size: 0.8rem;
  color: var(--ai-text-muted, #9ba1b2);
}
</style>
