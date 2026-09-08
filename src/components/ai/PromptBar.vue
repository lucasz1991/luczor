<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AiIcon from './AiIcon.vue'
import VoiceInputSettings from './VoiceInputSettings.vue'
import SearchList from './SearchList.vue'
import type { SearchItem } from './types'
const props = withDefaults(
  defineProps<{
    modelValue: string
    agentMode?: boolean
    externalFallback?: boolean
    busy?: boolean
    recording?: boolean
    listening?: boolean
    voiceBusy?: boolean
    placeholder?: string
    modelLabel?: string
    contextLabel?: string
    commands?: SearchItem[]
  }>(),
  { placeholder: 'Was möchtest du als Nächstes tun?', modelLabel: 'Automatisch', commands: () => [], contextLabel: '' }
)
const emit = defineEmits<{
  'update:agentMode': [value: boolean]
  'update:externalFallback': [value: boolean]
  'update:modelValue': [value: string]
  input: []
  send: []
  stop: []
  record: []
  listen: []
  'voice-start': [mode: 'push_to_talk' | 'hands_free']
  'voice-stop': []
  model: []
  context: []
  command: [id: string]
}>()
const field = ref<HTMLTextAreaElement | null>(null)
const menu = ref(false)
const commandsDismissed = ref(false)
const showCommands = computed(
  () => !commandsDismissed.value && (menu.value || (props.modelValue.startsWith('/') && props.commands.length > 0))
)
function grow() {
  if (field.value) {
    field.value.style.height = 'auto'
    field.value.style.height = `${Math.min(field.value.scrollHeight, 180)}px`
  }
}
watch(
  () => props.modelValue,
  () => {
    void nextTick(grow)
  },
  { immediate: true }
)
function onInput(event: Event) {
  commandsDismissed.value = false
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
  emit('input')
  grow()
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeCommands()
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!props.busy && props.modelValue.trim()) emit('send')
}
function select(id: string) {
  menu.value = false
  commandsDismissed.value = true
  emit('command', id)
  // Commands may open a modal. Let that surface keep keyboard focus.
  if (id === 'summarize') void nextTick(() => field.value?.focus())
}
function closeCommands() {
  menu.value = false
  commandsDismissed.value = true
}
function toggleCommands() {
  const open = !showCommands.value
  commandsDismissed.value = !open
  menu.value = open
}
defineExpose({ focus: () => field.value?.focus() })
</script>
<template>
  <div class="ai-prompt-wrap">
    <div v-if="showCommands" class="ai-command-menu">
      <SearchList :items="commands" placeholder="Aktion suchen" @select="select" /><button
        type="button"
        class="ai-icon-button"
        @click="closeCommands"
      >
        Schließen
      </button>
    </div>
    <div class="ai-prompt" :class="{ 'is-busy': busy }">
      <div class="ai-prompt__heading">
        <button v-if="contextLabel" type="button" class="ai-prompt__context" @click="emit('context')">
          <AiIcon name="folder" :size="13" />{{ contextLabel }}
        </button>
        <div class="ai-prompt__controls">
          <VoiceInputSettings
            class="voice-input-settings--composer"
            :busy="busy || voiceBusy"
            :active="listening || recording"
            @start="emit('voice-start', $event)"
            @stop="emit('voice-stop')"
          />
          <button
            type="button"
            class="ai-agent-mode"
            :class="{ 'is-active': externalFallback }"
            :aria-pressed="!!externalFallback"
            :disabled="busy"
            aria-label="Externen Fallback nach Freigabe erlauben"
            title="Erlaubt nach einer ausdrücklichen Freigabe den Wechsel vom lokalen Modell zu einem externen Modell"
            @click="emit('update:externalFallback', !externalFallback)"
          >
            <AiIcon name="shield" :size="13" />Fallback
          </button>
          <button
            type="button"
            class="ai-agent-mode"
            :class="{ 'is-active': agentMode }"
            :aria-pressed="!!agentMode"
            :disabled="busy"
            aria-label="Agentenmodus"
            title="Aktiv: Neue Aufträge direkt mit einem Agententeam bearbeiten"
            @click="emit('update:agentMode', !agentMode)"
          >
            <AiIcon name="grid" :size="13" />Agenten
          </button>
        </div>
      </div>
      <textarea
        ref="field"
        :value="modelValue"
        rows="1"
        :placeholder="placeholder"
        aria-label="Nachricht an Luczor"
        @input="onInput"
        @keydown="onKey"
      />
      <div class="ai-prompt__toolbar">
        <div>
          <button
            type="button"
            class="ai-icon-button"
            title="Aktionen"
            aria-label="Aktionen öffnen"
            :aria-expanded="showCommands"
            @click="toggleCommands"
          >
            <AiIcon name="plus" :size="19" /></button
          ><button type="button" class="ai-model-button" title="Modelleinstellungen öffnen" @click="emit('model')">
            <AiIcon :size="13" /><span>{{ modelLabel }}</span
            ><AiIcon name="chevron" :size="11" />
          </button>
        </div>
        <div>
          <button
            type="button"
            class="ai-icon-button"
            :class="{ 'is-active': listening }"
            :aria-label="listening ? 'Zuhören stoppen' : 'Zuhören mit Spracheinstellungen starten'"
            :aria-pressed="!!listening"
            :disabled="voiceBusy || (busy && !listening)"
            @click="emit('listen')"
          >
            <AiIcon name="sound" /></button
          ><button
            type="button"
            class="ai-icon-button"
            :disabled="voiceBusy || (busy && !recording)"
            :class="{ 'is-active': recording }"
            :aria-label="recording ? 'Aufnahme stoppen' : 'Push-to-Talk starten'"
            :aria-pressed="!!recording"
            @click="emit('record')"
          >
            <AiIcon :name="recording ? 'stop' : 'mic'" /></button
          ><button
            v-if="busy"
            type="button"
            class="ai-send ai-send--stop"
            aria-label="Generierung stoppen"
            @click="emit('stop')"
          >
            <AiIcon name="stop" /></button
          ><button
            v-else
            type="button"
            class="ai-send"
            :disabled="!modelValue.trim()"
            aria-label="Nachricht senden"
            @click="emit('send')"
          >
            <AiIcon name="send" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
