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
import ChatAgentRoster from '../ai/ChatAgentRoster.vue'
import AssistantResponseFooter from '../ai/AssistantResponseFooter.vue'
import ThinkingState from '../ai/ThinkingState.vue'
import ThinkingSelector from '../ai/ThinkingSelector.vue'
import { createMiniThinkingControl } from '@/services/miniChat/thinkingControl'
import ApprovalCard from '../ai/ApprovalCard.vue'
import ToolChips from '../ai/ToolChips.vue'
import WorkflowChatCards from '../workflows/WorkflowChatCards.vue'
import { miniStatus } from '@/services/miniChat/presentation'
import type { MiniAction, MiniSnapshot, MiniPanel } from '@/services/miniChat/types'
import type { ActivityStatus } from '../ai/types'
import { useClipboard } from '@/composables/useClipboard'
import { listToolSessions, stopToolSession, toolSessionRevision } from '@/services/tools/toolSessionCoordinator'

const props = withDefaults(defineProps<{ snapshot: MiniSnapshot; native?: boolean; connectionError?: string }>(), {
  connectionError: '',
})
const emit = defineEmits<{ action: [action: MiniAction]; hide: []; showMain: [] }>()
// The screen-edge nudge has one window mode: the capsule, with a fly-out per icon. "Chats" is the
// one pane that can grow into the full chat page — that replaces the old separate Mini "expand" modus.
type GripPane = 'status' | 'chats' | 'decision' | 'tools' | 'link'
const gripHover = ref(false)
const hoverPane = ref<GripPane | null>(null)
const pinnedPane = ref<GripPane | null>(null)
const activePane = computed<GripPane>(() => pinnedPane.value ?? hoverPane.value ?? 'status')
// Hovering the chats icon reveals the full chat page too, same as pinning it — the design board's
// nudge grows into its chats page on hover already, it doesn't wait for a click.
const chatsOpen = computed(() => activePane.value === 'chats')
const paneTitles: Record<GripPane, string> = {
  status: 'Status',
  chats: 'Chats',
  decision: 'Entscheidung',
  tools: 'Werkzeuge',
  link: 'Verbindung',
}
function enterGrip() {
  gripHover.value = true
}
function leaveGrip() {
  gripHover.value = false
  hoverPane.value = null
}
function pinPane(pane: GripPane) {
  if (pane === 'chats') {
    if (pinnedPane.value === 'chats') collapse()
    else expand()
    return
  }
  pinnedPane.value = pinnedPane.value === pane ? null : pane
}
const expanded = computed<boolean>({
  get: () => pinnedPane.value === 'chats',
  set: value => {
    pinnedPane.value = value ? 'chats' : null
  },
})
const thinkingControl = createMiniThinkingControl(
  () => props.snapshot,
  action => emit('action', action),
  () => props.connectionError
)
const controlThinking = thinkingControl.control
onBeforeUnmount(thinkingControl.dispose)
const pinned = ref(true)
const draft = ref('')
const drafts = new Map<string, string>()
const draftKey = computed(
  () =>
    `${props.snapshot.view}:${props.snapshot.view === 'chat' ? (props.snapshot.project?.id ?? 'none') : 'workspace'}`
)
// Mini is now dedicated to being the screen-edge nudge's chat page; the workspace view
// (file/agent/workflow shortcuts) is deactivated here and reached from the main app instead.
const isChat = computed(() => true)
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
// The nudge is locked flush to a screen edge, like the design board's Nano nudge: dragging moves
// it up/down along the edge and flips which edge it's on, it never floats free horizontally.
const side = ref<'left' | 'right'>('right')
const bottom = ref(20)
let surfaceResize: ResizeObserver | undefined
let peekTimer: ReturnType<typeof setTimeout> | undefined
let drag: {
  startX: number
  startY: number
  bottom: number
  pointer: number
  nativeStarted: boolean
} | null = null
let dragged = false
const decision = computed(() => props.snapshot.decision ?? props.snapshot.mainDecision)
const status = computed(() => miniStatus(props.snapshot, unread.value))
const peekVisible = computed(() => !chatsOpen.value && (!!decision.value || !!peek.value))
const surfaceStyle = computed(() => ({
  ...(props.native
    ? {}
    : side.value === 'left'
      ? { left: '0px', bottom: `${bottom.value}px` }
      : { right: '0px', bottom: `${bottom.value}px` }),
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
const sharedToolSessions = computed(() => {
  void toolSessionRevision.value
  const projectId = props.snapshot.project?.id
  return listToolSessions().filter(session => !projectId || session.projectId === projectId)
})
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
const chatsState = computed(() => {
  if (props.snapshot.conversations?.some(chat => chat.busy)) return 'running'
  if (unread.value) return 'unread'
  return 'idle'
})
const chatsTitle = computed(() => {
  const count = props.snapshot.conversations?.length ?? 0
  if (chatsState.value === 'running') return 'Ein Chat arbeitet'
  if (chatsState.value === 'unread') return 'Neue Antwort'
  return count ? `${count} Chats` : 'Chats'
})
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
async function snapNativeEdge() {
  // start_dragging() only resolves once the OS-native move has ended, so the window is
  // already at its final position here — flush it to that edge and mirror the capsule onto it.
  try {
    side.value = (await invoke<string>('mini_chat_snap')) === 'left' ? 'left' : 'right'
  } catch {
    // Non-fatal: the window just stays wherever the OS left it.
  }
}
let resizeQueue = Promise.resolve()
function layout() {
  if (props.native) {
    // Hovering the chats icon already grows the window to full size, same as pinning it.
    const action = chatsOpen.value ? 'expand' : peekVisible.value || gripHover.value ? 'peek' : 'collapse'
    resizeQueue = resizeQueue.then(() => windowAction(action))
  } else void nextTick(clampPosition)
}
function clampPosition() {
  // Horizontal is always flush to an edge now; only the vertical position needs clamping.
  if (props.native || !box.value) return
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
  side.value = 'right'
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
        // The native OS drag has already ended by the time this settles; flush the window
        // to whichever edge it ended up nearest to and mirror the capsule onto that side.
        void snapNativeEdge()
        setTimeout(() => {
          dragged = false
        }, 250)
      })
  } else {
    bottom.value = drag.bottom - dy
    // Live-flip which edge the nudge sits on as it crosses the screen's midline, same as dragging it in the design board.
    side.value = event.clientX < window.innerWidth / 2 ? 'left' : 'right'
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
    if (event.key === 'ArrowLeft') side.value = 'left'
    if (event.key === 'ArrowRight') side.value = 'right'
    void windowAction(event.key.replace('Arrow', '').toLowerCase())
    return
  }
  if (event.key === 'ArrowLeft') side.value = 'left'
  if (event.key === 'ArrowRight') side.value = 'right'
  if (event.key === 'ArrowUp') bottom.value += 24
  if (event.key === 'ArrowDown') bottom.value -= 24
  clampPosition()
}
watch([chatsOpen, peekVisible, gripHover], layout)
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
    if (!chatsOpen.value && message && ['done', 'failed'].includes(message.status)) {
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
    :class="{ 'is-native': native, 'is-expanded': chatsOpen, 'has-peek': peekVisible, 'has-decision': !!decision }"
    :style="surfaceStyle"
    :data-side="side"
    aria-label="Luczor Mini"
    :data-reduce-motion="snapshot.hud.reduceMotion"
    @pointermove="moveDrag"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @keydown.esc="collapse"
  >
    <aside v-if="peekVisible" class="mini-peek" @mouseenter="pausePeek" @mouseleave="armPeek">
      <template v-if="decision"
        ><span class="mini-peek-source">{{ snapshot.decision ? 'Mini-Chat' : 'Projektchat' }} · Entscheidung offen</span
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
    <div
      class="mini-orb-dock"
      :data-phase="status.phase"
      :class="{ 'has-pin': !!pinnedPane, 'is-chat-open': chatsOpen }"
      @pointerenter="enterGrip"
      @pointerleave="leaveGrip"
    >
      <div v-if="!expanded" class="mini-orb-tools">
        <button type="button" aria-label="Mini-Chat ausblenden" @click="windowAction('hide')">
          <AiIcon name="close" :size="12" />
        </button>
      </div>
      <!-- Edge grip: five icon pills in one glass capsule, like the design board's Nano nudge.
           Any icon both drags the capsule (pointer moves) and pins its pane (a plain click) —
           chats pins into the full chat page, the others into their light status pane. -->
      <div class="mini-grip" role="group" aria-label="Status im Überblick" :data-phase="status.phase">
        <button
          type="button"
          class="mini-grip__icon"
          data-kind="chats"
          :class="{ 'is-pinned': pinnedPane === 'chats', 'is-active': activePane === 'chats' }"
          :data-state="chatsState"
          :title="status.detail"
          :aria-label="`Mini-Chat öffnen: ${chatsTitle}`"
          @pointerenter="hoverPane = 'chats'"
          @pointerdown="beginDrag($event, true)"
          @click="pinPane('chats')"
        >
          <AiIcon name="chat" :size="12" /><span v-if="decision || unread" class="mini-unread">{{
            decision ? '!' : '1'
          }}</span>
        </button>
        <button
          type="button"
          class="mini-grip__icon"
          data-kind="decision"
          :class="{ 'is-pinned': pinnedPane === 'decision', 'is-active': activePane === 'decision' }"
          :data-state="decision ? 'waiting' : 'idle'"
          :title="decision ? 'Entscheidung offen' : 'Keine Entscheidung offen'"
          :aria-label="decision ? 'Entscheidung offen' : 'Keine Entscheidung offen'"
          @pointerenter="hoverPane = 'decision'"
          @pointerdown="beginDrag($event, true)"
          @click="pinPane('decision')"
        >
          <AiIcon name="shield" :size="11" />
        </button>
        <button
          type="button"
          class="mini-grip__icon"
          data-kind="tools"
          :class="{ 'is-pinned': pinnedPane === 'tools', 'is-active': activePane === 'tools' }"
          :data-state="sharedToolSessions.length ? 'running' : 'idle'"
          :title="
            sharedToolSessions.length ? `${sharedToolSessions.length} Tool-Sitzungen laufen` : 'Keine Tool-Sitzung'
          "
          :aria-label="
            sharedToolSessions.length ? `${sharedToolSessions.length} Tool-Sitzungen laufen` : 'Keine Tool-Sitzung'
          "
          @pointerenter="hoverPane = 'tools'"
          @pointerdown="beginDrag($event, true)"
          @click="pinPane('tools')"
        >
          <AiIcon name="tool" :size="11" />
        </button>
        <button
          type="button"
          class="mini-grip__icon"
          data-kind="link"
          :class="{ 'is-pinned': pinnedPane === 'link', 'is-active': activePane === 'link' }"
          :data-state="connectionError ? 'error' : 'ok'"
          :title="connectionError ? 'Verbindung fehlt' : 'Verbunden'"
          :aria-label="connectionError ? 'Verbindung fehlt' : 'Verbunden'"
          @pointerenter="hoverPane = 'link'"
          @pointerdown="beginDrag($event, true)"
          @click="pinPane('link')"
        >
          <AiIcon name="link" :size="11" />
        </button>
      </div>
      <!-- Hover fly-out: one pane per grip icon (hover switches, click pins) -->
      <div class="mini-grip-panel" :data-pane="activePane" :class="{ 'is-chat-open': chatsOpen }" aria-live="polite">
        <div v-if="chatsOpen" class="mini-panel">
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
          <div v-if="sharedToolSessions.length" class="mini-tool-sessions" aria-label="Gemeinsame Tool-Sitzungen">
            <div class="mini-tool-sessions__heading">
              <span>Gemeinsame Läufe</span><small>{{ sharedToolSessions.length }}</small>
            </div>
            <div v-for="session in sharedToolSessions" :key="session.id" class="mini-tool-session">
              <span class="mini-tool-session__dot" :data-status="session.status" aria-hidden="true"></span>
              <span>{{ session.kind }}</span>
              <small>{{ session.status === 'active' ? 'läuft' : session.status }}</small>
              <button type="button" aria-label="Tool-Sitzung stoppen" @click="stopToolSession(session.id)">Stop</button>
            </div>
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
            <select id="mini-project" :value="snapshot.project?.id ?? ''" @change="selectProject">
              <option v-if="!snapshot.project" value="" disabled>Projekt auswählen</option>
              <option v-for="project in snapshot.projects" :key="project.id" :value="project.id">
                {{ project.name }}
              </option>
            </select>
          </div>
          <div v-if="isChat && snapshot.project && snapshot.conversations?.length" class="mini-chat-picker">
            <label for="mini-conversation">Unterhaltung</label>
            <select
              id="mini-conversation"
              :value="snapshot.conversationId"
              @change="
                emit('action', {
                  type: 'select_conversation',
                  sessionId: snapshot.sessionId,
                  projectId: snapshot.project.id,
                  conversationId: ($event.target as HTMLSelectElement).value,
                })
              "
            >
              <option v-for="chat in snapshot.conversations" :key="chat.id" :value="chat.id">
                {{ chat.busy ? 'Läuft · ' : '' }}{{ chat.title }}
              </option>
            </select>
            <button
              type="button"
              class="ai-button"
              @click="
                emit('action', {
                  type: 'new_conversation',
                  sessionId: snapshot.sessionId,
                  projectId: snapshot.project.id,
                })
              "
            >
              Neuer Chat
            </button>
          </div>
          <div class="mini-context">
            <span>{{
              isChat
                ? 'Mit dem großen Chat verbunden'
                : `${snapshot.projects.length} Projekte · Übergeordnete Verwaltung`
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
              <input
                type="file"
                accept=".txt,.md,.json,.csv,.log,.xml,.html,.css,.js,.ts,.vue,.php"
                @change="attachFile"
              />
            </label>
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
            <button
              type="button"
              :disabled="snapshot.busy || snapshot.mainBusy"
              @click="openWorkspacePanel('workflows')"
            >
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
              <span class="mini-message-label">{{
                message.role === 'user' ? 'Du' : snapshot.appearance?.assistantName || 'Luczor'
              }}</span>
              <small v-if="!isChat && message.contextLabel" class="mini-scope-note">{{ message.contextLabel }}</small>
              <p v-if="message.role === 'user'">{{ message.content }}</p>
              <template v-else>
                <ChatAgentRoster
                  :activity="message.activity"
                  :loading="message.status === 'running'"
                  :waiting="message.status === 'running' && !!snapshot.decision"
                />
                <ThinkingState
                  v-if="message.activity"
                  :active="message.status === 'running'"
                  :status="
                    message.status === 'running'
                      ? snapshot.decision
                        ? 'waiting'
                        : message.activity.status
                      : message.status
                  "
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
                <ChatCommentary :entries="message.commentary ?? []" :active="message.status === 'running'" />
                <StreamingText
                  v-if="message.content || message.question || message.choices.length || !message.activity"
                  :content="message.content"
                  :streaming="message.status === 'running'"
                  :show-stream-status="!message.activity"
                  :animate="false"
                  :actions="false"
                  :question="message.question"
                  :follow-ups="message.status === 'running' ? message.choices : []"
                />
                <AssistantResponseFooter
                  :message-id="message.id"
                  :active-message-id="lastAssistant?.status === 'running' ? lastAssistant.id : undefined"
                  :usage="message.tokenUsage"
                  :active="snapshot.busy && message.status === 'running'"
                  :budget="snapshot.thinkingBudget"
                  :control="controlThinking"
                  @stop="emit('action', { type: 'stop', sessionId: snapshot.sessionId })"
                />
                <WorkflowChatCards
                  v-if="isChat && message.workflows?.length"
                  :workflows="message.workflows"
                  :project-id="snapshot.project?.id ?? ''"
                  :host-only="true"
                  :host-runs="snapshot.workflowRuns"
                  :host-runs-verified="snapshot.workflowRunsVerified"
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
            <div class="mini-thinking-choice">
              <small>Lokales Modell</small>
              <ThinkingSelector
                :model-value="snapshot.thinkingTier"
                :next-prompt="snapshot.busy"
                @update:model-value="
                  emit('action', { type: 'thinking_tier', sessionId: snapshot.sessionId, tier: $event })
                "
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
            <button type="button" aria-label="Mini-Chat ausblenden" @click="windowAction('hide')">
              <AiIcon name="close" :size="13" /> Ausblenden
            </button>
          </footer>
        </div>
        <template v-else>
          <!-- Fixed-width so the text doesn't reflow while the outer box's width is still
               animating open — the outer's overflow:hidden reveals it, doesn't resize it. -->
          <div class="mini-grip-panel__reveal">
            <div class="mini-grip-panel__head">
              <strong>{{ paneTitles[activePane] }}</strong>
              <span v-if="pinnedPane" class="mini-grip-panel__pin">fixiert</span>
            </div>
          <template v-if="activePane === 'status'">
            <dl class="mini-grip-panel__kv">
              <dt>Zustand</dt>
              <dd>{{ status.label }}</dd>
              <dt>Details</dt>
              <dd>{{ status.detail }}</dd>
              <dt>Modus</dt>
              <dd>{{ snapshot.mode === 'observe' ? 'Beobachten' : 'Handeln' }}</dd>
              <dt v-if="snapshot.thinkingTier">Denkstufe</dt>
              <dd v-if="snapshot.thinkingTier">{{ snapshot.thinkingTier }}</dd>
            </dl>
          </template>
          <template v-else-if="activePane === 'decision'">
            <p v-if="decision" class="mini-grip-panel__text">
              <strong>{{ decision.title }}</strong>
              {{ decision.description }}
            </p>
            <p v-else class="mini-grip-panel__empty">Keine Entscheidung offen.</p>
          </template>
          <template v-else-if="activePane === 'tools'">
            <ul v-if="sharedToolSessions.length" class="mini-grip-panel__chats">
              <li v-for="session in sharedToolSessions" :key="session.id" class="is-busy">
                <i aria-hidden="true" /><span>{{ session.kind }}</span
                ><small>{{ session.id.slice(0, 8) }}</small>
              </li>
            </ul>
            <p v-else class="mini-grip-panel__empty">Keine Tool-Sitzung aktiv.</p>
          </template>
          <template v-else>
            <dl class="mini-grip-panel__kv">
              <dt>Server</dt>
              <dd :class="connectionError ? 'is-error' : 'is-ok'">{{ connectionError || 'Verbunden' }}</dd>
              <dt>HUD</dt>
              <dd>{{ snapshot.hud.status || '–' }}</dd>
              <dt>Not-Aus</dt>
              <dd>{{ snapshot.hud.killSwitch ? 'aktiv' : 'aus' }}</dd>
            </dl>
          </template>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<style src="../../styles/mini-chat.css"></style>

<style scoped>
.mini-message.is-assistant {
  padding-block: 2px 8px;
}
.mini-message-label {
  margin-block-end: 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.mini-message.is-assistant :deep(.rt) {
  font-size: 13px;
  line-height: 1.72;
}
.mini-message :deep(.ai-answer__question) {
  font-size: 13px;
  line-height: 1.65;
}
</style>
