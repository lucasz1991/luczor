<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import AiIcon from './AiIcon.vue'
import AudioTriggerSettings from './AudioTriggerSettings.vue'
import {
  getVoiceConfig,
  saveVoiceConfig,
  validateVoiceSettings,
  VOICE_DEFAULTS,
  type ResolvedVoiceSettings,
} from '@/services/voice/localVoice'

withDefaults(defineProps<{ busy?: boolean; active?: boolean; compact?: boolean }>(), { compact: false })
const emit = defineEmits<{ start: [mode: 'push_to_talk' | 'hands_free']; stop: [] }>()
const id = useId()
const open = ref(false)
const loading = ref(false)
const saving = ref(false)
const audioEnabled = ref(false)
const error = ref('')
const config = ref<ResolvedVoiceSettings>({ ...VOICE_DEFAULTS })
const seconds = computed({
  get: () => config.value.continuousSilenceMs / 1000,
  set: value => {
    config.value.continuousSilenceMs = Number(value) * 1000
  },
})
async function toggle() {
  open.value = !open.value
  if (!open.value) return
  loading.value = true
  error.value = ''
  try {
    config.value = await getVoiceConfig()
  } catch {
    error.value = 'Spracheinstellungen konnten nicht geladen werden. Bitte erneut öffnen.'
  } finally {
    loading.value = false
  }
}
async function save(start = false) {
  const invalid = validateVoiceSettings(config.value)
  if (invalid) {
    error.value = invalid
    return
  }
  saving.value = true
  error.value = ''
  try {
    emit('stop')
    await saveVoiceConfig(config.value)
    open.value = false
    if (start) emit('start', config.value.mode === 'push_to_talk' ? 'push_to_talk' : 'hands_free')
  } catch {
    error.value = 'Spracheinstellungen konnten nicht gespeichert werden.'
  } finally {
    saving.value = false
  }
}
</script>
<template>
  <div
    class="voice-input-settings"
    :class="{ 'voice-input-settings--compact': compact }"
    @keydown.esc.stop="open = false"
  >
    <button
      type="button"
      class="voice-settings-trigger"
      aria-label="Spracheingabe einstellen"
      title="Wake-Word, Close-Word und Wartezeit"
      :aria-expanded="open"
      :aria-controls="id"
      @click="toggle"
    >
      <AiIcon name="settings" :size="14" /><span v-if="!compact">Sprache</span>
    </button>
    <section
      v-if="open"
      :id="id"
      class="voice-settings-panel"
      aria-label="Einstellungen der Spracheingabe"
      @keydown.enter.stop="($event.target as HTMLElement).tagName === 'INPUT' && $event.preventDefault()"
    >
      <header>
        <strong>Spracheingabe</strong
        ><button type="button" aria-label="Spracheinstellungen schließen" @click="open = false">
          <AiIcon name="close" :size="16" />
        </button>
      </header>
      <p>Lokale Erkennung. Zuhören startet erst mit deinem Klick und gilt für dieses Eingabefeld.</p>
      <p v-if="loading" role="status">Einstellungen werden geladen …</p>
      <AudioTriggerSettings v-if="!loading" v-model:enabled="audioEnabled" @changed="emit('stop')" />
      <fieldset v-if="!loading" :disabled="saving">
        <label
          >Start<select v-model="config.mode">
            <option value="wakeword">Mit Wake-Word</option>
            <option value="continuous">Sofort diktieren</option>
            <option value="push_to_talk">Manuell starten / stoppen</option>
          </select></label
        >
        <label v-if="config.mode === 'wakeword' && !audioEnabled"
          >Wake-Word<input v-model="config.wakeWord" maxlength="80" placeholder="luczor"
        /></label>
        <template v-if="config.mode !== 'push_to_talk'">
          <label
            >Diktat beenden<select v-model="config.endMode">
              <option value="either">Close-Word oder Sprechpause</option>
              <option value="close_word">Nur Close-Word</option>
              <option value="silence">Nur Sprechpause</option>
            </select></label
          >
          <label v-if="config.endMode !== 'silence' && !audioEnabled"
            >Close-Word · beendet und sendet<input v-model="config.endPhrase" maxlength="80" placeholder="luczor stopp"
          /></label>
          <template v-if="config.endMode !== 'close_word'">
            <label
              >Wartezeit in Sekunden<input v-model.number="seconds" type="number" min="1" max="30" step="1"
            /></label>
            <label class="voice-settings-check"
              ><input v-model="config.autoSubmit" type="checkbox" />Nach Sprechpause automatisch senden</label
            >
            <p>
              Ausgeschaltet bleibt der Text zum Prüfen stehen. Automatisches Senden nach Pause gilt nur für vollständig
              diktierten Text.
            </p>
          </template>
        </template>
        <p v-if="config.mode === 'wakeword' && !audioEnabled">
          Beispiel: „{{ config.wakeWord }}, was steht heute an{{
            config.endMode !== 'silence' ? `, ${config.endPhrase}` : ''
          }}“. Nach Abschluss wartet Luczor wieder auf das Wake-Word.
        </p>
        <div class="voice-settings-actions">
          <button type="button" @click="save(false)">Speichern</button
          ><button type="button" :disabled="busy" class="voice-settings-start" @click="save(true)">
            Speichern & starten</button
          ><button v-if="active" type="button" @click="emit('stop')">Zuhören stoppen</button>
        </div>
      </fieldset>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>
<style scoped>
.voice-input-settings {
  position: relative;
}
.voice-input-settings--composer {
  position: static;
}
.voice-input-settings--compact .voice-settings-trigger {
  width: 28px;
  height: 28px;
  justify-content: center;
  padding: 0;
}
.voice-settings-trigger {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px;
  border: 1px solid #ffffff20;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
}
.voice-settings-panel {
  box-sizing: border-box;
  position: absolute;
  bottom: calc(100% + 12px);
  right: 0;
  width: min(350px, calc(100vw - 48px));
  max-height: min(580px, 70vh);
  overflow: auto;
  z-index: 70;
  background: #202124;
  border: 1px solid #ffffff28;
  border-radius: 14px;
  padding: 16px;
  box-shadow: 0 16px 44px #0008;
  color: #eee;
  text-align: left;
}
header,
.voice-settings-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
header button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
strong {
  font-size: 14px;
}
p {
  font-size: 12px;
  line-height: 1.5;
  color: #afb3bc;
  margin: 10px 0;
}
fieldset {
  padding: 0;
  margin: 0;
  border: 0;
  min-width: 0;
  display: grid;
  gap: 12px;
}
label {
  display: grid;
  gap: 5px;
  font-size: 12px;
}
select,
input:not([type='checkbox']) {
  width: 100%;
  box-sizing: border-box;
  background: #141518;
  border: 1px solid #ffffff30;
  border-radius: 7px;
  padding: 8px;
  color: inherit;
  font: inherit;
}
.voice-settings-check {
  display: flex;
  align-items: center;
  gap: 8px;
}
.voice-settings-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}
.voice-settings-actions button {
  padding: 8px 10px;
  border: 1px solid #ffffff30;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.voice-settings-actions .voice-settings-start {
  background: #3c3652;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
[role='alert'] {
  color: #ffc5c5;
}
</style>
