<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import StatusOrb from './StatusOrb.vue'
import AiIcon from '../ai/AiIcon.vue'
import VoiceInputSettings from '../ai/VoiceInputSettings.vue'
import { createVoiceInputSession, idleVoiceInput, type VoiceInputMode } from '@/services/voice/voiceInputSession'
import { VoiceEngine } from '@/services/voice/voiceEngine'
import { ensureVoiceRuntime, getVoiceConfig, handsFreeFromVoice, localStt } from '@/services/voice/localVoice'
import { useVoiceInputOwnership } from '@/composables/useVoiceInputOwnership'
import { stopSpeak } from '@/services/voice/speak'
import { loadAudioTriggers } from '@/services/voice/audioTriggers'
import ChatComposer from '../ai/ChatComposer.vue'
import StreamingText from '../ai/StreamingText.vue'
import ChatCommentary from '../ai/ChatCommentary.vue'
import TokenCounter from '../ai/TokenCounter.vue'
import ThinkingState from '../ai/ThinkingState.vue'
import ThinkingSelector from '../ai/ThinkingSelector.vue'
import ThinkingBudgetControl from '../ai/ThinkingBudgetControl.vue'
import type { ThinkingControlAction } from '@/services/inference/thinking'
import ApprovalCard from '../ai/ApprovalCard.vue'
import ToolChips from '../ai/ToolChips.vue'
import WorkflowChatCards from '../workflows/WorkflowChatCards.vue'
import { miniStatus } from '@/services/miniChat/presentation'
import type { MiniAction, MiniSnapshot, MiniPanel, MiniView } from '@/services/miniChat/types'
import type { ActivityStatus } from '../ai/types'
import { useClipboard } from '@/composables/useClipboard'

const props = withDefaults(defineProps<{ snapshot: MiniSnapshot; native?: boolean; connectionError?: string }>(), {
  connectionError: '',
})
const emit = defineEmits<{ action: [action: MiniAction]; hide: []; showMain: [] }>()
const expanded = ref(false)
async function controlThinking(requestId: string, action: ThinkingControlAction, sequence: number) {
  if (props.connectionError || props.snapshot.thinkingBudget?.requestId !== requestId)
    throw new Error('Die Verbindung zum aktiven Auftrag ist nicht verfügbar.')
  emit('action', { type: 'thinking_control', sessionId: props.snapshot.sessionId, requestId, action, sequence })
}
const pinned = ref(true)
const draft = ref('')
const drafts = new Map<string, string>()
const draftKey = computed(
  () =>
    `${props.snapshot.view}:${props.snapshot.view === 'chat' ? (props.snapshot.project?.id ?? 'none') : 'workspace'}`
)
const isChat = computed(() => props.snapshot.view === 'chat')
const contextName = computed(() => (isChat.value ? 'Projektchat' : 'Workspace'))
const awaitingSend = ref('')
const { copy, copied, error: clipboardError } = useClipboard()
let sendTimer: ReturnType<typeof setTimeout> | undefined
let sentAt = 0
const unread = ref(false)
const peek = ref('')
const showLegend = ref(false)
const resetConfirm = ref(false)
const windowError = ref('')
const box = ref<HTMLElement | null>(null)
const field = ref<HTMLTextAreaElement | null>(null)
const right = ref(20)
const bottom = ref(20)
let surfaceResize: ResizeObserver | undefined
let peekTimer: ReturnType<typeof setTimeout> | undefined
let drag: {
  startX: number
  startY: number
  right: number
  bottom: number
  pointer: number
  nativeStarted: boolean
} | null = null
let dragged = false
const decision = computed(() => props.snapshot.decision ?? props.snapshot.mainDecision)
const status = computed(() => miniStatus(props.snapshot, unread.value))
const peekVisible = computed(() => !expanded.value && (!!decision.value || !!peek.value))
const surfaceStyle = computed(() => ({
  ...(props.native ? {} : { right: `${right.value}px`, bottom: `${bottom.value}px` }),
  ...(props.snapshot.appearance?.accent && /^#[0-9a-f]{6}$/i.test(props.snapshot.appearance.accent)
    ? { '--cy-bright': props.snapshot.appearance.accent }
    : {}),
}))
const toolStatus: Record<string, ActivityStatus> = {
  proposed: 'waiting',
  approved: 'pending',
  executing: 'running',
  executed: 'done',
  failed: 'failed',
  rejected: 'canceled',
  canceled: 'canceled',
}
const tools = computed(() =>
  props.snapshot.tools.map(tool => ({ id: tool.id, label: tool.name, status: toolStatus[tool.status] ?? 'pending' }))
)
const lastAssistant = computed(() =>
  [...props.snapshot.messages].reverse().find(message => message.role === 'assistant')
)
const disabled = computed(
  () =>
    props.snapshot.busy ||
    props.snapshot.mainBusy ||
    !props.snapshot.sessionId ||
    !!props.connectionError ||
    !!awaitingSend.value
)
const voiceView = ref(idleVoiceInput())
const miniVoice = createVoiceInputSession({
  engine: new VoiceEngine(),
  readInput: () => draft.value,
  writeInput: text => {
    draft.value = text
  },
  scope: () => props.snapshot.sessionId,
  busy: () => disabled.value,
  config: async () => {
    const voice = await getVoiceConfig()
    return { voice, handsFree: handsFreeFromVoice(voice), bargeIn: false, audioTriggers: await loadAudioTriggers() }
  },
  prepare: async () => {
    await claimVoiceInput()
    await ensureVoiceRuntime('stt')
  },
  transcribe: localStt,
  stopOutput: stopSpeak,
  submit: async () => {
    send()
  },
  changed: value => {
    voiceView.value = value
  },
})
const claimVoiceInput = useVoiceInputOwnership(() => {
  void miniVoice.stop()
})
async function toggleVoice(mode: VoiceInputMode) {
  if (voiceView.value.mode === mode) await miniVoice.finish()
  else await miniVoice.start(mode)
}
watch(
  () => props.snapshot.sessionId,
  () => {
    void miniVoice.stop()
  },
  { flush: 'sync' }
)
watch(
  () => disabled.value || props.snapshot.hud.status === 'speaking' || props.snapshot.hud.killSwitch,
  muted => miniVoice.setMuted(muted),
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  void miniVoice.stop()
})
const error = computed(() => props.connectionError || windowError.value || props.snapshot.notice)
const compactWorking = computed(
  () =>
    ['thinking', 'executing', 'listening', 'speaking'].includes(status.value.phase) ||
    props.snapshot.busy ||
    props.snapshot.mainBusy
)

async function windowAction(action: string) {
  if (action === 'hide') await miniVoice.stop()
  if (!props.native) {
    if (action === 'hide') emit('hide')
    if (action === 'main') emit('showMain')
    return
  }
  try {
    await invoke('mini_chat_window', { action })
    windowError.value = ''
  } catch {
    windowError.value = 'Die Fensteraktion konnte nicht ausgeführt werden.'
  }
}
let resizeQueue = Promise.resolve()
function layout() {
  if (props.native) {
    const action = expanded.value ? 'expand' : peekVisible.value ? 'peek' : 'collapse'
    resizeQueue = resizeQueue.then(() => windowAction(action))
  } else void nextTick(clampPosition)
}
function clampPosition() {
  if (props.native || !box.value) return
  right.value = Math.max(0, Math.min(right.value, window.innerWidth - box.value.offsetWidth))
  bottom.value = Math.max(0, Math.min(bottom.value, window.innerHeight - box.value.offsetHeight))
}
function clearPeek() {
  clearTimeout(peekTimer)
  peek.value = ''
}
function pausePeek() {
  clearTimeout(peekTimer)
}
function armPeek() {
  clearTimeout(peekTimer)
  peekTimer = setTimeout(clearPeek, 12_000)
}
function expand() {
  if (dragged) return
  expanded.value = true
  unread.value = false
  clearPeek()
  void nextTick(() => field.value?.focus())
}
function collapse() {
  expanded.value = false
  resetConfirm.value = false
  showLegend.value = false
}
async function togglePin() {
  pinned.value = !pinned.value
  await windowAction(pinned.value ? 'pin' : 'unpin')
  if (windowError.value) pinned.value = !pinned.value
}
function resetPosition() {
  void windowAction('reset_position')
  right.value = 20
  bottom.value = 20
  clampPosition()
}
function send(text = draft.value) {
  if (disabled.value || !text.trim()) return
  awaitingSend.value = text
  sentAt = Date.now()
  sendTimer = setTimeout(() => {
    awaitingSend.value = ''
    windowError.value = 'Noch keine Empfangsbestätigung. Dein Entwurf bleibt erhalten.'
  }, 6000)
  emit('action', { type: 'send', sessionId: props.snapshot.sessionId, text })
  resetConfirm.value = false
}
function appendDraft(text: string) {
  draft.value = `${draft.value}${draft.value.trim() ? '\n\n' : ''}${text}`.slice(0, 12_000)
  void nextTick(() => field.value?.focus())
}
async function attachFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 1_000_000) {
    windowError.value =
      'Die Datei ist zu groß für den Mini-Chat. Bitte nutze maximal 1 MB oder öffne sie im Projektordner.'
    return
  }
  try {
    const text = await file.text()
    appendDraft(`[Datei: ${file.name}]\n${text.slice(0, 10_000)}`)
    windowError.value = ''
  } catch {
    windowError.value = 'Datei konnte nicht gelesen werden.'
  }
}
function inputKey(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    send()
  }
}
function decide(approved: boolean) {
  if (!decision.value || props.connectionError) return
  emit(
    'action',
    props.snapshot.decision
      ? { type: 'decide', sessionId: props.snapshot.sessionId, id: decision.value.id, approved }
      : { type: 'main_decide', id: decision.value.id, approved }
  )
}
function reset() {
  emit('action', { type: 'reset', sessionId: props.snapshot.sessionId })
  draft.value = ''
  resetConfirm.value = false
  unread.value = false
  clearPeek()
}
function changeView(view: MiniView) {
  emit('action', { type: 'view', sessionId: props.snapshot.sessionId, view })
}
function selectProject(event: Event) {
  emit('action', {
    type: 'select_project',
    sessionId: props.snapshot.sessionId,
    projectId: (event.target as HTMLSelectElement).value,
  })
}
async function openWorkspacePanel(panel: MiniPanel) {
  emit('action', { type: 'workspace_open', sessionId: props.snapshot.sessionId, panel })
  await windowAction('main')
}
async function openWorkflow(messageId: string, workflowId: number) {
  emit('action', { type: 'workflow_open', sessionId: props.snapshot.sessionId, messageId, workflowId })
  await windowAction('main')
}
function beginDrag(event: PointerEvent, orb = false) {
  if (event.button !== 0) return
  if (!orb && (event.target as Element).closest('button')) return
  dragged = false
  drag = {
    startX: event.clientX,
    startY: event.clientY,
    right: right.value,
    bottom: bottom.value,
    pointer: event.pointerId,
    nativeStarted: false,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId) return
  const dx = event.clientX - drag.startX,
    dy = event.clientY - drag.startY
  if (Math.hypot(dx, dy) < 5 && !dragged) return
  dragged = true
  if (props.native) {
    if (drag.nativeStarted) return
    drag.nativeStarted = true
    void invoke('mini_chat_drag')
      .catch(() => {
        windowError.value = 'Verschieben nicht möglich.'
      })
      .finally(() => {
        drag = null
        setTimeout(() => {
          dragged = false
        }, 250)
      })
  } else {
    right.value = drag.right - dx
    bottom.value = drag.bottom - dy
    clampPosition()
  }
}
function endDrag() {
  drag = null
  setTimeout(() => {
    dragged = false
  }, 250)
}
function moveKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  if (props.native) {
    void windowAction(event.key.replace('Arrow', '').toLowerCase())
    return
  }
  if (event.key === 'ArrowLeft') right.value += 24
  if (event.key === 'ArrowRight') right.value -= 24
  if (event.key === 'ArrowUp') bottom.value += 24
  if (event.key === 'ArrowDown') bottom.value -= 24
  clampPosition()
}
watch([expanded, peekVisible], layout)
watch(
  () => props.snapshot.revision,
  () => {
    if (!awaitingSend.value) return
    const accepted = props.snapshot.messages.some(
      message => message.role === 'user' && message.createdAt >= sentAt && message.content === awaitingSend.value.trim()
    )
    if (accepted || props.snapshot.notice) {
      if (accepted && draft.value === awaitingSend.value) draft.value = ''
      awaitingSend.value = ''
      clearTimeout(sendTimer)
    }
  }
)
watch(
  () => [props.snapshot.sessionId, draftKey.value] as const,
  ([, key], previous) => {
    if (previous && previous[1] !== key) {
      drafts.set(previous[1], draft.value)
      draft.value = drafts.get(key) ?? ''
    } else {
      drafts.clear()
      draft.value = ''
    }
    awaitingSend.value = ''
    clearTimeout(sendTimer)
    unread.value = false
    clearPeek()
    resetConfirm.value = false
  }
)
watch(
  () => `${lastAssistant.value?.id}:${lastAssistant.value?.status}`,
  () => {
    const message = lastAssistant.value
    if (!expanded.value && message && ['done', 'failed'].includes(message.status)) {
      unread.value = true
      peek.value = message.content.slice(0, 340)
      armPeek()
    }
  }
)
watch(
  () => draft.value,
  () =>
    void nextTick(() => {
      if (field.value) {
        field.value.style.height = 'auto'
        field.value.style.height = `${Math.min(96, field.value.scrollHeight)}px`
      }
    })
)
onMounted(() => {
  window.addEventListener('resize', clampPosition)
  if (!props.native && box.value) {
    surfaceResize = new ResizeObserver(clampPosition)
    surfaceResize.observe(box.value)
  }
  layout()
})
onBeforeUnmount(() => {
  surfaceResize?.disconnect()
  clearTimeout(peekTimer)
  clearTimeout(sendTimer)
  window.removeEventListener('resize', clampPosition)
})
</script>

<template>
  <section
    ref="box"
    class="mini-surface"
    :class="{ 'is-native': native, 'is-expanded': expanded, 'has-peek': peekVisible, 'has-decision': !!decision }"
    :style="surfaceStyle"
    aria-label="Luczor Mini"
    :data-reduce-motion="snapshot.hud.reduceMotion"
    @pointermove="moveDrag"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @keydown.esc="collapse"
  >
    <div v-if="expanded" class="mini-panel">
      <header class="mini-header" @pointerdown="beginDrag">
        <span
          class="mini-drag"
          tabindex="0"
          role="button"
          aria-label="Mini-Chat verschieben, Pfeiltasten verwenden"
          @keydown="moveKey"
          ><AiIcon name="grid" :size="13"
        /></span>
        <span class="ai-brand-mark"><AiIcon :size="18" /></span>
        <strong>{{ snapshot.appearance?.assistantName || 'Luczor' }} <span>Mini</span></strong
        ><span class="mini-temp">{{ contextName }}</span>
        <button
          type="button"
          :aria-label="pinned ? 'Immer im Vordergrund ausschalten' : 'Immer im Vordergrund einschalten'"
          :aria-pressed="pinned"
          @click="togglePin"
        >
          <AiIcon name="shield" />
        </button>
        <button type="button" aria-label="Großes Luczor-Fenster öffnen" @click="windowAction('main')">
          <AiIcon name="panel" />
        </button>
        <button type="button" aria-label="Mini-Chat einklappen" @click="collapse">
          <span aria-hidden="true">−</span>
        </button>
      </header>
      <div class="mini-scope-tabs" role="group" aria-label="Mini-Arbeitsbereich">
        <button type="button" :aria-pressed="isChat" @click="changeView('chat')">
          <AiIcon name="chat" :size="14" /> Projektchat
        </button>
        <button type="button" :aria-pressed="!isChat" @click="changeView('workspace')">
          <AiIcon name="grid" :size="14" /> Workspace
        </button>
      </div>
      <div class="mini-status-strip">
        <div class="mini-small-orb"><StatusOrb :phase="status.phase" :level="snapshot.hud.micLevel" /></div>
        <div>
          <strong>{{ status.label }}</strong
          ><span>{{ status.detail }}</span>
        </div>
        <button
          type="button"
          class="mini-icon"
          aria-label="Statusdarstellung erklären"
          :aria-expanded="showLegend"
          @click="showLegend = !showLegend"
        >
          i
        </button>
      </div>
      <div v-if="showLegend" class="mini-legend">
        <p><b>Akzentfarbe, drehend:</b> Modell arbeitet. <b>Orange, drehend:</b> ein Tool läuft.</p>
        <p>
          <b>Gelb, still:</b> deine Entscheidung. <b>Cyan:</b> Mikrofon aktiv; Ausschlag folgt dem Pegel.
          <b>Grün:</b> Sprachausgabe oder neue Antwort. <b>Rot:</b> Fehler.
        </p>
        <p>Die Ringe zeigen Aktivität, keine geschätzten Fortschrittsprozente.</p>
        <button type="button" class="ai-button" @click="resetPosition">Unten rechts platzieren</button>
      </div>
      <div class="mini-chat-picker">
        <label for="mini-project">{{ isChat ? 'Chat im Projekt' : 'Arbeitsprojekt für Dateien & Desktop' }}</label>
        <select
          id="mini-project"
          :value="snapshot.project?.id ?? ''"
          :disabled="snapshot.busy || snapshot.mainBusy"
          @change="selectProject"
        >
          <option v-if="!snapshot.project" value="" disabled>Projekt auswählen</option>
          <option v-for="project in snapshot.projects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </div>
      <div class="mini-context">
        <span>{{
          isChat ? 'Mit dem großen Chat verbunden' : `${snapshot.projects.length} Projekte · Übergeordnete Verwaltung`
        }}</span
        ><button
          type="button"
          @click="emit('action', { type: 'mode', mode: snapshot.mode === 'observe' ? 'act' : 'observe' })"
        >
          {{ snapshot.mode === 'observe' ? 'Beobachten' : snapshot.mode === 'act' ? 'Handeln' : 'Vollzugriff' }}
          <AiIcon name="chevron" :size="10" />
        </button>
      </div>
      <p v-if="!isChat" class="mini-scope-note">
        Für Workflows das Zielprojekt ausdrücklich nennen. Erstellen und Verbessern startet keinen Lauf.
      </p>
      <div class="mini-quick-controls" role="group" aria-label="Mini-Chat Funktionen">
        <button
          type="button"
          :aria-pressed="voiceView.mode === 'hands_free'"
          :disabled="voiceView.starting || voiceView.finishing || (disabled && !voiceView.mode)"
          @click="toggleVoice('hands_free')"
        >
          <AiIcon name="sound" :size="13" /> {{ voiceView.mode === 'hands_free' ? 'Zuhören stoppen' : 'Zuhören' }}
        </button>
        <button
          type="button"
          :aria-pressed="voiceView.mode === 'push_to_talk'"
          :disabled="voiceView.starting || voiceView.finishing || (disabled && !voiceView.mode)"
          @click="toggleVoice('push_to_talk')"
        >
          <AiIcon name="mic" :size="13" /> {{ voiceView.mode === 'push_to_talk' ? 'Diktat beenden' : 'Diktieren' }}
        </button>
        <label class="mini-upload">
          <AiIcon name="upload" :size="13" /> Datei
          <input type="file" accept=".txt,.md,.json,.csv,.log,.xml,.html,.css,.js,.ts,.vue,.php" @change="attachFile" />
        </label>
        <button
          type="button"
          :aria-pressed="snapshot.agentMode"
          @click="emit('action', { type: 'agent_mode', sessionId: snapshot.sessionId, enabled: !snapshot.agentMode })"
        >
          <AiIcon name="spark" :size="13" /> {{ snapshot.agentMode ? 'Agenten an' : 'Agenten' }}
        </button>
      </div>
      <div v-if="!isChat" class="mini-workspace-actions">
        <button
          type="button"
          :disabled="snapshot.busy || snapshot.mainBusy"
          @click="openWorkspacePanel('project_folder')"
        >
          <AiIcon name="folder" :size="13" /> Projektordner
        </button>
        <button type="button" :disabled="snapshot.busy || snapshot.mainBusy" @click="openWorkspacePanel('agents')">
          <AiIcon name="spark" :size="13" /> Agenten
        </button>
        <button type="button" :disabled="snapshot.busy || snapshot.mainBusy" @click="openWorkspacePanel('workflows')">
          <AiIcon name="grid" :size="13" /> Workflows
        </button>
        <button type="button" :disabled="snapshot.busy || snapshot.mainBusy" @click="openWorkspacePanel('desktop')">
          <AiIcon name="panel" :size="13" /> Desktop
        </button>
      </div>
      <ChatComposer
        :title="isChat ? 'Gemeinsamer Projektchat' : 'Temporäre Workspace-Unterhaltung'"
        :follow="snapshot.messages.length > 0"
      >
        <div v-if="!snapshot.messages.length" class="mini-welcome">
          <strong>{{ isChat ? 'Im Projekt weiterarbeiten' : 'Dein Workspace, im Blick.' }}</strong>
          <p>
            {{
              isChat
                ? 'Derselbe Verlauf und dieselben Antworten wie im großen Luczor-Fenster.'
                : 'Chats und Projekte überblicken, Code-Aufträge vorbereiten und den Desktop steuern.'
            }}
          </p>
          <small>{{
            isChat
              ? 'Nachrichten bleiben in diesem Projektchat.'
              : 'Temporäre Unterhaltung · Lokales Modell · Bestehende Freigaben'
          }}</small>
          <div>
            <button
              type="button"
              @click="
                draft = isChat
                  ? 'Fasse unseren bisherigen Projektstand zusammen.'
                  : 'Zeige mir eine Übersicht meiner Projekte, Chats und laufenden Agentenaufträge.'
              "
            >
              {{ isChat ? 'Projektstand ansehen' : 'Workspace überblicken' }}</button
            ><button
              type="button"
              @click="
                draft = isChat
                  ? 'Was ist der nächste sinnvolle Schritt in diesem Projekt?'
                  : 'Hilf mir, einen Code-Auftrag für das ausgewählte Arbeitsprojekt vorzubereiten.'
              "
            >
              {{ isChat ? 'Nächste Schritte' : 'Code-Auftrag planen' }}
            </button>
          </div>
        </div>
        <article
          v-for="message in snapshot.messages"
          :key="message.id"
          class="mini-message"
          :class="`is-${message.role}`"
        >
          <span class="mini-message-label">{{ message.role === 'user' ? 'Du' : 'Luczor' }}</span>
          <small v-if="!isChat && message.contextLabel" class="mini-scope-note">{{ message.contextLabel }}</small>
          <p v-if="message.role === 'user'">{{ message.content }}</p>
          <template v-else>
            <ThinkingState
              v-if="message.activity"
              :active="message.status === 'running'"
              :steps="message.activity.steps"
              :started-at="message.createdAt"
              :duration-ms="
                message.activity.finishedAt ? message.activity.finishedAt - message.activity.startedAt : undefined
              "
              :label="
                message.status === 'running'
                  ? 'Verarbeitet'
                  : message.status === 'failed'
                    ? 'Fehlgeschlagen'
                    : message.status === 'canceled'
                      ? 'Abgebrochen'
                      : 'Abgeschlossen'
              "
            />
            <ChatCommentary :entries="message.commentary ?? []" />
            <StreamingText
              :content="message.content"
              :streaming="message.status === 'running'"
              :animate="false"
              :actions="false"
              :question="message.question"
              :follow-ups="message.status === 'running' ? message.choices : []"
            />
            <TokenCounter :usage="message.tokenUsage" :active="message.status === 'running'" />
            <WorkflowChatCards
              v-if="isChat && message.workflows?.length"
              :workflows="message.workflows"
              :project-id="snapshot.project?.id ?? ''"
              :host-only="true"
              :disabled="disabled"
              :read-only="snapshot.mode === 'observe' || snapshot.hud.killSwitch"
              @open="reference => openWorkflow(message.id, reference.id)"
              @action="
                (reference, action) =>
                  emit('action', {
                    type: 'workflow_action',
                    sessionId: snapshot.sessionId,
                    messageId: message.id,
                    workflowId: reference.id,
                    action,
                  })
              "
              @discuss="
                reference =>
                  emit('action', {
                    type: 'workflow_improve',
                    sessionId: snapshot.sessionId,
                    messageId: message.id,
                    workflowId: reference.id,
                  })
              "
            />
            <button
              v-if="message.content && message.status === 'done'"
              type="button"
              class="mini-copy"
              aria-label="Mini-Antwort kopieren"
              @click="copy(message.content)"
            >
              <AiIcon name="copy" :size="12" /> Kopieren
            </button>
            <div v-if="message.choices.length && message.status === 'done'" class="mini-choices">
              <button
                v-for="choice in message.choices"
                :key="choice"
                type="button"
                :disabled="disabled"
                @click="send(choice)"
              >
                {{ choice }} <AiIcon name="arrow" :size="13" />
              </button>
            </div>
          </template>
        </article>
      </ChatComposer>
      <div v-if="tools.length" class="mini-tools"><ToolChips :tools="tools" /></div>
      <div v-if="decision" class="mini-decision">
        <ApprovalCard
          :key="`${decision.id}:${!!connectionError}`"
          compact
          :title="decision.title"
          :description="decision.description"
          :detail="decision.detail"
          :busy="!!connectionError"
          @approve="decide(true)"
          @reject="decide(false)"
        />
      </div>
      <div v-if="resetConfirm" class="mini-reset" role="group" aria-label="Temporäre Unterhaltung leeren">
        <p>Unterhaltung und Entwurf verwerfen? Laufende Anfragen werden abgebrochen.</p>
        <button type="button" @click="reset">Jetzt leeren</button
        ><button type="button" @click="resetConfirm = false">Behalten</button>
      </div>
      <p v-if="error" class="mini-error" role="alert">{{ error }}</p>
      <p v-if="copied || clipboardError" class="mini-copy-status" role="status">
        {{ clipboardError || 'Antwort kopiert' }}
      </p>
      <form class="mini-composer" @submit.prevent="send()">
        <ThinkingBudgetControl
          v-if="snapshot.thinkingBudget"
          :progress="snapshot.thinkingBudget"
          :control="controlThinking"
          @stop="emit('action', { type: 'stop', sessionId: snapshot.sessionId })"
        />
        <div class="mini-thinking-choice">
          <small>Lokales Modell</small>
          <ThinkingSelector
            :model-value="snapshot.thinkingTier"
            :next-prompt="snapshot.busy"
            @update:model-value="emit('action', { type: 'thinking_tier', sessionId: snapshot.sessionId, tier: $event })"
          />
        </div>
        <VoiceInputSettings
          :busy="disabled || voiceView.starting || voiceView.finishing"
          :active="!!voiceView.mode"
          @start="miniVoice.start($event)"
          @stop="miniVoice.stop()"
        />
        <p v-if="voiceView.error || voiceView.notice" :role="voiceView.error ? 'alert' : 'status'">
          {{ voiceView.error || voiceView.notice }}
        </p>
        <textarea
          ref="field"
          v-model="draft"
          aria-label="Nachricht im Mini-Chat"
          :placeholder="isChat ? 'In diesem Projektchat schreiben …' : 'Was soll Luczor übergreifend organisieren?'"
          rows="1"
          maxlength="12000"
          @keydown="inputKey"
          @input="miniVoice.manualInput()"
        />
        <div>
          <small>Enter senden · Shift + Enter neue Zeile</small
          ><button
            v-if="snapshot.busy"
            type="button"
            aria-label="Mini-Anfrage stoppen"
            @click="emit('action', { type: 'stop', sessionId: snapshot.sessionId })"
          >
            <AiIcon name="stop" /></button
          ><button v-else type="submit" aria-label="Mini-Nachricht senden" :disabled="disabled || !draft.trim()">
            <AiIcon name="send" />
          </button>
        </div>
      </form>
      <footer class="mini-footer">
        <button v-if="isChat" type="button" @click="changeView('workspace')">
          <AiIcon name="grid" :size="12" /> Workspace öffnen
        </button>
        <button v-else type="button" @click="resetConfirm = !resetConfirm">
          <AiIcon name="plus" :size="12" /> Workspace leeren</button
        ><button
          type="button"
          :class="{ 'is-danger': snapshot.hud.killSwitch }"
          @click="emit('action', { type: 'kill_switch', enabled: !snapshot.hud.killSwitch })"
        >
          {{ snapshot.hud.killSwitch ? 'Not-Aus lösen' : 'Not-Aus' }}</button
        ><button type="button" aria-label="Mini-Chat ausblenden" @click="windowAction('hide')">
          <AiIcon name="close" :size="13" />
        </button>
      </footer>
    </div>
    <template v-else>
      <aside v-if="peekVisible" class="mini-peek" @mouseenter="pausePeek" @mouseleave="armPeek">
        <template v-if="decision"
          ><span class="mini-peek-source"
            >{{ snapshot.decision ? 'Mini-Chat' : 'Projektchat' }} · Entscheidung offen</span
          ><ApprovalCard
            :key="`${decision.id}:${!!connectionError}`"
            compact
            :title="decision.title"
            :description="decision.description"
            :detail="decision.detail"
            :busy="!!connectionError"
            @approve="decide(true)"
            @reject="decide(false)"
        /></template>
        <template v-else
          ><header>
            <strong>Neue Antwort</strong
            ><button type="button" aria-label="Antwortvorschau schließen" @click="clearPeek">
              <AiIcon name="close" :size="13" />
            </button>
          </header>
          <p>{{ peek }}</p>
          <button type="button" class="mini-read" @click="expand">
            Unterhaltung öffnen <AiIcon name="arrow" :size="13" /></button
        ></template>
      </aside>
      <div class="mini-orb-dock">
        <div class="mini-orb-tools">
          <button type="button" aria-label="Mini-Chat ausblenden" @click="windowAction('hide')">
            <AiIcon name="close" :size="12" />
          </button>
        </div>
        <button
          type="button"
          class="mini-orb-button"
          :aria-label="`Mini-Chat öffnen: ${status.label}`"
          :title="status.detail"
          @pointerdown="beginDrag($event, true)"
          @click="expand"
        >
          <StatusOrb :phase="status.phase" :level="snapshot.hud.micLevel" /><span
            v-if="decision || unread"
            class="mini-unread"
            >{{ decision ? '!' : '1' }}</span
          >
        </button>
        <button type="button" class="mini-status-label" :class="{ 'is-working': compactWorking }" @click="expand">
          {{ compactWorking ? `Arbeitet · ${status.label}` : status.label }}
        </button>
        <span v-if="connectionError" class="mini-disconnected" role="alert">Verbindung fehlt</span>
      </div>
    </template>
  </section>
</template>

<style src="../../styles/mini-chat.css"></style>
