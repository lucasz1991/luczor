<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { WORKFLOW_TRIGGER_KINDS, type WorkflowTrigger, type WorkflowTriggerKind } from '@/services/workflows/types'
import { workflowTimeToUtc, workflowZonedTime } from '@/services/workflows/timezone'
import { preserveWorkflowTriggerScope } from '@/services/workflows/triggerEditing'
const props = defineProps<{
  trigger?: WorkflowTrigger
  disabled: boolean
  deviceId: string
  rootPath: string
  repositories: Array<{ id: number; full_name: string }>
  workflows: Array<{ id: number; name: string }>
}>()
const emit = defineEmits<{ save: [input: Record<string, unknown>] }>()
type TriggerLabelMap = Record<WorkflowTriggerKind, string>
const labels: TriggerLabelMap = {
  schedule: 'Zeitplan',
  webhook: 'Externer Webhook',
  'task.completed': 'Aufgabe abgeschlossen',
  'workflow.completed': 'Workflow beendet',
  'github.push': 'GitHub Push',
  'github.pull_request': 'GitHub Pull Request',
  'workspace.file_changed': 'Dateien geändert',
}
const form = reactive({
  name: '',
  kind: 'schedule' as WorkflowTriggerKind,
  enabled: false,
  timing: 'daily',
  time: '09:00',
  cron: '0 9 * * *',
  runAt: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
  repositoryId: 0,
  branch: '',
  actions: 'opened,synchronize,reopened',
  sourceWorkflowId: 0,
  paths: '**/*.md',
  excludes: '.git/**\nnode_modules/**\n.env*',
  input: '{}',
  error: '',
})
watch(
  () => props.trigger,
  trigger => {
    form.name = trigger?.name ?? ''
    form.kind = trigger?.kind ?? 'schedule'
    form.enabled = trigger?.enabled ?? false
    form.error = ''
    const config = trigger?.config ?? {}
    form.timing = config.run_at ? 'once' : config.cron ? 'cron' : 'daily'
    form.cron = String(config.cron ?? '0 9 * * *')
    form.timezone = String(config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Europe/Berlin')
    form.runAt = config.run_at ? workflowZonedTime(String(config.run_at), form.timezone) : ''
    form.repositoryId = Number(config.repository_id ?? 0)
    form.branch = String(config.branch ?? '')
    form.actions = Array.isArray(config.actions) ? config.actions.join(',') : 'opened,synchronize,reopened'
    form.sourceWorkflowId = Number(config.workflow_definition_id ?? 0)
    form.paths = Array.isArray(config.paths) ? config.paths.join('\n') : '**/*.md'
    form.excludes = Array.isArray(config.excludes) ? config.excludes.join('\n') : '.git/**\nnode_modules/**\n.env*'
    form.input = JSON.stringify(trigger?.input ?? {}, null, 2)
  },
  { immediate: true }
)
const existingFileBinding = computed(() =>
  props.trigger?.kind === 'workspace.file_changed' && form.kind === props.trigger.kind ? props.trigger.config : null
)
const fileRoot = computed(() => existingFileBinding.value?.root_path ?? props.rootPath)
const canSave = computed(
  () => !props.disabled && form.name.trim() && (form.kind !== 'workspace.file_changed' || !!fileRoot.value)
)
function save() {
  try {
    const input: unknown = JSON.parse(form.input)
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Eingaben müssen ein JSON-Objekt sein.')
    let config: Record<string, unknown> = { ...props.trigger?.config }
    if (form.kind === 'schedule') {
      const [hour, minute] = form.time.split(':').map(Number)
      config =
        form.timing === 'once'
          ? { run_at: workflowTimeToUtc(form.runAt, form.timezone), timezone: form.timezone }
          : { cron: form.timing === 'daily' ? `${minute} ${hour} * * *` : form.cron, timezone: form.timezone }
    } else if (form.kind.startsWith('github.')) {
      if (!form.repositoryId) throw new Error('Ein verbundenes Repository auswählen.')
      config = {
        repository_id: form.repositoryId,
        ...(form.branch.trim() ? { branch: form.branch.trim() } : {}),
        ...(form.kind === 'github.pull_request'
          ? {
              actions: form.actions
                .split(',')
                .map(item => item.trim())
                .filter(Boolean),
            }
          : {}),
      }
    } else if (form.kind === 'workflow.completed')
      config = {
        ...(form.sourceWorkflowId ? { workflow_definition_id: form.sourceWorkflowId } : {}),
        ...(props.trigger?.kind === 'workflow.completed'
          ? Object.hasOwn(props.trigger.config, 'statuses')
            ? { statuses: props.trigger.config.statuses }
            : {}
          : { statuses: ['completed', 'failed'] }),
      }
    else if (form.kind === 'workspace.file_changed')
      config = {
        device_id: existingFileBinding.value?.device_id ?? props.deviceId,
        root_path: fileRoot.value,
        paths: form.paths
          .split('\n')
          .map(item => item.trim())
          .filter(Boolean),
        excludes: form.excludes
          .split('\n')
          .map(item => item.trim())
          .filter(Boolean),
        debounce_seconds: existingFileBinding.value?.debounce_seconds ?? 2,
      }
    else if (!props.trigger || props.trigger.kind !== form.kind) config = {}
    emit('save', {
      trigger_id: props.trigger?.id,
      name: form.name.trim(),
      kind: form.kind,
      enabled: form.enabled,
      config: preserveWorkflowTriggerScope(props.trigger, form.kind, config),
      input,
    })
  } catch (error) {
    form.error = error instanceof Error ? error.message : 'Auslöser prüfen.'
  }
}
</script>
<template>
  <form class="wf-trigger-editor" @submit.prevent="save">
    <fieldset :disabled="disabled">
      <legend>{{ trigger ? 'Auslöser bearbeiten' : 'Neuer Auslöser' }}</legend>
      <label>Name<input v-model="form.name" required maxlength="160" /></label>
      <label
        >Starten durch<select v-model="form.kind">
          <option v-for="kind in WORKFLOW_TRIGGER_KINDS" :key="kind" :value="kind">{{ labels[kind] }}</option>
        </select></label
      >
      <template v-if="form.kind === 'schedule'">
        <label
          >Wiederholung<select v-model="form.timing">
            <option value="daily">Täglich</option>
            <option value="once">Einmalig</option>
            <option value="cron">Benutzerdefiniert (Cron)</option>
          </select></label
        >
        <label v-if="form.timing === 'daily'">Uhrzeit<input v-model="form.time" type="time" required /></label>
        <label v-else-if="form.timing === 'once'"
          >Termin in {{ form.timezone }}<input v-model="form.runAt" type="datetime-local" required
        /></label>
        <label v-else>Cron-Ausdruck<input v-model="form.cron" placeholder="0 9 * * 1-5" required /></label>
        <label>Zeitzone<input v-model="form.timezone" required placeholder="Europe/Berlin" /></label>
      </template>
      <template v-if="form.kind.startsWith('github.')">
        <label
          >Repository<select v-model="form.repositoryId" required>
            <option :value="0">Repository auswählen</option>
            <option v-for="repository in repositories" :key="repository.id" :value="repository.id">
              {{ repository.full_name }}
            </option>
          </select></label
        >
        <p v-if="!repositories.length" class="wf-muted">Zuerst ein GitHub-Repository mit diesem Projekt verbinden.</p>
        <label>Branch (optional)<input v-model="form.branch" placeholder="Alle Branches" /></label>
        <label v-if="form.kind === 'github.pull_request'">PR-Aktionen<input v-model="form.actions" /></label>
      </template>
      <label v-if="form.kind === 'workflow.completed'"
        >Quellworkflow<select v-model="form.sourceWorkflowId">
          <option :value="0">Alle Workflows dieses Projekts</option>
          <option v-for="workflow in workflows" :key="workflow.id" :value="workflow.id">{{ workflow.name }}</option>
        </select></label
      >
      <p v-if="form.kind === 'task.completed'" class="wf-muted">
        Startet bei abgeschlossenen Aufgaben in diesem Projekt.
      </p>
      <p v-if="form.kind === 'webhook'" class="wf-muted">
        Nach dem Speichern erscheinen die Adresse und der einmalig sichtbare Zugangsschlüssel.
      </p>
      <template v-if="form.kind === 'workspace.file_changed'">
        <p class="wf-muted">
          {{ fileRoot || 'Zuerst einen Projektordner binden.' }} ·
          {{ existingFileBinding ? 'Gespeicherte Gerätebindung' : 'Dieses Gerät' }}
        </p>
        <label>Dateimuster (eines pro Zeile)<textarea v-model="form.paths" rows="3" placeholder="**/*.md" /></label>
        <label>Ausschließen<textarea v-model="form.excludes" rows="3" /></label>
        <p class="wf-muted">
          Während Luczor geschlossen ist, werden keine Ereignisse beobachtet. Beim nächsten Start wird der Bestand
          abgeglichen.
        </p>
      </template>
      <details>
        <summary>Feste Workflow-Eingaben</summary>
        <label>Eingaben als JSON<textarea v-model="form.input" rows="5" spellcheck="false" /></label>
      </details>
      <label class="wf-check"><input v-model="form.enabled" type="checkbox" />Auslöser aktivieren</label>
      <p class="wf-muted">Künftige Starts verwenden die neueste gespeicherte Version innerhalb deiner Freigabe.</p>
      <p v-if="form.error" role="alert" class="wf-error">{{ form.error }}</p>
      <button type="submit" class="ai-button ai-button--primary" :disabled="!canSave">
        {{ form.enabled ? 'Speichern und aktivieren' : 'Auslöser speichern' }}
      </button>
    </fieldset>
  </form>
</template>
