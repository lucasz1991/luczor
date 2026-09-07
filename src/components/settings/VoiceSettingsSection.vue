<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { loadSpeechVoices, type SpeechVoice } from '@/services/voice/voiceCatalog'
import { MAX_VOICE_PHRASE_CHARS, validateVoiceSettings, type VoiceMode } from '@/services/voice/localVoice'
import type { SpeakResult } from '@/services/voice/speak'
import { hud } from '@/state/hud'

const props = defineProps<{
  deviceKey: string
  voiceMode: VoiceMode
  wakeWord: string
  endPhrase: string
  continuousSilenceMs: number
  autoSubmit: boolean
  sttLanguage: string
  voiceId?: string
  testSpeech: (text: string, signal?: AbortSignal, voiceId?: string) => Promise<SpeakResult>
}>()

const emit = defineEmits<{
  (event: 'update:voiceMode', value: VoiceMode): void
  (event: 'update:wakeWord', value: string): void
  (event: 'update:endPhrase', value: string): void
  (event: 'update:continuousSilenceMs', value: number): void
  (event: 'update:autoSubmit', value: boolean): void
  (event: 'update:sttLanguage', value: string): void
  (event: 'update:voiceId', value: string): void
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
const endPhraseModel = computed({
  get: () => props.endPhrase,
  set: value => emit('update:endPhrase', value),
})
const continuousSilenceSeconds = computed({
  get: () => props.continuousSilenceMs / 1000,
  set: value => emit('update:continuousSilenceMs', Number(value) * 1000),
})
const voiceValidationError = computed(() =>
  validateVoiceSettings({
    wakeWord: props.wakeWord,
    endPhrase: props.endPhrase,
    continuousSilenceMs: props.continuousSilenceMs,
  })
)

const testing = ref(false)
const voices = ref<SpeechVoice[]>([])
const voicesLoading = ref(false)
const voicesError = ref('')
let catalogController: AbortController | null = null
const voiceIdModel = computed({ get: () => props.voiceId ?? '', set: value => emit('update:voiceId', value) })
const selectedVoiceMissing = computed(
  () =>
    !!voiceIdModel.value &&
    voiceIdModel.value !== 'piper' &&
    !voices.value.some(voice => voice.id === voiceIdModel.value)
)
async function refreshVoices() {
  catalogController?.abort()
  const controller = new AbortController()
  catalogController = controller
  voicesLoading.value = true
  voicesError.value = ''
  try {
    const catalog = await loadSpeechVoices(controller.signal)
    if (!controller.signal.aborted) voices.value = catalog
  } catch {
    if (!controller.signal.aborted)
      voicesError.value = 'Stimmen konnten nicht geladen werden. Bitte gespeicherten Server und Verbindung prüfen.'
  } finally {
    if (catalogController === controller) voicesLoading.value = false
  }
}
watch(
  () => props.deviceKey,
  value => {
    if (value.trim()) void refreshVoices()
  },
  { immediate: true }
)
const testStatus = ref('')
const visibleTestStatus = computed(() =>
  testing.value && hud.status === 'speaking' ? 'Sprachtest wird wiedergegeben …' : testStatus.value
)
let testController: AbortController | null = null

async function toggleSpeechTest(): Promise<void> {
  if (testing.value) {
    testController?.abort()
    return
  }
  const controller = new AbortController()
  testController = controller
  testing.value = true
  testStatus.value = 'Server-Sprachausgabe wird vorbereitet …'
  try {
    const result = await props.testSpeech(
      'Hallo! Luczor verwendet jetzt den gemeinsamen Sprachdienst auf deinem Server.',
      controller.signal,
      voiceIdModel.value
    )
    testStatus.value = result === 'cancelled' ? 'Sprachtest abgebrochen.' : 'Sprachtest abgeschlossen.'
  } catch (error) {
    testStatus.value = error instanceof Error ? error.message : 'Die Server-Sprachausgabe ist nicht verfügbar.'
  } finally {
    testing.value = false
    testController = null
  }
}

onBeforeUnmount(() => {
  testController?.abort()
  catalogController?.abort()
})
</script>

<template>
  <div class="lz-section">
    <div class="lz-section__head">
      <h3>Sprache</h3>
      <p>
        Die Spracheingabe läuft lokal mit whisper.cpp. Für die Sprachausgabe wird der Text an deinen Luczor-Server und
        dessen gemeinsamen Sprachdienst für FollowFlow und RailTime gesendet.
      </p>
    </div>
    <div v-if="!deviceKey.trim()" class="lz-voice-warning" role="alert">
      <div>
        <div class="lz-card__title">Device-Key für die Server-Sprachausgabe fehlt</div>
        <p class="lz-hint">
          Die Sprachausgabe benötigt bei jeder Anfrage eine Serververbindung und einen gespeicherten Device-Key. Dieser
          wird auch für die erste Installation der lokalen Spracheingabe verwendet.
        </p>
      </div>
      <button type="button" class="lz-btn lz-btn--ghost" @click="emit('openServer')">Device-Key hinterlegen</button>
    </div>
    <div class="lz-card">
      <div class="lz-card__title">Sprachausgabe über den gemeinsamen Server</div>
      <p class="lz-hint">
        Wähle eine für Luczor freigegebene V2-Stimme oder die bisherige Piper-Stimme. Die Auswahl gilt für Antworten und
        Zwischenkommentare. Der Sprachtest nutzt die gewählte Stimme sofort; zum dauerhaften Übernehmen speichern.
      </p>
      <label for="voice-output-id" class="lz-label">Vorlesestimme</label>
      <select id="voice-output-id" v-model="voiceIdModel" class="lz-input" :disabled="testing">
        <option value="">Piper · bisherige Standardstimme</option>
        <option v-if="voiceIdModel === 'piper'" value="piper">Piper · Standardstimme</option>
        <option v-if="selectedVoiceMissing" :value="voiceIdModel" disabled>
          Gespeicherte Stimme nicht im aktuellen Katalog ({{ voiceIdModel }})
        </option>
        <option v-for="voice in voices.filter(item => item.provider === 'pocket')" :key="voice.id" :value="voice.id">
          {{ voice.name }} · V2
        </option>
      </select>
      <button
        type="button"
        class="lz-btn lz-btn--ghost"
        :disabled="voicesLoading || !deviceKey.trim()"
        @click="refreshVoices"
      >
        {{ voicesLoading ? 'Stimmen werden geladen …' : 'Stimmen aktualisieren' }}
      </button>
      <p v-if="voicesError" class="lz-hint" role="status">{{ voicesError }}</p>
      <p v-if="selectedVoiceMissing && !voicesLoading" class="lz-hint" role="status">
        Die gespeicherte Stimme ist momentan nicht verfügbar. Wähle eine verfügbare Stimme; Luczor wechselt nicht
        automatisch zu einer anderen.
      </p>
      <button
        type="button"
        class="lz-btn lz-btn--ghost"
        :disabled="(!deviceKey.trim() || selectedVoiceMissing) && !testing"
        @click="toggleSpeechTest"
      >
        {{ testing ? 'Sprachtest stoppen' : 'Sprachausgabe testen' }}
      </button>
      <p v-if="visibleTestStatus" class="lz-hint" role="status" aria-live="polite">{{ visibleTestStatus }}</p>
    </div>
    <div class="lz-card">
      <div class="lz-card__title">Spracheingabe und Diktatabschluss</div>
      <p class="lz-hint">
        Wake-Word startet das Diktat nach dem Startwort. Dauer-Zuhören beginnt direkt und schließt das Diktat nach der
        eingestellten Stille ab. Das bestätigte Close-Word beendet in beiden Modi das aktuelle Diktat und sendet den
        fertigen Eingabetext automatisch.
      </p>
      <div class="lz-grid2">
        <div>
          <label for="voice-input-mode" class="lz-label">Eingabe-Modus</label>
          <select id="voice-input-mode" v-model="voiceModeModel" class="lz-input">
            <option value="push_to_talk">Push-to-Talk</option>
            <option value="continuous">Dauer-Zuhören</option>
            <option value="wakeword">Wake-Word</option>
          </select>
        </div>
        <div>
          <label for="voice-wake-word" class="lz-label">Wake-Word</label>
          <input
            id="voice-wake-word"
            v-model="wakeWordModel"
            type="text"
            class="lz-input"
            :maxlength="MAX_VOICE_PHRASE_CHARS"
            :disabled="voiceMode !== 'wakeword'"
          />
          <p class="lz-hint">Dieses Startwort wird auch tatsächlich für die Erkennung verwendet.</p>
        </div>
        <div>
          <label for="voice-close-word" class="lz-label">Close-Word / Diktat beenden und senden</label>
          <input
            id="voice-close-word"
            v-model="endPhraseModel"
            type="text"
            class="lz-input"
            :maxlength="MAX_VOICE_PHRASE_CHARS"
            :disabled="voiceMode === 'push_to_talk'"
          />
          <p class="lz-hint">
            Zum Beispiel „luczor stopp“. Sendet den fertigen Text ohne weiteren Klick, einschließlich vorhandenen Texts
            im Eingabefeld. Start- und Schlusswort werden nicht übernommen. Tippen stoppt die Aufnahme.
          </p>
        </div>
        <div>
          <label for="voice-silence-seconds" class="lz-label">Stille bis zum Diktatabschluss (Sekunden)</label>
          <input
            id="voice-silence-seconds"
            v-model.number="continuousSilenceSeconds"
            type="number"
            class="lz-input"
            min="1"
            max="30"
            step="1"
            :disabled="voiceMode !== 'continuous'"
          />
          <p class="lz-hint">Im Modus Dauer-Zuhören: 1 bis 30 Sekunden, Standard 5 Sekunden.</p>
        </div>
        <div>
          <label for="voice-stt-language" class="lz-label">Sprache der lokalen Erkennung (STT)</label>
          <input id="voice-stt-language" v-model="sttLanguageModel" type="text" class="lz-input" placeholder="de" />
        </div>
      </div>
      <p v-if="voiceValidationError" class="lz-result is-fail" role="alert">{{ voiceValidationError }}</p>
      <div class="lz-row">
        <span id="voice-auto-submit-label" class="lz-rowlabel">Auch nach Sprechpause automatisch senden</span>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': autoSubmit }"
          role="switch"
          :aria-checked="autoSubmit"
          :disabled="voiceMode !== 'continuous'"
          aria-labelledby="voice-auto-submit-label"
          aria-describedby="voice-auto-submit-hint"
          @click="emit('update:autoSubmit', !autoSubmit)"
        >
          <span />
        </button>
      </div>
      <p id="voice-auto-submit-hint" class="lz-hint">
        Nur für Dauer-Zuhören, standardmäßig aus: Eine Sprechpause lässt den Text zum Prüfen stehen. Das bestätigte
        Close-Word sendet unabhängig von diesem Schalter automatisch. Gesendete Texte können Agentenaktionen auslösen.
      </p>
    </div>
  </div>
</template>
