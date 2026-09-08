<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useVoiceInputOwnership } from '@/composables/useVoiceInputOwnership'
import {
  loadAudioTriggers,
  saveAudioTriggers,
  recordAudioTrigger,
  matchAudioTrigger,
  type AudioTriggers,
  type AudioTriggerKind,
} from '@/services/voice/audioTriggers'
const config = ref<AudioTriggers>({ enabled: false })
const emit = defineEmits<{ 'update:enabled': [enabled: boolean]; changed: [] }>()
const recording = ref<AudioTriggerKind | null>(null)
const loading = ref(true)
const checking = ref(false)
const message = ref('')
let capture: Awaited<ReturnType<typeof recordAudioTrigger>> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
const stop = () => {
  generation++
  clearTimeout(timer)
  capture?.cancel()
  capture = undefined
  recording.value = null
}
const claim = useVoiceInputOwnership(stop)
onMounted(async () => {
  try {
    config.value = await loadAudioTriggers()
    emit('update:enabled', config.value.enabled)
  } catch {
    message.value = 'Audio-Auslöser konnten nicht geladen werden. Bitte neu aufnehmen.'
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(stop)
async function record(kind: AudioTriggerKind, probe = false) {
  if (recording.value) {
    await finish()
    return
  }
  stop()
  checking.value = probe
  const own = generation
  message.value = 'Mikrofon wird geöffnet …'
  try {
    await claim()
    const next = await recordAudioTrigger()
    if (generation !== own) {
      next.cancel()
      return
    }
    capture = next
    recording.value = kind
    message.value = 'Jetzt nur das Wort oder die kurze Phrase sprechen, dann Aufnahme beenden.'
    timer = setTimeout(() => {
      void finish()
    }, 5000)
  } catch {
    message.value = 'Aufnahme konnte nicht starten. Bitte Mikrofonberechtigung prüfen.'
  }
}
async function finish() {
  const kind = recording.value,
    current = capture
  if (!kind || !current) return
  clearTimeout(timer)
  recording.value = null
  capture = undefined
  try {
    const sample = await current.finish()
    if (checking.value) {
      message.value = matchAudioTrigger(sample.wav, { ...config.value, enabled: true }, kind)
        ? 'Probe erkannt. Der passende Audio-Auslöser wurde ohne Absenden bestätigt.'
        : 'Probe nicht eindeutig erkannt. Bitte in gleichem Abstand sprechen oder die Referenz neu aufnehmen.'
      return
    }
    const next = { ...config.value, [kind]: sample }
    await saveAudioTriggers(next)
    config.value = next
    emit('update:enabled', next.enabled)
    emit('changed')
    message.value = 'Aufnahme lokal gespeichert. Mit „Probe erkennen“ kannst du sie prüfen.'
  } catch (error) {
    message.value = error instanceof Error ? error.message : 'Aufnahme fehlgeschlagen.'
  }
}
async function enabled(event: Event) {
  stop()
  try {
    const next = { ...config.value, enabled: (event.target as HTMLInputElement).checked }
    await saveAudioTriggers(next)
    config.value = next
    emit('update:enabled', next.enabled)
    emit('changed')
    message.value = next.enabled
      ? 'Audio-Auslöser aktiv. Zum Zuhören anschließend „Speichern & starten“ wählen.'
      : 'Texterkennung der Steuerwörter aktiv.'
  } catch (error) {
    ;(event.target as HTMLInputElement).checked = config.value.enabled
    message.value = error instanceof Error ? error.message : 'Speichern fehlgeschlagen.'
  }
}
async function remove(kind: AudioTriggerKind) {
  stop()
  try {
    const next = { ...config.value, enabled: false }
    if (kind === 'wake') delete next.wake
    else delete next.close
    await saveAudioTriggers(next)
    config.value = next
    emit('update:enabled', next.enabled)
    emit('changed')
    message.value = 'Aufnahme gelöscht. Audiomodus ausgeschaltet.'
  } catch {
    message.value = 'Aufnahme konnte nicht gelöscht werden.'
  }
}
</script>
<template>
  <div class="audio-trigger-settings">
    <strong>Eigene Audio-Auslöser</strong>
    <p>
      Sprich Start und Stopp einzeln mit einer kurzen Pause danach. Die Aufnahmen bleiben auf diesem Gerät; der Klang
      wird direkt verglichen. Deutlich unterschiedliche Wörter funktionieren besser.
    </p>
    <div v-for="kind in ['wake', 'close'] as const" :key="kind" class="audio-trigger-row">
      <span
        >{{ kind === 'wake' ? 'Audio-Startwort' : 'Audio-Stoppwort' }} ·
        {{ config[kind] ? 'gespeichert' : 'fehlt' }}</span
      >
      <button type="button" :disabled="loading || (!!recording && recording !== kind)" @click="record(kind)">
        {{ recording === kind ? 'Aufnahme beenden' : config[kind] ? 'Neu aufnehmen' : 'Aufnehmen' }}
      </button>
      <button v-if="config[kind]" type="button" :disabled="!!recording" @click="record(kind, true)">
        Probe erkennen
      </button>
      <audio
        v-if="config[kind]"
        controls
        preload="none"
        :src="`data:audio/wav;base64,${config[kind]!.wav}`"
        :aria-label="kind === 'wake' ? 'Startwort anhören' : 'Stoppwort anhören'"
      />
      <button v-if="config[kind]" type="button" :disabled="!!recording" @click="remove(kind)">Löschen</button>
    </div>
    <label
      ><input
        type="checkbox"
        :checked="config.enabled"
        :disabled="loading || !!recording || !config.wake || !config.close"
        @change="enabled"
      />Aufgenommene Audio-Auslöser statt Textwörter verwenden</label
    >
    <p v-if="message" role="status">{{ message }}</p>
  </div>
</template>
<style scoped>
.audio-trigger-settings {
  border-top: 1px solid #ffffff25;
  padding-top: 12px;
  margin-top: 8px;
  display: grid;
  gap: 10px;
}
strong,
span,
label,
button {
  font-size: 12px;
}
p {
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
  color: #b6bac5;
}
.audio-trigger-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
button {
  color: inherit;
  background: transparent;
  border: 1px solid #ffffff30;
  border-radius: 6px;
  padding: 7px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
}
audio {
  width: 100%;
  height: 30px;
}
label {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
</style>
