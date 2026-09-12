<script setup lang="ts">
import { computed, ref } from 'vue'
import { LuczorApi } from '@/services/api/luczorApi'
import type { SpecialistOutcome } from '@/services/agents/externalSpecialists'
import AiIcon from './AiIcon.vue'
import StreamingText from './StreamingText.vue'

const props = defineProps<{ outcomes: SpecialistOutcome[] }>()
const feedback = ref(new Map<string, number>())
const pending = ref(new Map<string, boolean>())
const errors = ref(new Map<string, string>())
const incompleteCount = computed(() => props.outcomes.filter(outcome => outcome.incomplete).length)
const roles = {
  planning: { label: 'Planung', icon: 'grid' },
  research: { label: 'Recherche', icon: 'search' },
  coding: { label: 'Codevorschlag', icon: 'code' },
  review: { label: 'Ergebnisprüfung', icon: 'shield' },
}
function duration(milliseconds: number) {
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? (milliseconds / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' s'
    : 'Dauer nicht gemeldet'
}
function tokens(outcome: SpecialistOutcome) {
  const count = outcome.tokenUsage.totalTokens
  if (!Number.isFinite(count) || count < 0) return 'Tokens nicht gemeldet'
  return (outcome.tokenUsage.source === 'reported' ? '' : '≈ ') + count.toLocaleString('de-DE') + ' Tokens'
}
async function rate(outcome: SpecialistOutcome, rating: 1 | -1) {
  if (!outcome.requestId || pending.value.get(outcome.requestId)) return
  const id = outcome.requestId
  pending.value.set(id, true)
  errors.value.delete(id)
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
    errors.value.set(id, 'Bewertung konnte nicht gespeichert werden. Bitte erneut versuchen.')
  } finally {
    pending.value.set(id, false)
  }
}
</script>

<template>
  <section v-if="outcomes.length" class="agent-results" aria-label="Beiträge der Fachagenten">
    <header class="agent-results__heading">
      <span class="agent-results__title">Agentenbeiträge</span>
      <span class="agent-results__count"
        >{{ outcomes.length }} {{ outcomes.length === 1 ? 'Beitrag' : 'Beiträge' }}</span
      >
      <span v-if="incompleteCount" class="agent-results__incomplete">{{ incompleteCount }} unvollständig</span>
    </header>
    <details
      v-for="(outcome, index) in outcomes"
      :key="outcome.requestId ?? outcome.role + '-' + index"
      class="agent-result"
    >
      <summary class="agent-result__summary">
        <span class="agent-result__mark"><AiIcon :name="roles[outcome.role].icon" :size="16" /></span>
        <span class="agent-result__identity">
          <span class="agent-result__name">
            <strong>{{ roles[outcome.role].label }}</strong>
            <span v-if="outcome.incomplete" class="agent-result__warning">Ausgabelimit</span>
            <span v-else class="agent-result__kind">Vorschlag</span>
          </span>
          <span class="agent-result__model"
            >{{ outcome.provider || 'Provider nicht gemeldet' }} · {{ outcome.model || 'Modell nicht gemeldet' }}</span
          >
        </span>
        <span class="agent-result__metrics">
          <span>{{ duration(outcome.durationMs) }}</span>
          <span
            :title="
              outcome.tokenUsage.source === 'reported'
                ? 'Vom Modell gemeldete Nutzung'
                : 'Nutzung enthält geschätzte Werte'
            "
            >{{ tokens(outcome) }}</span
          >
        </span>
        <AiIcon name="chevron" :size="14" class="agent-result__chevron" />
      </summary>
      <div class="agent-result__content">
        <p v-if="outcome.incomplete" class="agent-result__notice">
          Der Beitrag ist unvollständig: Das Ausgabelimit wurde erreicht.
        </p>
        <p v-if="outcome.toolNotice" class="agent-result__notice">{{ outcome.toolNotice }}</p>
        <StreamingText v-if="outcome.output.trim()" :content="outcome.output" :actions="false" />
        <p v-else class="agent-result__notice">Kein öffentlicher Beitrag übermittelt.</p>
        <footer
          v-if="outcome.requestId"
          class="agent-result__feedback"
          :aria-busy="pending.get(outcome.requestId) || undefined"
        >
          <span>War dieser Beitrag hilfreich?</span>
          <div class="agent-result__ratings">
            <button
              type="button"
              :disabled="pending.get(outcome.requestId)"
              :aria-pressed="feedback.get(outcome.requestId) === 1"
              :aria-label="roles[outcome.role].label + ': hilfreich'"
              @click="rate(outcome, 1)"
            >
              <AiIcon name="check" :size="13" /> Hilfreich
            </button>
            <button
              type="button"
              :disabled="pending.get(outcome.requestId)"
              :aria-pressed="feedback.get(outcome.requestId) === -1"
              :aria-label="roles[outcome.role].label + ': nicht hilfreich'"
              @click="rate(outcome, -1)"
            >
              <AiIcon name="close" :size="13" /> Nicht hilfreich
            </button>
          </div>
          <span v-if="pending.get(outcome.requestId)" role="status">Wird gespeichert …</span>
          <span v-else-if="feedback.get(outcome.requestId)" role="status">Bewertung gespeichert</span>
          <p v-if="errors.get(outcome.requestId)" class="agent-result__error" role="alert">
            {{ errors.get(outcome.requestId) }}
          </p>
        </footer>
      </div>
    </details>
  </section>
</template>

<style scoped>
.agent-results {
  margin-block: 18px 10px;
  color: var(--ai-muted);
  font: 12px/1.5 var(--ai-font);
  min-width: 0;
  container-type: inline-size;
}
.agent-results__heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 10px;
  margin-bottom: 6px;
  font-size: 11px;
}
.agent-results__title {
  font-weight: 550;
}
.agent-results__count {
  color: var(--ai-faint);
}
.agent-results__incomplete {
  color: var(--ai-orange);
}
.agent-result {
  border-bottom: 1px solid color-mix(in srgb, var(--ai-line) 65%, transparent);
}
.agent-result__summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-block: 11px;
  cursor: pointer;
  list-style: none;
  border-radius: 5px;
}
.agent-result__summary::-webkit-details-marker {
  display: none;
}
.agent-result__summary:hover .agent-result__name strong {
  color: var(--ai-accent);
}
.agent-result__summary:focus-visible,
.agent-result__ratings button:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 3px;
}
.agent-result__mark {
  display: grid;
  place-items: center;
  flex: 0 0 28px;
  height: 28px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--ai-ink) 4%, transparent);
}
.agent-result__identity {
  min-width: 0;
  flex: 1;
}
.agent-result__name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 9px;
}
.agent-result__name strong {
  color: var(--ai-ink);
  font-weight: 550;
}
.agent-result__kind,
.agent-result__warning {
  color: var(--ai-faint);
  font-size: 10px;
}
.agent-result__warning {
  color: var(--ai-orange);
}
.agent-result__model {
  display: block;
  margin-top: 2px;
  color: var(--ai-faint);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.agent-result__metrics {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  color: var(--ai-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.agent-result__chevron {
  flex-shrink: 0;
  color: var(--ai-faint);
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.agent-result[open] .agent-result__chevron {
  transform: rotate(90deg);
}
.agent-result__content {
  padding: 8px 0 14px 38px;
  min-width: 0;
}
.agent-result__content :deep(.ai-answer) {
  margin: 0;
}
.agent-result__content :deep(.rt) {
  font-size: 13px;
}
.agent-result__notice {
  margin: 0 0 10px;
  color: var(--ai-muted);
  font-size: 12px;
}
.agent-result__feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-top: 18px;
  color: var(--ai-faint);
  font-size: 11px;
}
.agent-result__ratings {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.agent-result__ratings button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ai-muted);
  font: inherit;
  cursor: pointer;
  transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.agent-result__ratings button:hover,
.agent-result__ratings button[aria-pressed='true'] {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.agent-result__ratings button:active:not(:disabled) {
  transform: scale(0.97);
}
.agent-result__ratings button:disabled {
  opacity: 0.5;
  cursor: wait;
}
.agent-result__error {
  width: 100%;
  margin: 0;
  color: var(--ai-red);
}
@container (max-width: 430px) {
  .agent-result__summary {
    flex-wrap: wrap;
    gap: 5px 8px;
  }
  .agent-result__identity {
    flex-basis: calc(100% - 60px);
  }
  .agent-result__metrics {
    order: 1;
    flex-direction: row;
    align-items: baseline;
    gap: 10px;
    padding-left: 36px;
  }
  .agent-result__content {
    padding-left: 0;
  }
  .agent-result__ratings button {
    min-height: 36px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-result__chevron,
  .agent-result__ratings button {
    transition: none;
  }
}
</style>
