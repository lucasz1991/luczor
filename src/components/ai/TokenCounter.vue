<script setup lang="ts">
import { computed } from 'vue'
import type { TokenUsage } from '@/services/tokenUsage'
const props = defineProps<{ usage?: TokenUsage; active?: boolean }>()
const format = (value: number) => value.toLocaleString('de-DE')
const sourceLabel = computed(() =>
  props.usage?.source === 'reported'
    ? 'gemeldet'
    : props.usage?.source === 'mixed'
      ? 'teilweise geschätzt'
      : 'geschätzt'
)
</script>
<template>
  <div
    v-if="usage"
    class="token-counter"
    aria-label="Tokenverbrauch"
    :title="`Tokenverbrauch aller ${usage.rounds} Modellrunden dieser Antwort. ${sourceLabel}.`"
  >
    <strong>{{ format(usage.totalTokens) }} Tokens</strong><span>{{ format(usage.inputTokens) }} Eingabe</span
    ><span>{{ format(usage.outputTokens) }} Ausgabe</span><span>{{ sourceLabel }}{{ active ? ' · live' : '' }}</span>
    <span v-if="usage.contextTokens">Kontextfenster: {{ format(usage.contextTokens) }}</span>
  </div>
</template>
<style scoped>
.token-counter {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  margin-top: 9px;
  color: var(--ai-text-muted, #9293a3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
strong {
  font-weight: 500;
  color: var(--ai-text, #dedee8);
}
</style>
