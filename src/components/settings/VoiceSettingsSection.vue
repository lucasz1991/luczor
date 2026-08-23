<script setup lang="ts">
import { computed } from 'vue'
import type { VoiceMode } from '@/services/voice/localVoice'

const props = defineProps<{
  deviceKey: string
  voiceMode: VoiceMode
  wakeWord: string
  sttLanguage: string
}>()

const emit = defineEmits<{
  (event: 'update:voiceMode', value: VoiceMode): void
  (event: 'update:wakeWord', value: string): void
  (event: 'update:sttLanguage', value: string): void
  (event: 'openServer'): void
}>()

const voiceModeModel = computed({
  get: () => props.voiceMode,
  set: value => emit('update:voiceMode', value),
})
const wakeWordModel = computed({
  get: () => props.wakeWord,
  set: value => emit('update:wakeWord', value),
})
const sttLanguageModel = computed({
  get: () => props.sttLanguage,
  set: value => emit('update:sttLanguage', value),
})
</script>

<template>
  <div class="lz-section">
    <div class="lz-section__head">
      <h3>Voice</h3>
      <p>
        Lokale Sprache nutzt whisper.cpp für STT und Piper für TTS. Keine Cloud-Audio-Keys und keine versteckten
        Fallbacks.
      </p>
    </div>
    <div v-if="!deviceKey.trim()" class="lz-voice-warning" role="alert">
      <div>
        <div class="lz-card__title">Device-Key für die erste Voice-Installation fehlt</div>
        <p class="lz-hint">
          Der signierte lokale Voice-Runtime-Download benötigt einmalig einen Device-Key. Bereits installierte
          Sprachmodelle bleiben danach lokal nutzbar.
        </p>
      </div>
      <button type="button" class="lz-btn lz-btn--ghost" @click="emit('openServer')">Device-Key hinterlegen</button>
    </div>
    <div v-if="false" class="lz-section__head">
      <h3>Voice</h3>
      <div class="lz-card">
        <div class="lz-card__title">Lokale Sprache fest verdrahtet</div>
        <p class="lz-hint">
          STT nutzt whisper.cpp, TTS nutzt Piper. Es gibt keine ElevenLabs-Konfiguration, keinen Voice-API-Key und keine
          Backend-Auswahl im Client.
        </p>
      </div>
      <p>Dauer-Zuhören mit Wake-Word und optional lokale Sprachmodelle (offline).</p>
    </div>
    <div class="lz-card">
      <div class="lz-grid2">
        <div>
          <label class="lz-label">Eingabe-Modus</label>
          <select v-model="voiceModeModel" class="lz-input">
            <option value="push_to_talk">Push-to-Talk</option>
            <option value="continuous">Dauer-Zuhören</option>
            <option value="wakeword">Wake-Word</option>
          </select>
        </div>
        <div>
          <label class="lz-label">Wake-Word</label>
          <input v-model="wakeWordModel" type="text" class="lz-input" :disabled="voiceMode !== 'wakeword'" />
          <p class="lz-hint">Erkennung über das Transkript.</p>
        </div>
        <div>
          <label class="lz-label">STT-Sprache</label>
          <input v-model="sttLanguageModel" type="text" class="lz-input" placeholder="de" />
        </div>
        <div v-if="false">
          <label class="lz-label">STT-Backend</label>
          <select value="local" class="lz-input" disabled>
            <option value="local">Lokal (whisper.cpp)</option>
          </select>
        </div>
        <div v-if="false">
          <label class="lz-label">TTS-Backend</label>
          <select value="local" class="lz-input" disabled>
            <option value="local">Lokal (Piper)</option>
          </select>
        </div>
      </div>
    </div>
    <div v-if="false" class="lz-card">
      <div class="lz-card__title">Lokale Modelle (offline)</div>
      <p class="lz-hint">
        Pfade zu selbst installierten Binaries/Modellen. Ohne diese ist Sprache deaktiviert, statt auf Cloud
        auszuweichen.
      </p>
      <div class="lz-grid2">
        <div>
          <label class="lz-label">whisper.cpp Binary</label>
          <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
        </div>
        <div>
          <label class="lz-label">whisper Modell</label>
          <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
        </div>
        <div>
          <label class="lz-label">STT Sprache</label>
          <input v-model="sttLanguageModel" type="text" class="lz-input" />
        </div>
        <div></div>
        <div>
          <label class="lz-label">Piper Binary</label>
          <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
        </div>
        <div>
          <label class="lz-label">Piper Voice (.onnx)</label>
          <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
        </div>
      </div>
    </div>
  </div>
</template>
