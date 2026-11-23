<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AiIcon from './AiIcon.vue'
import ModelSelector from './ModelSelector.vue'
import DropdownMenu, { type DropdownOption } from './DropdownMenu.vue'
import type { ThinkingTier } from '@/services/inference/thinking'
import { isClaudeRouteMode, type ChatRouteMode } from '@/services/inference/modelUsageSettings'
import type { ClaudeModelOption } from '@/services/inference/claudeMain'
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
    /** A verified Claude access exists and the server allows the Claude modes. */
    claudeAvailable?: boolean
    claudeModel?: string
    claudeModels?: readonly ClaudeModelOption[]
    /** Name of the local model answering in local modes and after a hand-over. */
    modelInfo?: string
    /** A Claude chat that the local model continues after a declined turn. */
    localContinuation?: boolean
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
    claudeAvailable: false,
    claudeModel: undefined,
    claudeModels: () => [],
    modelInfo: '',
    localContinuation: false,
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
  'update:claudeModel': [value: string]
  'resume-claude': []
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
  if (value === 'local' || value === 'auto' || value === 'external' || isClaudeRouteMode(value))
    emit('update:routeMode', value)
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
    tone: 'success',
    group: 'Lokales Modell führt',
  },
  {
    value: 'auto',
    label: 'Lokal + extern',
    description: 'Lokal zuerst, externe Unterstützung bei Bedarf.',
    disabled: !props.externalAllowed,
    group: 'Lokales Modell führt',
  },
  {
    value: 'claude_local',
    label: 'Claude + lokal',
    description: 'Claude führt; das lokale Modell übernimmt bei Ablehnung.',
    tone: 'accent',
    disabled: !props.claudeAvailable,
    group: 'Claude führt',
  },
  {
    value: 'claude',
    label: 'Nur Claude',
    description: 'Claude führt ohne lokales Modell.',
    tone: 'accent',
    disabled: !props.claudeAvailable,
    group: 'Claude führt',
  },
  {
    value: 'external',
    label: 'Nur extern',
    description: 'Externe Modelle bearbeiten die Anfrage.',
    disabled: !props.externalAllowed,
    group: 'Externe Modelle führen',
  },
])
/** A stored mode whose access is switched off must never look or act as if it were active. */
const effectiveRouteMode = computed<ChatRouteMode>(() => {
  if (isClaudeRouteMode(props.routeMode)) return props.claudeAvailable ? props.routeMode : 'local'
  if (props.routeMode === 'auto' || props.routeMode === 'external')
    return props.externalAllowed ? props.routeMode : 'local'
  return 'local'
})
/** The mode permits model routes; delegation is chosen for the actual request. */
const routeModeHint = computed(() => {
  if (isClaudeRouteMode(props.routeMode) && !props.claudeAvailable)
    return 'Claude-Zugang zuerst unter Einstellungen → Claude API einrichten.'
  switch (effectiveRouteMode.value) {
    case 'claude_local':
      return 'Claude führt den Chat. Lehnt Claude eine Anfrage ab, übernimmt das lokale Modell auf diesem Gerät.'
    case 'claude':
      return 'Claude führt den Chat ohne lokales Modell. Bei einer Ablehnung entscheidest du, wie es weitergeht.'
    case 'external':
      return 'Externe Modelle bearbeiten die Anfrage und holen bei Bedarf Unterstützung hinzu.'
    case 'auto':
      return 'Das Chatmodell antwortet direkt oder zieht bei Bedarf lokale und externe Unterstützung hinzu.'
    default:
      break
  }
  if (!props.externalAllowed) return 'Externe Modelle zuerst unter Einstellungen → Chat & Agenten zulassen.'
  return 'Das lokale Modell antwortet direkt oder übernimmt mehrere Arbeitsschritte. Inhalte bleiben lokal.'
})
/** Claude leads only while the chat has not been handed over to the local model. */
const claudeLeads = computed(() => isClaudeRouteMode(effectiveRouteMode.value) && !props.localContinuation)
const modelProvider = computed<'claude' | 'local' | 'external'>(() => {
  if (props.localContinuation) return 'local'
  if (claudeLeads.value) return 'claude'
  return effectiveRouteMode.value === 'external' ? 'external' : 'local'
})
const modelLabel = computed(() =>
  modelProvider.value === 'external' ? 'Extern · Serverauswahl' : props.modelInfo.trim() || 'Lokales Modell'
)
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
    <div v-if="localContinuation" class="ai-prompt__continuation" role="status">
      <span>Dieser Chat wird lokal fortgeführt, damit Folgefragen den vollständigen Verlauf sehen.</span>
      <button type="button" class="ai-prompt__continuation-action" :disabled="busy" @click="emit('resume-claude')">
        Wieder Claude verwenden
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
            align="end"
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
            :model-value="effectiveRouteMode"
            :options="routeOptions"
            label="Erlaubte Modelle für diesen Chat"
            heading="Modelle"
            align="end"
            :title="routeModeHint"
            :disabled="busy"
            :trigger-class="`ai-route-mode${effectiveRouteMode !== 'local' ? ' is-active' : ''}`"
            :menu-width="300"
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
          <ModelSelector
            :thinking-tier="thinkingTier"
            :next-prompt="busy"
            :claude-mode="claudeLeads"
            :models="claudeModels"
            :model="claudeModel"
            :info="modelLabel"
            :provider="modelProvider"
            :specialist="localContinuation"
            @update:thinking-tier="emit('update:thinkingTier', $event)"
            @update:model="emit('update:claudeModel', $event)"
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
<style scoped>
/* Slim notice above the composer while a Claude chat is continued by the local model. */
.ai-prompt__continuation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  padding: 8px 8px 8px 14px;
  border: 1px solid color-mix(in srgb, var(--success, #6cb98a) 32%, transparent);
  border-radius: 12px;
  background: var(--success-wash, rgba(108, 185, 138, 0.12));
  color: var(--text-secondary, var(--ai-text-muted, #a3a5af));
  font-size: 12.5px;
  line-height: 1.5;
}
.ai-prompt__continuation > span {
  min-width: 0;
}
/* Lets the model label shrink with an ellipsis instead of pushing the send controls out. */
.ai-prompt__toolbar > div:first-child {
  min-width: 0;
}
.ai-prompt__continuation-action {
  flex: none;
  padding: 7px 13px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary, var(--ai-text, #e9eaf0));
  font: 600 12px var(--ai-font, inherit);
  cursor: pointer;
  transition:
    background 180ms var(--ease, ease),
    border-color 180ms var(--ease, ease);
}
.ai-prompt__continuation-action:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.16);
}
.ai-prompt__continuation-action:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
.ai-prompt__continuation-action:disabled {
  opacity: 0.55;
  cursor: default;
}
@media (max-width: 560px) {
  .ai-prompt__continuation {
    flex-direction: column;
    align-items: stretch;
    padding: 9px 10px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-prompt__continuation-action {
    transition: none;
  }
}
</style>
