<script setup lang="ts">
import { ref } from 'vue'
import { LuczorApi } from '@/services/api/luczorApi'
import type { SpecialistOutcome } from '@/services/agents/externalSpecialists'
defineProps<{ outcomes: SpecialistOutcome[] }>()
const feedback = ref(new Map<string, number>())
const pending = ref(new Map<string, boolean>())
const error = ref('')
const labels = { planning: 'Vorgehen', research: 'Recherche', coding: 'Codevorschlag', review: 'Ergebnisprüfung' }
async function rate(outcome: SpecialistOutcome, rating: 1 | -1) {
  if (!outcome.requestId || pending.value.get(outcome.requestId)) return
  const id = outcome.requestId
  pending.value.set(id, true)
  error.value = ''
  try {
    await LuczorApi.evaluateLlmRun(id, {
      evaluator_id: 'luczor.user.agent-role.v1',
      status: rating > 0 ? 'passed' : 'failed',
      quality_score: rating > 0 ? 1 : 0,
      success_score: rating > 0 ? 1 : 0,
      user_feedback: rating,
      payload: { evidence_type: 'user_review', role: outcome.role },
    })
    feedback.value.set(id, rating)
  } catch {
    error.value = 'Bewertung konnte nicht gespeichert werden. Bitte erneut versuchen.'
  } finally {
    pending.value.set(id, false)
  }
}
</script>

<template>
  <details v-if="outcomes.length" class="agent-results">
    <summary>Zusätzliche Ergebnisse · {{ outcomes.length }} Beiträge</summary>
    <p>Beiträge und verwendete Modelle ansehen oder bewerten. Bewertungen helfen bei der späteren Modellauswahl.</p>
    <section v-for="outcome in outcomes" :key="outcome.requestId ?? outcome.role">
      <!-- Specialists only ever run on the approved external route, so the badge names it. -->
      <strong>{{ labels[outcome.role] }}</strong> · Router · {{ outcome.model ?? 'Servermodell' }}
      <small v-if="outcome.incomplete">Unvollständig: Ausgabelimit erreicht</small>
      <small
        >{{ (outcome.durationMs / 1000).toFixed(1) }} s ·
        {{ outcome.tokenUsage.totalTokens.toLocaleString('de-DE') }} Tokens</small
      >
      <details>
        <summary>Vorschlag ansehen</summary>
        <pre>{{ outcome.output }}</pre>
      </details>
      <template v-if="outcome.requestId">
        <button
          type="button"
          :disabled="pending.get(outcome.requestId)"
          :aria-pressed="feedback.get(outcome.requestId) === 1"
          @click="rate(outcome, 1)"
        >
          Hilfreich
        </button>
        <button
          type="button"
          :disabled="pending.get(outcome.requestId)"
          :aria-pressed="feedback.get(outcome.requestId) === -1"
          @click="rate(outcome, -1)"
        >
          Nicht hilfreich
        </button>
        <small v-if="feedback.get(outcome.requestId)">Bewertung gespeichert</small>
      </template>
    </section>
    <p v-if="error" role="alert">{{ error }}</p>
  </details>
</template>

<style scoped>
.agent-results {
  margin-block: 0.65rem;
  color: var(--ai-text-muted, #b0b2bf);
  font-size: 0.75rem;
}
summary,
button {
  cursor: pointer;
}
section {
  padding-block: 0.65rem;
}
small {
  display: block;
  opacity: 0.7;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  max-height: 22rem;
  overflow: auto;
}
button {
  margin: 0.4rem 0.4rem 0 0;
  padding: 0.3rem 0.6rem;
  border: 1px solid currentColor;
  border-radius: 0.35rem;
}
button[aria-pressed='true'] {
  font-weight: 700;
}
</style>
