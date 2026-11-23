<script setup lang="ts">
import { computed } from 'vue'
import type { MessageHandoff } from '@/state/types'

// Notice for a turn Claude did not process: either the local specialist took over, or the user
// decides. The provider's policy category is diagnostic data and is deliberately never rendered.
const props = withDefaults(
  defineProps<{
    handoff: MessageHandoff
    localAvailable: boolean
    busy?: boolean
    /** Offer switching the chat to "Claude + lokal" (only useful in "Nur Claude"). */
    canSwitchMode?: boolean
  }>(),
  { busy: false, canSwitchMode: false }
)
const emit = defineEmits<{ accept: []; decline: []; 'switch-mode': [] }>()

const REFUSED = ' Die Anthropic-API hat die Runde mit einem Richtlinienhinweis beendet.'
const manualTaken = computed(() => props.handoff.reason === 'manual' && props.handoff.state === 'taken')
const lead = computed(() =>
  manualTaken.value ? 'Lokal neu beantwortet.' : 'Claude hat diese Anfrage nicht bearbeitet.'
)
const detail = computed(() => {
  if (manualTaken.value)
    return ' Diese Runde wurde auf Wunsch vom lokalen Spezial-Agenten bearbeitet und wird nicht an Claude gesendet.'
  switch (props.handoff.state) {
    case 'taken':
      return `${REFUSED} Der lokale Spezial-Agent hat den Auftrag übernommen; diese Runde wird nicht an Claude gesendet.`
    case 'offered':
      return `${REFUSED} Soll der lokale Spezial-Agent den Auftrag auf diesem Gerät übernehmen?`
    default:
      return ' Die Anfrage wurde nicht bearbeitet.'
  }
})
const offered = computed(() => props.handoff.state === 'offered')
</script>

<template>
  <div class="ai-handoff" :class="`is-${handoff.state}`" role="status">
    <svg
      class="ai-handoff__icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 8h.01M11 12h1v5h1M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" />
    </svg>
    <div class="ai-handoff__body">
      <p class="ai-handoff__text">
        <b>{{ lead }}</b
        >{{ detail }}
      </p>
      <div v-if="offered" class="ai-handoff__actions">
        <button
          type="button"
          class="ai-handoff__button ai-handoff__button--primary"
          :disabled="busy || !localAvailable"
          @click="emit('accept')"
        >
          Lokal bearbeiten
        </button>
        <button type="button" class="ai-handoff__button" :disabled="busy" @click="emit('decline')">
          Nicht bearbeiten
        </button>
        <button
          v-if="canSwitchMode"
          type="button"
          class="ai-handoff__button"
          :disabled="busy"
          @click="emit('switch-mode')"
        >
          Chat auf „Claude + lokal“ umstellen
        </button>
      </div>
      <p v-if="offered && !localAvailable" class="ai-handoff__hint">Kein lokales Modell bereit.</p>
    </div>
  </div>
</template>

<style scoped>
.ai-handoff {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  border: 1px solid var(--energy-border, rgba(212, 160, 84, 0.28));
  border-radius: 15px;
  background: var(--energy-wash, rgba(212, 160, 84, 0.1));
  color: var(--text-secondary, var(--ai-text-muted, #a3a5af));
  font-size: 13px;
  line-height: 1.6;
}
.ai-handoff__icon {
  flex: none;
  margin-top: 2px;
  color: var(--energy-bright, #ecc27a);
}
.ai-handoff__body {
  min-width: 0;
}
.ai-handoff__text {
  margin: 0;
}
.ai-handoff__text b {
  color: var(--text-primary, var(--ai-text, #e9eaf0));
  font-weight: 650;
}
.ai-handoff__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.ai-handoff__button {
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.035);
  color: var(--text-secondary, var(--ai-text-muted, #a3a5af));
  font: 600 12px var(--font-ui, var(--ai-font, inherit));
  cursor: pointer;
  transition:
    background 180ms var(--ease, ease),
    border-color 180ms var(--ease, ease),
    color 180ms var(--ease, ease);
}
.ai-handoff__button:hover:not(:disabled) {
  color: var(--text-primary, var(--ai-text, #e9eaf0));
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.14);
}
.ai-handoff__button--primary {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.11);
  background: linear-gradient(145deg, var(--cy-bright, #a892ea), var(--cy-deep, #5a47ad));
}
.ai-handoff__button--primary:hover:not(:disabled) {
  color: #fff;
  background: linear-gradient(145deg, var(--cy-bright, #a892ea), var(--cy-deep, #5a47ad));
  filter: brightness(1.08);
}
.ai-handoff__button:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
.ai-handoff__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ai-handoff__hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-muted, var(--ai-faint, #6f788d));
}
@media (prefers-reduced-motion: reduce) {
  .ai-handoff__button {
    transition: none;
  }
}
</style>
