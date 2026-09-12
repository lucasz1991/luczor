<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import ThinkingSelector from '@/components/ai/ThinkingSelector.vue'
import {
  THINKING_DEFAULTS,
  THINKING_TIERS,
  resolveThinkingConfig,
  type ThinkingTier,
} from '@/services/inference/thinking'
import {
  thinkingSettings,
  saveThinkingSettings,
  readOverride,
  writeOverride,
  deleteOverride,
} from '@/services/inference/thinkingSettings'
const defaultTier = ref<ThinkingTier>(thinkingSettings.value.defaultTier)
const editedTier = ref<ThinkingTier>('balanced')
const draft = reactive({
  ...resolveThinkingConfig(editedTier.value, readOverride(thinkingSettings.value.overrides, editedTier.value)),
})
const notice = ref('')
watch(editedTier, tier => {
  Object.assign(draft, resolveThinkingConfig(tier, readOverride(thinkingSettings.value.overrides, tier)))
  notice.value = ''
})
function save(reset = false) {
  try {
    const overrides = { ...thinkingSettings.value.overrides }
    if (reset) deleteOverride(overrides, editedTier.value)
    else writeOverride(overrides, editedTier.value, resolveThinkingConfig(editedTier.value, draft))
    saveThinkingSettings(defaultTier.value, overrides)
    Object.assign(draft, resolveThinkingConfig(editedTier.value, readOverride(overrides, editedTier.value)))
    notice.value = 'Auf diesem Gerät gespeichert. Laufende Aufträge behalten ihr Budget.'
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Speichern fehlgeschlagen.'
  }
}
function resetAll() {
  try {
    saveThinkingSettings('balanced', {})
    defaultTier.value = 'balanced'
    Object.assign(draft, resolveThinkingConfig(editedTier.value))
    notice.value = 'Alle Denkstufen zurückgesetzt.'
  } catch {
    notice.value = 'Zurücksetzen konnte nicht gespeichert werden.'
  }
}
</script>
<template>
  <section class="lz-card thinking-settings" aria-label="Denktiefe einstellen">
    <div class="lz-card__head">
      <div>
        <div class="lz-card__title">Denktiefe</div>
        <p class="lz-hint">Ausgewogen ist der Standard. Größere Budgets benötigen entsprechend freien Modellkontext.</p>
      </div>
    </div>
    <div class="thinking-settings__default">
      <span>Standard für neue Chats</span> <ThinkingSelector v-model="defaultTier" />
    </div>
    <details>
      <summary>Expertenwerte je Stufe</summary>
      <label
        >Stufe
        <select v-model="editedTier">
          <option v-for="tier in THINKING_TIERS" :key="tier" :value="tier">{{ THINKING_DEFAULTS[tier].label }}</option>
        </select></label
      >
      <label
        >Anfängliches Denkziel <input v-model.number="draft.initialTokens" type="number" min="1" max="65536" step="1"
      /></label>
      <label
        >Automatische Denkgrenze
        <input v-model.number="draft.maxThinkingTokens" type="number" min="1" max="65536" step="1"
      /></label>
      <label
        >Reservierte Antworttokens
        <input v-model.number="draft.responseReserveTokens" type="number" min="256" max="131071" step="1"
      /></label>
      <p class="lz-hint">
        Die Runtime begrenzt diese Werte auf den tatsächlich verfügbaren Kontext. Ein Stufenwechsel lädt das Modell
        nicht neu.
      </p>
      <button type="button" class="lz-btn" @click="save(true)">Stufe zurücksetzen</button>
    </details>
    <div class="thinking-settings__actions">
      <button type="button" class="lz-btn" @click="save()">Speichern</button
      ><button type="button" class="lz-btn" @click="resetAll">Alles zurücksetzen</button>
    </div>
    <p v-if="notice" class="lz-hint" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>
label {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
}
details {
  margin: 14px 0;
}
summary {
  cursor: pointer;
  padding: 5px 0;
}
input,
select {
  width: 150px;
  max-width: 100%;
  min-height: 32px;
  background: var(--lz-input-bg, #22252d);
  color: inherit;
  border: 1px solid var(--lz-border, #4b4e5b);
  padding: 4px 8px;
  border-radius: 6px;
}
.thinking-settings__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
