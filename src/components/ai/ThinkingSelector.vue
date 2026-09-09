<script setup lang="ts">
import { isThinkingTier, THINKING_DEFAULTS, THINKING_TIERS, type ThinkingTier } from '@/services/inference/thinking'
withDefaults(defineProps<{ modelValue?: ThinkingTier; nextPrompt?: boolean }>(), { modelValue: 'balanced' })
const emit = defineEmits<{ 'update:modelValue': [value: ThinkingTier] }>()
function change(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (isThinkingTier(value)) emit('update:modelValue', value)
}
</script>
<template>
  <label
    class="ai-thinking-select"
    :title="nextPrompt ? 'Denktiefe für den nächsten Auftrag' : 'Denktiefe für diesen Auftrag'"
  >
    <span>Denktiefe</span>
    <select
      :value="modelValue"
      :aria-label="nextPrompt ? 'Denktiefe für den nächsten Auftrag' : 'Denktiefe'"
      @change="change"
    >
      <option v-for="tier in THINKING_TIERS" :key="tier" :value="tier">{{ THINKING_DEFAULTS[tier].label }}</option>
    </select>
  </label>
</template>
<style scoped>
.ai-thinking-select {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  color: var(--ai-text-muted, #a3a5af);
}
select {
  max-width: 115px;
  min-height: 28px;
  border: 1px solid var(--ai-border, #3c3e48);
  border-radius: 6px;
  padding: 2px 4px;
  background: var(--ai-surface, #22252d);
  color: var(--ai-text, #e9eaf0);
  font: inherit;
}
select:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
</style>
