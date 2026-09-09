<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  THINKING_DEFAULTS,
  type ThinkingBudgetProgress,
  type ThinkingControlAction,
} from '@/services/inference/thinking'
const props = defineProps<{
  progress: ThinkingBudgetProgress
  control?: (
    requestId: string,
    action: ThinkingControlAction,
    sequence: number
  ) => Promise<ThinkingBudgetProgress | void>
}>()
const emit = defineEmits<{ stop: [] }>()
const pending = ref(false)
const message = ref('')
watch(
  () => props.progress.requestId,
  () => {
    pending.value = false
    message.value = ''
  }
)
const phase = computed(() =>
  props.progress.phase === 'answering'
    ? 'Antwort wird geschrieben'
    : props.progress.answerRequested
      ? 'Antwort angefordert'
      : props.progress.phase === 'thinking'
        ? 'Denkt'
        : props.progress.phase === 'preparing'
          ? 'Wird vorbereitet'
          : 'Phase nicht bestätigt'
)
const fmt = (value: number) => value.toLocaleString('de-DE')
async function act(action: ThinkingControlAction) {
  if (!props.control || pending.value) return
  const id = props.progress.requestId
  const sequence = props.progress.sequence
  pending.value = true
  message.value = ''
  try {
    const result = await props.control(id, action, sequence)
    if (props.progress.requestId !== id) return
    message.value =
      result?.controlOutcome === 'stale'
        ? 'Der Stand wurde aktualisiert. Bitte die gewünschte Aktion erneut wählen.'
        : result?.controlOutcome === 'unavailable'
          ? 'Für diese Generation ist keine Live-Steuerung verfügbar.'
          : result?.controlOutcome === 'not_thinking'
            ? 'Die Denkphase ist bereits beendet.'
            : ''
  } catch (error) {
    if (props.progress.requestId === id)
      message.value = error instanceof Error ? error.message : 'Steuerung fehlgeschlagen.'
  } finally {
    if (props.progress.requestId === id) pending.value = false
  }
}
</script>
<template>
  <section class="thinking-budget" aria-label="Laufendes Denkbudget">
    <div class="thinking-budget__summary">
      <strong>{{ phase }}</strong
      ><span>{{ THINKING_DEFAULTS[progress.tier].label }} · {{ Math.floor(progress.elapsedMs / 1000) }} s</span>
    </div>
    <div class="thinking-budget__numbers">
      {{
        progress.generatedTokens === null
          ? 'Tokenstand noch unbekannt'
          : `${fmt(progress.generatedTokens)} Tokens generiert`
      }}
      · Denkziel {{ fmt(progress.softTargetTokens) }}
    </div>
    <p v-if="progress.thinkingLimitTokens < progress.requestedThinkingLimitTokens">
      Verfügbar: {{ fmt(progress.thinkingLimitTokens) }} von
      {{ fmt(progress.requestedThinkingLimitTokens) }} Denktokens.
    </p>
    <details>
      <summary>Budgetdetails</summary>
      <p>
        Gesamtausgabe bis {{ fmt(progress.outputLimitTokens) }} Tokens. Antwortreserve
        {{ fmt(progress.responseReserveTokens) }} Tokens. Der Zähler umfasst alle generierten Tokens; er misst keine
        separaten Denktokens.
      </p>
    </details>
    <div v-if="progress.warning || progress.answerRequested" class="thinking-budget__actions">
      <button type="button" :disabled="pending || !progress.canExtend || !control" @click="act('more')">
        Mehr denken
      </button>
      <button
        type="button"
        :disabled="pending || !progress.canAnswer || progress.answerRequested || !control"
        @click="act('answer')"
      >
        {{ progress.answerRequested ? 'Antwort angefordert' : 'Jetzt antworten' }}
      </button>
      <button type="button" @click="emit('stop')">Stoppen</button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
<style scoped>
.thinking-budget {
  border: 1px solid var(--ai-border, #373944);
  border-radius: 9px;
  padding: 10px 12px;
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--ai-text, #e8e9ef);
  background: var(--ai-surface, #20222a);
}
.thinking-budget__summary,
.thinking-budget__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.thinking-budget__summary {
  justify-content: space-between;
}
.thinking-budget__numbers,
details {
  margin-top: 5px;
  color: var(--ai-text-muted, #b0b2bf);
}
p {
  margin: 6px 0;
  line-height: 1.5;
}
summary {
  cursor: pointer;
}
.thinking-budget__actions {
  margin-top: 8px;
}
button {
  min-height: 32px;
  padding: 5px 8px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--ai-border, #494b56);
  border-radius: 6px;
}
button:disabled {
  opacity: 0.5;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
</style>
