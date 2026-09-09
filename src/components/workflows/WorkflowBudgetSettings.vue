<script setup lang="ts">
import { computed } from 'vue'
import type { WorkflowDefinition } from '@/services/workflows/types'
const props = defineProps<{ modelValue: WorkflowDefinition; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: WorkflowDefinition] }>()
const defaults = { active_seconds: 2700, max_executions: 200, max_loop_iterations: 10, max_parallel: 2, max_repairs: 2 }
const budget = computed(() => props.modelValue.budgets ?? defaults)
const fields = [
  { key: 'active_seconds', label: 'Aktive Laufzeit (Minuten)', max: 45, scale: 60, min: 1 },
  { key: 'max_executions', label: 'Schritte einschließlich Unterläufen', max: 200, scale: 1, min: 1 },
  { key: 'max_loop_iterations', label: 'Wiederholungen je Schleife', max: 10, scale: 1, min: 1 },
  { key: 'max_parallel', label: 'Parallele unabhängige Schritte', max: 2, scale: 1, min: 1 },
  { key: 'max_repairs', label: 'Reparaturversuche', max: 2, scale: 1, min: 0 },
] as const
function change(key: keyof typeof defaults, value: number) {
  const field = fields.find(item => item.key === key)!
  if (props.disabled || !Number.isInteger(value) || value < field.min || value > field.max) return
  emit('update:modelValue', {
    ...props.modelValue,
    schema_version: 2,
    budgets: { ...budget.value, [key]: value * field.scale },
  })
}
</script>
<template>
  <fieldset class="workflow-budget-settings" :disabled="disabled">
    <legend>Laufgrenzen</legend>
    <p>
      Die Grenzen gelten für den gesamten Auftrag mit Unterläufen. Bereits erteilte niedrigere Gerätefreigaben gelten
      weiter.
    </p>
    <div>
      <label v-for="field in fields" :key="field.key"
        >{{ field.label
        }}<input
          type="number"
          :value="budget[field.key] / field.scale"
          :min="field.min"
          :max="field.max"
          step="1"
          @change="change(field.key, Number(($event.target as HTMLInputElement).value))"
      /></label>
    </div>
    <p>Wartezeit wird getrennt erfasst. Die Zahl der möglichen Reparaturen aktiviert noch keine Reparaturbefugnis.</p>
  </fieldset>
</template>
<style scoped>
.workflow-budget-settings {
  border: 1px solid var(--ui-border, #d7dce2);
  border-radius: 12px;
  padding: 16px;
  margin: 16px 0;
}
.workflow-budget-settings legend {
  font-weight: 650;
  padding: 0 6px;
}
.workflow-budget-settings p {
  font-size: 0.85rem;
  line-height: 1.55;
  color: var(--ui-text-muted, #657081);
}
.workflow-budget-settings > div {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px;
}
.workflow-budget-settings label {
  display: grid;
  align-content: start;
  gap: 7px;
  font-size: 0.85rem;
}
.workflow-budget-settings input {
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 1px solid var(--ui-border, #d7dce2);
  border-radius: 7px;
  background: var(--ui-surface, transparent);
  color: inherit;
}
</style>
