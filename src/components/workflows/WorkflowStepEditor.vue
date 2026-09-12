<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorkflowStepDefinition, WorkflowTask } from '@/services/workflows/types'
import { boundedWorkflowJson } from '@/services/workflows/operations'
import { THINKING_TIERS, THINKING_DEFAULTS } from '@/services/inference/thinking'
import { WORKFLOW_SCRIPT_TEMPLATES } from '@/services/workflows/scriptTemplates'
import { workflowBindingSource } from '@/services/workflows/bindings'
import { connectWorkflowData } from '@/services/workflows/graph'
import { validateWorkflowScriptEnvironment } from '@/services/workflows/scriptEnvironment'
import WorkflowDeviceTargetEditor from './WorkflowDeviceTargetEditor.vue'
const props = defineProps<{
  step: WorkflowStepDefinition
  steps: WorkflowStepDefinition[]
  catalog: WorkflowTask[]
  disabled: boolean
  workspaceRoot?: string
  inputSchema?: Record<string, unknown>
}>()
const emit = defineEmits<{ 'update:step': [step: WorkflowStepDefinition] }>()
const task = computed(() => props.catalog.find(item => item.key === props.step.type))
const payloadText = ref('')
const payloadError = ref('')
const bindingField = ref('')
const bindingSource = ref('')
const environmentText = ref('{}')
watch(
  () => props.step,
  step => {
    payloadText.value = JSON.stringify(step.payload, null, 2)
    payloadError.value = ''
    environmentText.value = JSON.stringify(step.payload.environment ?? {}, null, 2)
  },
  { immediate: true }
)
const bindings = computed(() => (props.step.payload.input_bindings ?? {}) as Record<string, string>)
const outcomes = computed(() =>
  props.step.type === 'condition' ? ['true', 'false', 'failed'] : ['success', 'failed', 'partial', 'timeout', 'default']
)
const outcomeLabels: Record<string, string> = {
  true: 'Bedingung erfüllt',
  false: 'Bedingung nicht erfüllt',
  success: 'Erfolgreich',
  failed: 'Fehler',
  partial: 'Teilergebnis',
  timeout: 'Zeitüberschreitung',
  default: 'Sonst',
}
const params = computed(() =>
  Object.entries({
    ...Object.fromEntries(
      Object.entries((task.value?.input_schema?.properties ?? {}) as Record<string, Record<string, unknown>>).map(
        ([key, field]) => [
          key,
          {
            type: typeof field.type === 'string' ? field.type : 'json',
            default: field.default,
            required: (task.value?.input_schema?.required as string[] | undefined)?.includes(key),
            enum: field.enum as string[] | undefined,
            min: field.minimum as number | undefined,
            max: field.maximum as number | undefined,
          },
        ]
      )
    ),
    ...task.value?.params,
  }).filter(
    ([key]) =>
      ![
        'input_bindings',
        'routes',
        'file_scope',
        'workspace_root_id',
        'inference',
        'output_format',
        'thinking_tier',
        'thinking_config',
        'environment',
      ].includes(key)
  )
)
function applyScriptTemplate() {
  const runtime = props.step.type === 'python.run' ? 'python' : 'node'
  const template = runtime === 'python' ? WORKFLOW_SCRIPT_TEMPLATES.python : WORKFLOW_SCRIPT_TEMPLATES.node
  update({
    payload: {
      ...props.step.payload,
      code: template.code,
      input: props.step.payload.input ?? { text: '' },
      output_schema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' } },
        additionalProperties: false,
      },
      execution_environment: 'windows_user',
      template: { id: template.id, version: template.version, dependencies: template.dependencies },
    },
  })
}
function applyEnvironment() {
  try {
    const value: unknown = JSON.parse(environmentText.value)
    const empty = value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length
    if (empty) {
      const next = { ...props.step.payload }
      delete next.environment
      update({ payload: next })
    } else
      payload(
        'environment',
        validateWorkflowScriptEnvironment(props.step.type === 'python.run' ? 'python' : 'node', value)
      )
    payloadError.value = ''
  } catch (error) {
    payloadError.value = error instanceof Error ? error.message : 'Skriptumgebung prüfen.'
  }
}
function update(values: Partial<WorkflowStepDefinition>) {
  const next = { ...props.step, ...values }
  if (values.type && props.catalog.find(item => item.key === values.type)?.runner !== 'client')
    delete next.device_target
  emit('update:step', next)
}
function payload(key: string, value: unknown) {
  update({ payload: { ...props.step.payload, [key]: value } })
}
function selectFileScope(scope: string) {
  const next = { ...props.step.payload, file_scope: scope }
  if (scope === 'workspace') {
    if (!props.workspaceRoot) return
    Reflect.set(next, 'workspace_root_id', props.workspaceRoot)
  } else Reflect.deleteProperty(next, 'workspace_root_id')
  update({ payload: next })
}
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
}
function structuredParameter(key: string, value: string, type: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    boundedWorkflowJson(parsed)
    if (type === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Das Parameterformat stimmt nicht.')
    payload(key, parsed)
    payloadError.value = ''
  } catch (error) {
    payloadError.value = error instanceof Error ? error.message : 'Ungültiger JSON-Parameter.'
  }
}
function dependency(key: string, selected: boolean) {
  update({
    depends_on: selected
      ? [...new Set([...(props.step.depends_on ?? []), key])]
      : (props.step.depends_on ?? []).filter(item => item !== key),
  })
}
function routeSelection(outcome: string): string {
  const route = props.step.routes ? Reflect.get(props.step.routes, outcome) : undefined
  return route ? (route.type === 'step' ? `step:${route.step_key}` : route.type) : ''
}
function setRoute(outcome: string, target: string) {
  const routes = { ...props.step.routes }
  if (!target) Reflect.deleteProperty(routes, outcome)
  else
    Reflect.set(
      routes,
      outcome,
      target.startsWith('step:')
        ? { type: 'step', step_key: target.slice(5), max_iterations: 2 }
        : { type: target as 'end' | 'fail' }
    )
  update({ routes })
}
function addBinding() {
  if (!bindingField.value.trim() || !bindingSource.value.trim()) return
  try {
    const definition = { steps: props.steps, input_schema: props.inputSchema }
    const source = workflowBindingSource(definition, bindingSource.value.trim())
    if (!source) throw new Error('Die Datenquelle ist ungültig oder fehlt im Workflow.')
    const next = connectWorkflowData(
      definition,
      props.catalog,
      source.id,
      source.path,
      props.step.key,
      bindingField.value.trim()
    )
    update(next.steps.find(step => step.key === props.step.key)!)
    bindingField.value = ''
    bindingSource.value = ''
    payloadError.value = ''
  } catch (error) {
    payloadError.value = error instanceof Error ? error.message : 'Datenverbindung prüfen.'
  }
}
function removeBinding(key: string) {
  const next = { ...bindings.value }
  Reflect.deleteProperty(next, key)
  payload('input_bindings', next)
}
function applyPayload() {
  try {
    const value: unknown = JSON.parse(payloadText.value)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Die Parameter müssen ein JSON-Objekt sein.')
    boundedWorkflowJson(value)
    update({ payload: value as Record<string, unknown> })
    payloadError.value = ''
  } catch (error) {
    payloadError.value = error instanceof Error ? error.message : 'Ungültige Parameter.'
  }
}
</script>
<template>
  <fieldset class="wf-step-editor" :disabled="disabled">
    <legend>Schritt bearbeiten</legend>
    <div class="wf-grid-two">
      <label
        >Name<input
          :value="stringValue(step.payload.title)"
          maxlength="160"
          @input="payload('title', ($event.target as HTMLInputElement).value)"
      /></label>
      <label
        >Schlüssel<input
          :value="step.key"
          maxlength="120"
          @change="update({ key: ($event.target as HTMLInputElement).value.trim() })"
      /></label>
    </div>
    <label
      >Aufgabe<select :value="step.type" @change="update({ type: ($event.target as HTMLSelectElement).value })">
        <option v-for="item in catalog" :key="item.key" :value="item.key">{{ item.label }}</option>
      </select></label
    >
    <p class="wf-muted">
      {{ task?.runner === 'client' ? 'Auf dem zugeordneten Gerät' : 'Auf dem Server'
      }}<span v-if="task?.requires_approval"> · Freigabe erforderlich</span>
    </p>
    <WorkflowDeviceTargetEditor
      v-if="task?.runner === 'client'"
      :model-value="step.device_target"
      :catalog="catalog"
      :disabled="disabled"
      @update:model-value="update({ device_target: $event })"
    />
    <div v-if="['node.run', 'python.run'].includes(step.type)" class="wf-muted">
      <p>Windows · Benutzerrechte · JSON-Eingabe über Standardeingabe, JSON-Ergebnis über Standardausgabe.</p>
      <button type="button" @click="applyScriptTemplate">JSON-Vorlage v1 übernehmen</button>
      <p v-if="step.payload.template">Eigener Code und Skriptumgebung bleiben Bestandteil dieser Workflow-Version.</p>
      <details>
        <summary>Runtime und Projektpakete</summary>
        <p>
          Feste Runtimeversion, Paketversionen und Lockdatei festlegen. Die geprüfte Umgebung wird im Projekt
          eingerichtet und für weitere Läufe wiederverwendet. Runtime-Programme müssen bereits installiert sein.
        </p>
        <label>Umgebung als JSON<textarea v-model="environmentText" rows="8" spellcheck="false" /></label>
        <p>
          Beispiel: <code>{"version":1,"runtime_version":"22.22.0","dependencies":[]}</code>. Für Pakete zusätzlich
          <code>lock_path</code> und <code>lock_sha256</code> sowie
          <code>dependencies: [{"name":"…","version":"1.0.0"}]</code> angeben.
        </p>
        <p>
          Node: package-lock.json Version 3. Python: requirements.lock mit festen Versionen und SHA-256-Hashes
          einschließlich Unterabhängigkeiten. Pakete werden aus npm beziehungsweise PyPI geladen.
          <code>{}</code> verwendet wieder die installierte Runtime ohne eigene Paketumgebung.
        </p>
        <button type="button" @click="applyEnvironment">Skriptumgebung übernehmen</button>
      </details>
    </div>
    <label v-if="step.type === 'llm' || step.type.startsWith('llm.') || step.type.startsWith('agent.')"
      >Denktiefe
      <select
        :value="step.payload.thinking_tier ?? 'inherit'"
        @change="payload('thinking_tier', ($event.target as HTMLSelectElement).value)"
      >
        <option value="inherit">Vom Workflow übernehmen</option>
        <option v-for="tier in THINKING_TIERS" :key="tier" :value="tier">{{ THINKING_DEFAULTS[tier].label }}</option>
      </select>
    </label>
    <template v-for="[key, param] in params" :key="key">
      <label
        >{{ key }}
        <select
          v-if="param.enum?.length"
          :value="stringValue(step.payload[key] ?? param.default)"
          @change="payload(key, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="value in param.enum" :key="value" :value="value">{{ value }}</option>
        </select>
        <textarea
          v-else-if="['object', 'array', 'json'].includes(param.type)"
          :value="stringValue(step.payload[key] ?? param.default ?? (param.type === 'array' ? [] : {}))"
          rows="5"
          spellcheck="false"
          @change="structuredParameter(key, ($event.target as HTMLTextAreaElement).value, param.type)"
        />
        <textarea
          v-else-if="param.type === 'textarea' || key === 'code' || key === 'instruction'"
          :value="stringValue(step.payload[key])"
          :rows="key === 'code' ? 10 : 4"
          :spellcheck="key === 'code' ? false : undefined"
          @input="payload(key, ($event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else-if="param.type === 'number' || param.type === 'integer'"
          type="number"
          :min="param.min"
          :max="param.max"
          :value="Number(step.payload[key] ?? param.default ?? 0)"
          @input="payload(key, Number(($event.target as HTMLInputElement).value))"
        />
        <input
          v-else-if="param.type === 'boolean'"
          type="checkbox"
          :checked="step.payload[key] === true"
          @change="payload(key, ($event.target as HTMLInputElement).checked)"
        />
        <input
          v-else
          :value="stringValue(step.payload[key] ?? param.default)"
          @input="payload(key, ($event.target as HTMLInputElement).value)"
        />
      </label>
    </template>
    <p v-if="payloadError" role="alert" class="wf-error">{{ payloadError }}</p>
    <label v-if="['file.read', 'file.write'].includes(step.type)"
      >Dateibereich<select
        :value="step.payload.file_scope ?? 'workflow'"
        @change="selectFileScope(($event.target as HTMLSelectElement).value)"
      >
        <option value="workflow">Workflow-Dateibereich</option>
        <option value="workspace" :disabled="!workspaceRoot">Gebundener Projektordner</option>
      </select></label
    >
    <div
      v-if="['file.read', 'file.write'].includes(step.type) && step.payload.file_scope === 'workspace'"
      class="wf-muted"
    >
      <p>{{ step.payload.workspace_root_id || 'Noch kein Ordner zugeordnet.' }}</p>
      <button
        v-if="workspaceRoot && step.payload.workspace_root_id !== workspaceRoot"
        type="button"
        @click="selectFileScope('workspace')"
      >
        Aktuellen Projektordner übernehmen
      </button>
    </div>
    <template v-if="step.type === 'llm'">
      <label v-if="!params.some(([key]) => key === 'instruction')"
        >KI-Auftrag<textarea
          :value="stringValue(step.payload.instruction)"
          rows="5"
          @input="payload('instruction', ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <label
        >Ergebnisformat<select
          :value="step.payload.output_format ?? 'text'"
          @change="payload('output_format', ($event.target as HTMLSelectElement).value)"
        >
          <option value="text">Text</option>
          <option value="json">Strukturiertes JSON</option>
        </select></label
      >
    </template>
    <label v-if="step.type === 'llm' || step.type.startsWith('llm.')"
      >Modellverarbeitung<select
        :value="step.payload.inference ?? 'local'"
        @change="payload('inference', ($event.target as HTMLSelectElement).value)"
      >
        <option value="local">Lokal auf diesem Gerät</option>
        <option value="external">Extern mit Freigabe des Anfrageinhalts</option>
      </select></label
    >
    <fieldset class="wf-options">
      <legend>Beginnt nach</legend>
      <label v-for="other in steps.filter(item => item.key !== step.key)" :key="other.key" class="wf-check"
        ><input
          type="checkbox"
          :checked="step.depends_on?.includes(other.key)"
          @change="dependency(other.key, ($event.target as HTMLInputElement).checked)"
        />{{ other.payload.title || other.key }}</label
      >
      <p v-if="steps.length < 2" class="wf-muted">Noch keine Vorgänger vorhanden.</p>
    </fieldset>
    <fieldset class="wf-options">
      <legend>Ergebnisse weitergeben</legend>
      <div v-for="(source, key) in bindings" :key="key" class="wf-binding">
        <code>{{ key }} ← {{ source }}</code
        ><button type="button" :aria-label="`Bindung ${key} entfernen`" @click="removeBinding(String(key))">
          Entfernen
        </button>
      </div>
      <div class="wf-grid-two">
        <label>Zielfeld<input v-model="bindingField" placeholder="instruction" /></label
        ><label>Quelle<input v-model="bindingSource" placeholder="steps.auswertung.text" /></label>
      </div>
      <button type="button" @click="addBinding">Bindung hinzufügen</button>
      <p class="wf-muted">Quellen: input…, event… und steps.Schlüssel…. Pflichtwerte werden vor Ausführung geprüft.</p>
    </fieldset>
    <fieldset class="wf-options">
      <legend>Weiter bei Ergebnis</legend>
      <label v-for="outcome in outcomes" :key="outcome"
        >{{ outcomeLabels[outcome] }}
        <select
          :value="routeSelection(outcome)"
          @change="setRoute(outcome, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">Abhängigkeiten folgen</option>
          <option value="end">Workflow abschließen</option>
          <option value="fail">Workflow als fehlgeschlagen beenden</option>
          <option v-for="other in steps" :key="other.key" :value="`step:${other.key}`">
            {{ other.payload.title || other.key }}
          </option>
        </select>
        <span v-if="step.routes?.[outcome]?.type === 'step'"
          >Maximale Wiederholungen
          <input
            type="number"
            min="1"
            max="50"
            :value="step.routes[outcome]?.max_iterations ?? 2"
            @input="
              update({
                routes: {
                  ...step.routes,
                  [outcome]: {
                    ...step.routes[outcome]!,
                    max_iterations: Number(($event.target as HTMLInputElement).value),
                  },
                },
              })
            "
        /></span>
      </label>
    </fieldset>
    <label class="wf-check"
      ><input
        type="checkbox"
        :checked="step.requires_approval || task?.requires_approval"
        :disabled="task?.requires_approval"
        @change="update({ requires_approval: ($event.target as HTMLInputElement).checked })"
      />Vor diesem Schritt bestätigen</label
    >
    <details>
      <summary>Weitere Parameter</summary>
      <label>Parameter als JSON<textarea v-model="payloadText" rows="9" spellcheck="false" /></label
      ><button type="button" @click="applyPayload">Parameter übernehmen</button>
      <p v-if="payloadError" role="alert" class="wf-error">{{ payloadError }}</p>
    </details>
  </fieldset>
</template>
