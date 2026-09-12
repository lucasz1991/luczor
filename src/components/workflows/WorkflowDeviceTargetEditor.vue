<script setup lang="ts">
import { computed } from 'vue'
import type { WorkflowDeviceTarget, WorkflowTask } from '@/services/workflows/types'
import { validateWorkflowDeviceTarget } from '@/services/workflows/deviceTarget'

const props = defineProps<{ modelValue?: WorkflowDeviceTarget; catalog: WorkflowTask[]; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: WorkflowDeviceTarget | undefined] }>()
const kind = computed(() => props.modelValue?.kind ?? 'current')
const clientTasks = computed(() => props.catalog.filter(task => task.runner === 'client' && task.allowed_in_definition))
const error = computed(() => {
  if (!props.modelValue) return ''
  try {
    validateWorkflowDeviceTarget(props.modelValue, props.catalog)
    return ''
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'Geräteziel prüfen.'
  }
})
function selectKind(next: string) {
  if (props.disabled) return
  if (next === 'current') emit('update:modelValue', undefined)
  else if (next === 'coordinator') emit('update:modelValue', { kind: next })
  else if (next === 'specific') emit('update:modelValue', { kind: next, device_id: '' })
  else if (next === 'capability') emit('update:modelValue', { kind: next })
}
function setDeviceId(value: string) {
  if (!props.disabled && kind.value === 'specific')
    emit('update:modelValue', { kind: 'specific', device_id: value.trim() })
}
function setCapability(value: string) {
  if (!props.disabled && kind.value === 'capability')
    emit('update:modelValue', { kind: 'capability', ...(value ? { task_type: value, task_version: 1 } : {}) })
}
</script>

<template>
  <fieldset class="wf-options" :disabled="disabled">
    <legend>Ausführendes Gerät</legend>
    <label
      >Geräteziel
      <select :value="kind" @change="selectKind(($event.target as HTMLSelectElement).value)">
        <option value="current">Startgerät · Standard</option>
        <option value="coordinator">Koordinator</option>
        <option value="specific">Bestimmtes Gerät</option>
        <option value="capability">Passendes verfügbares Gerät</option>
      </select>
    </label>
    <template v-if="modelValue?.kind === 'specific'">
      <label
        >Geräte-ID<input
          :value="modelValue.device_id"
          maxlength="120"
          autocomplete="off"
          @input="setDeviceId(($event.target as HTMLInputElement).value)"
      /></label>
      <p class="wf-muted">Die Geräte-ID steht im Geräteverbund. Der Server prüft die Zuordnung zu deinem Konto.</p>
    </template>
    <template v-else-if="modelValue?.kind === 'capability'">
      <label
        >Benötigte Fähigkeit
        <select :value="modelValue.task_type ?? ''" @change="setCapability(($event.target as HTMLSelectElement).value)">
          <option value="">Aufgabe dieses Schritts übernehmen</option>
          <option v-for="task in clientTasks" :key="task.key" :value="task.key">
            {{ task.label }} · Version {{ task.version ?? 1 }}
          </option>
        </select>
      </label>
      <p class="wf-muted">Verfügbarkeit und die Fähigkeiten für diesen Schritt werden beim Start geprüft.</p>
    </template>
    <p v-if="error" role="alert" class="wf-error">{{ error }}</p>
    <p class="wf-muted">
      Mit dem Workflow speichern. Die Änderung gilt für neue Läufe; laufende Aufträge behalten ihre Version.
    </p>
  </fieldset>
</template>
