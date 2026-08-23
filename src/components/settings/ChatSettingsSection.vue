<script setup lang="ts">
import { computed } from 'vue'

type ChatAutoSpeechMode = 'off' | 'assistant_only' | 'all'

const props = defineProps<{
  autoSpeech: boolean
  autoSpeechMode: ChatAutoSpeechMode
  historyTokenBudget: number
}>()

const emit = defineEmits<{
  (event: 'update:autoSpeech', value: boolean): void
  (event: 'update:autoSpeechMode', value: ChatAutoSpeechMode): void
  (event: 'update:historyTokenBudget', value: number): void
  (event: 'reset'): void
}>()

const autoSpeechModeModel = computed({
  get: () => props.autoSpeechMode,
  set: value => emit('update:autoSpeechMode', value),
})
const historyTokenBudgetModel = computed({
  get: () => props.historyTokenBudget,
  set: value => emit('update:historyTokenBudget', value),
})
</script>

<template>
  <div class="lz-section">
    <div class="lz-section__head">
      <h3>Chat</h3>
      <p>Auto Speech liest neue Antworten automatisch vor (Streaming-TTS).</p>
    </div>
    <div class="lz-card">
      <div class="lz-card__head">
        <div>
          <div class="lz-card__title">Auto Speech</div>
          <div class="lz-card__meta">Antworten automatisch vorlesen.</div>
        </div>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': autoSpeech }"
          aria-label="Toggle Auto Speech"
          @click="emit('update:autoSpeech', !autoSpeech)"
        >
          <span />
        </button>
      </div>

      <div class="lz-grid2">
        <div>
          <label class="lz-label">Modus</label>
          <select v-model="autoSpeechModeModel" class="lz-input">
            <option value="assistant_only">Nur Assistant</option>
            <option value="all">User + Assistant</option>
            <option value="off">Aus</option>
          </select>
        </div>
        <div>
          <label class="lz-label">Rate</label>
          <div class="lz-range">
            <input value="1" type="range" min="1" max="1" disabled />
            <span class="lz-range__val">automatisch</span>
          </div>
        </div>
        <div>
          <label class="lz-label">Volume</label>
          <div class="lz-range">
            <input value="100" type="range" min="100" max="100" disabled />
            <span class="lz-range__val">Systemlautstärke</span>
          </div>
        </div>
      </div>

      <div>
        <label class="lz-label">Lokales Chat-Historienbudget</label>
        <div class="lz-range">
          <input v-model.number="historyTokenBudgetModel" type="range" min="400" max="12000" step="200" />
          <span class="lz-range__val">{{ historyTokenBudget }} Tokens</span>
        </div>
        <p class="lz-hint">
          Begrenzt den Verlauf vor jeder Anfrage. Niedriger spart Kosten und Kontext, höher bewahrt mehr
          Gesprächsdetails.
        </p>
      </div>

      <div class="lz-actions">
        <button type="button" class="lz-btn lz-btn--ghost" @click="emit('reset')">Chat-Settings zurücksetzen</button>
      </div>
    </div>
  </div>
</template>
