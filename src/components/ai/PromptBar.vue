<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AiIcon from './AiIcon.vue'
import ThinkingSelector from './ThinkingSelector.vue'
import DropdownMenu, { type DropdownOption } from './DropdownMenu.vue'
import type { ThinkingTier } from '@/services/inference/thinking'
import type { ChatRouteMode } from '@/services/inference/modelUsageSettings'
import type { LuczorMode } from '@/services/openrouter.service'
import VoiceInputSettings from './VoiceInputSettings.vue'
import SearchList from './SearchList.vue'
import type { SearchItem } from './types'
const props = withDefaults(
  defineProps<{
    modelValue: string
    thinkingTier?: ThinkingTier
    routeMode?: ChatRouteMode
    externalAllowed?: boolean
    mode?: LuczorMode
    modeTitle?: string
    modeBusy?: boolean
    allowUnrestricted?: boolean
    busy?: boolean
    recording?: boolean
    listening?: boolean
    voiceBusy?: boolean
    placeholder?: string
    contextLabel?: string
    commands?: SearchItem[]
  }>(),
  {
    placeholder: 'Was möchtest du als Nächstes tun?',
    commands: () => [],
    contextLabel: '',
    externalAllowed: true,
    routeMode: 'local',
    thinkingTier: 'balanced',
    mode: 'observe',
    modeTitle: '',
    modeBusy: false,
    allowUnrestricted: false,
  }
)
const emit = defineEmits<{
  'update:thinkingTier': [value: ThinkingTier]
  'update:routeMode': [value: ChatRouteMode]
  'update:mode': [value: LuczorMode]
  'update:modelValue': [value: string]
  input: []
  send: []
  stop: []
  record: []
  listen: []
  'voice-start': [mode: 'push_to_talk' | 'hands_free']
  'voice-stop': []
  context: []
  command: [id: string]
}>()

/** The dropdown is the only writer; the parent owns the confirmation flow for "unrestricted" and may leave `mode` unchanged. */
function onMode(value: LuczorMode): void {
  if (value === 'observe' || value === 'act' || value === 'unrestricted') emit('update:mode', value)
}
function onRouteMode(value: ChatRouteMode): void {
  if (value === 'local' || value === 'auto' || value === 'external') emit('update:routeMode', value)
}
const modeOptions = computed<DropdownOption<LuczorMode>[]>(() => [
  { value: 'observe', label: 'Beobachten', description: 'Nur lesen und antworten – keine Werkzeuge.' },
  { value: 'act', label: 'Handeln', description: 'Werkzeuge mit Bestätigung je Aktion.', tone: 'success' },
  ...(props.allowUnrestricted
    ? [
        {
          value: 'unrestricted' as const,
          label: 'Vollzugriff',
          description: 'Werkzeuge ohne Rückfrage – nur nach ausdrücklicher Freigabe.',
          tone: 'danger' as const,
        },
      ]
    : []),
])
const routeOptions = computed<DropdownOption<ChatRouteMode>[]>(() => [
  {
    value: 'local',
    label: 'Lokal',
    description: 'Nur das lokale Modell; Inhalte bleiben auf dem Gerät.',
    tone: 'accent',
  },
  {
    value: 'auto',
    label: 'Lokal + extern',
    description: 'Lokal zuerst, externe Unterstützung bei Bedarf.',
    disabled: !props.externalAllowed,
  },
  {
    value: 'external',
    label: 'Nur extern',
    description: 'Externe Modelle bearbeiten die Anfrage.',
    disabled: !props.externalAllowed,
  },
])
/** The mode permits model routes; delegation is chosen for the actual request. */
const routeModeHint = computed(() => {
  if (!props.externalAllowed) return 'Externe Modelle zuerst unter Einstellungen → Chat & Agenten zulassen.'
  if (props.routeMode === 'external')
    return 'Externe Modelle bearbeiten die Anfrage und holen bei Bedarf Unterstützung hinzu.'
  if (props.routeMode === 'auto')
    return 'Das Chatmodell antwortet direkt oder zieht bei Bedarf lokale und externe Unterstützung hinzu.'
  return 'Das lokale Modell antwortet direkt oder übernimmt mehrere Arbeitsschritte. Inhalte bleiben lokal.'
})
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
        <button
          v-if="contextLabel"
          type="button"
          class="ai-prompt__context"
          :title="contextLabel"
          @click="emit('context')"
        >
          <AiIcon name="folder" :size="12" /><span>{{ contextLabel }}</span>
        </button>
        <div class="ai-prompt__controls">
          <DropdownMenu
            :model-value="mode"
            :options="modeOptions"
            label="Steuerungsmodus"
            heading="Steuerungsmodus"
            :title="modeTitle"
            :disabled="modeBusy"
            :trigger-class="`ai-mode-select is-${mode}`"
            @update:model-value="onMode"
          >
            <template #trigger>
              <span class="ai-mode-select__dot" aria-hidden="true" />
            </template>
          </DropdownMenu>
          <slot name="heading-start" />
          <VoiceInputSettings
            class="voice-input-settings--composer"
            compact
            :busy="busy || voiceBusy"
            :active="listening || recording"
            @start="emit('voice-start', $event)"
            @stop="emit('voice-stop')"
          />
          <DropdownMenu
            :model-value="externalAllowed ? routeMode : 'local'"
            :options="routeOptions"
            label="Erlaubte Modelle für diesen Chat"
            heading="Modelle"
            :title="routeModeHint"
            :disabled="busy"
            :trigger-class="`ai-route-mode${routeMode !== 'local' && externalAllowed ? ' is-active' : ''}`"
            :menu-width="260"
            @update:model-value="onRouteMode"
          >
            <template #trigger>
              <AiIcon name="shield" :size="13" />
            </template>
          </DropdownMenu>
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
            <AiIcon name="plus" :size="19" />
          </button>
          <ThinkingSelector
            :model-value="thinkingTier"
            :next-prompt="busy"
            @update:model-value="emit('update:thinkingTier', $event)"
          />
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
