<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import StatusOrb from './StatusOrb.vue'
import MiniSystemPane from './MiniSystemPane.vue'
import MiniChatPopover from './MiniChatPopover.vue'
import MiniChatContextPicker from './MiniChatContextPicker.vue'
import { useMiniChatDraft } from '@/composables/useMiniChatDraft'
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
import WorkflowChatCards from '../workflows/WorkflowChatCards.vue'
import { miniStatus } from '@/services/miniChat/presentation'
import type { MiniAction, MiniSnapshot } from '@/services/miniChat/types'
import { useClipboard } from '@/composables/useClipboard'

const props = withDefaults(defineProps<{ snapshot: MiniSnapshot; native?: boolean; connectionError?: string }>(), {
  connectionError: '',
})
const emit = defineEmits<{ action: [action: MiniAction]; hide: []; showMain: [] }>()
// The screen-edge nudge has one window mode: the capsule, with a fly-out per icon. "Chats" is the
// one pane that can grow into the full chat page — that replaces the old separate Mini "expand" modus.
type GripPane = 'status' | 'chats' | 'system' | 'link'
const gripHover = ref(false)
const hoverPane = ref<GripPane | null>(null)
const pinnedPane = ref<GripPane | null>(null)
const activePane = computed<GripPane>(
  () => pinnedPane.value ?? (hoverPane.value === 'chats' ? 'status' : hoverPane.value) ?? 'status'
)
// Open explicitly: a hover must not move the chat trigger away from the pointer mid-click.
const chatsOpen = computed(() => pinnedPane.value === 'chats')
const paneTitles: Record<GripPane, string> = {
  status: 'Status',
  chats: 'Chats',
  system: 'Systemstatus',
  link: 'Verbindung',
}
// The main window samples metrics only while this pane is actually on screen (hovered or pinned).
const systemWatching = computed(
  () => activePane.value === 'system' && (gripHover.value || pinnedPane.value === 'system')
)
watch(systemWatching, active => {
  emit('action', { type: 'system_watch', sessionId: props.snapshot.sessionId, active })
})
const systemState = computed(() => {
  const availability = props.snapshot.system?.availability
  if (!availability || availability === 'idle') return 'idle'
  if (availability === 'unavailable') return 'error'
  return props.snapshot.system?.model.running ? 'busy' : 'ok'
})
function enterGrip() {
  gripHover.value = true
}
function leaveGrip() {
  gripHover.value = false
  hoverPane.value = null
}
function pinPane(pane: GripPane) {
  if (dragged) return
  if (pane === 'chats') {
    if (pinnedPane.value === 'chats') collapse()
    else expand()
    return
  }
  pinnedPane.value = pinnedPane.value === pane ? null : pane
}
// The chat page stays mounted through the 0.52s close transition so the box never shrinks empty.
const chatsVisible = ref(false)
let chatsHideTimer: ReturnType<typeof setTimeout> | undefined
watch(
  chatsOpen,
  open => {
    clearTimeout(chatsHideTimer)
    if (open) chatsVisible.value = true
    else chatsHideTimer = setTimeout(() => (chatsVisible.value = false), 540)
  },
  { immediate: true }
)
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
const { draft, key: draftKey } = useMiniChatDraft(() => props.snapshot)
// Display the actual host context: temporary workspace or shared main conversation.
const isChat = computed(() => props.snapshot.view === 'chat')
const modeLabel = computed(() =>
  props.snapshot.mode === 'observe' ? 'Beobachten' : props.snapshot.mode === 'act' ? 'Handeln' : 'Vollzugriff'
)
const awaitingSend = ref('')
const { copy, copied, error: clipboardError } = useClipboard()
let sendTimer: ReturnType<typeof setTimeout> | undefined
let sentAt = 0
const unread = ref(false)
const peek = ref('')
const windowError = ref('')
const box = ref<HTMLElement | null>(null)
const field = ref<HTMLTextAreaElement | null>(null)
// The nudge is locked flush to a screen edge, like the design board's Nano nudge: dragging moves
// it up/down along the edge and flips which edge it's on, it never floats free horizontally.
// `bottom` is the ONLY thing that ever moves it — drag, arrow keys or reset. Hovering the chats
// icon opens the full chat page (see chatsOpen below) before any drag motion even starts, so if
// opening a pane also shifted the box, that shift would happen the instant a drag begins and throw
// off the drag's own coordinate tracking. The box only ever grows upward from this fixed edge.
const side = ref<'left' | 'right'>('right')
const bottom = ref(20)
let surfaceResize: ResizeObserver | undefined
let peekTimer: ReturnType<typeof setTimeout> | undefined
let drag: {
  startX: number
  startY: number
  bottom: number
  pointer: number
  /** Native: screen-space y of the last step already handed to the window (CSS px). */
  lastScreenY: number
  captureTarget: HTMLElement
  clickTarget: HTMLElement | null
} | null = null
// Native drag steps are serialized: each pointermove adds to the pending delta, one IPC call is
// in flight at a time, and whatever accumulated while it ran goes out as the next step.
let nativeMoveChain: Promise<void> = Promise.resolve()
let nativeMovePending = 0
let nativeMovePointerX = 0
let nativeMoveQueued = false
let dragged = false
const decision = computed(() => props.snapshot.decision ?? props.snapshot.mainDecision)
const status = computed(() => miniStatus(props.snapshot, unread.value))
const peekVisible = computed(() => !chatsOpen.value && !!peek.value)
const surfaceStyle = computed(() => ({
  ...(props.native
    ? {}
    : side.value === 'left'
      ? { left: '0px', bottom: `${bottom.value}px`, '--mini-bottom': `${bottom.value}px` }
      : { right: '0px', bottom: `${bottom.value}px`, '--mini-bottom': `${bottom.value}px` }),
  ...(props.snapshot.appearance?.accent && /^#[0-9a-f]{6}$/i.test(props.snapshot.appearance.accent)
    ? { '--cy-bright': props.snapshot.appearance.accent }
    : {}),
}))
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
let shrinkTimer: ReturnType<typeof setTimeout> | undefined
type WindowSize = 'collapse' | 'peek' | 'expand'
const windowRank = (size: WindowSize) => (size === 'expand' ? 2 : size === 'peek' ? 1 : 0)
let windowSize: WindowSize = 'collapse'
function layout() {
  if (props.native) {
    // A pointer is down on the grip (about to drag, or already dragging): resize() always ends
    // in set_position(), flush to the nearest edge with the bottom pinned. Hovering the icon to
    // grab it already flips this to "peek" reactively, and if that resize lands while the OS-level
    // drag from start_dragging() is moving the window, it snaps straight back — the drag looks
    // like it does nothing. Stay out of the way until the drag (if any) is over, then catch up.
    if (drag) return
    // Hovering the chats icon already grows the window to full size, same as pinning it; a pinned
    // light pane keeps the peek size after the pointer leaves.
    const action: WindowSize = chatsOpen.value
      ? 'expand'
      : peekVisible.value || gripHover.value || pinnedPane.value
        ? 'peek'
        : 'collapse'
    clearTimeout(shrinkTimer)
    const apply = () => {
      windowSize = action
      resizeQueue = resizeQueue.then(() => windowAction(action))
    }
    // Grow immediately, shrink only after the CSS close transition has finished (0.52s).
    if (windowRank(action) < windowRank(windowSize)) shrinkTimer = setTimeout(apply, 560)
    else apply()
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
  // Otherwise the pane the pointer is still resting on keeps the page open — nothing visible happens.
  hoverPane.value = null
  void nextTick(() => box.value?.querySelector<HTMLButtonElement>('.mini-grip__icon')?.focus())
}
// Typing in a page that was only hover-opened must not lose the page when the pointer drifts away.
function keepChatsOpen() {
  if (!expanded.value) expanded.value = true
}
async function togglePin() {
  pinned.value = !pinned.value
  await windowAction(pinned.value ? 'pin' : 'unpin')
  if (windowError.value) pinned.value = !pinned.value
}
function menuAction(action: 'observe' | 'act' | 'pin' | 'system' | 'link' | 'position' | 'hide', close: () => void) {
  close()
  if (action === 'observe' || action === 'act') emit('action', { type: 'mode', mode: action })
  else if (action === 'pin') void togglePin()
  else if (action === 'position') resetPosition()
  else if (action === 'hide') void windowAction('hide')
  else pinPane(action)
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
  const sessionId = props.snapshot.sessionId
  try {
    const text = await file.text()
    if (sessionId !== props.snapshot.sessionId) return
    appendDraft(`[Datei: ${file.name}]\n${text.slice(0, 10_000)}`)
    windowError.value = ''
  } catch {
    if (sessionId !== props.snapshot.sessionId) return
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
async function openWorkflow(messageId: string, workflowId: number) {
  emit('action', { type: 'workflow_open', sessionId: props.snapshot.sessionId, messageId, workflowId })
  await windowAction('main')
}
// Repositioning happens only from the edge grip's icons now — not from the chat window's own
// header, which used to double as a drag handle.
// Bound on the whole icon column, so the nudge can be grabbed anywhere on it — between and
// around the icons too, not only on the 28px pills. The column takes pointer capture right on
// pointerdown: the surface around the dock is pointer-events:none, so a fast first movement that
// already leaves the dock would otherwise never reach moveDrag. Capture retargets pointerup to the
// column, which is what would swallow the icons' click — so endDrag replays the click itself.
function beginDrag(event: PointerEvent) {
  if (event.button !== 0) return
  dragged = false
  const captureTarget = event.currentTarget as HTMLElement
  drag = {
    startX: event.clientX,
    startY: event.clientY,
    bottom: bottom.value,
    pointer: event.pointerId,
    lastScreenY: event.screenY,
    captureTarget,
    clickTarget: (event.target as Element).closest<HTMLElement>('.mini-grip__icon'),
  }
  try {
    captureTarget.setPointerCapture(event.pointerId)
  } catch {
    /* Not capturable (synthetic pointer) — moves still bubble while the pointer is over the dock. */
  }
}
function queueNativeMove(dy: number, pointerX: number) {
  nativeMovePending += dy
  nativeMovePointerX = pointerX
  if (nativeMoveQueued) return
  nativeMoveQueued = true
  nativeMoveChain = nativeMoveChain.then(async () => {
    nativeMoveQueued = false
    const step = nativeMovePending
    nativeMovePending = 0
    if (!step) return
    try {
      const edge = await invoke<string>('mini_chat_drag_by', { dy: step, pointerX: nativeMovePointerX })
      side.value = edge === 'left' ? 'left' : 'right'
      windowError.value = ''
    } catch {
      windowError.value = 'Verschieben nicht möglich.'
    }
  })
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId) return
  const dx = event.clientX - drag.startX,
    dy = event.clientY - drag.startY
  if (Math.hypot(dx, dy) < 5 && !dragged) return
  dragged = true
  if (props.native) {
    // The window is moved from here, step by step, instead of handing the mouse to the OS move
    // loop (start_dragging): that handoff needs the webview's pointer capture released and then
    // races the hover-triggered peek resize, which on Windows left the window sitting still.
    // Screen coordinates stay valid while the window slides underneath the pointer, so each
    // step is simply the pointer's travel since the previous one.
    const stepY = event.screenY - drag.lastScreenY
    drag.lastScreenY = event.screenY
    queueNativeMove(stepY, event.screenX)
  } else {
    bottom.value = drag.bottom - dy
    // Live-flip which edge the nudge sits on as it crosses the screen's midline, same as dragging it in the design board.
    side.value = event.clientX < window.innerWidth / 2 ? 'left' : 'right'
    clampPosition()
  }
}
function endDrag(event?: PointerEvent) {
  const wasNativeDrag = props.native && !!drag && dragged
  const clickTarget = drag && !dragged && event?.type === 'pointerup' ? drag.clickTarget : null
  if (drag && event) {
    try {
      drag.captureTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* Already released. */
    }
  }
  drag = null
  // A press that never travelled is a click on the icon it started on (see beginDrag).
  clickTarget?.click()
  if (wasNativeDrag) {
    // Let the last queued step land, then flush against the nearest edge and let layout() catch
    // up on the peek/expand state it held back while the pointer was down.
    nativeMoveChain = nativeMoveChain.then(async () => {
      await snapNativeEdge()
      layout()
    })
  }
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
watch([chatsOpen, peekVisible, gripHover, pinnedPane], layout)
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
watch([() => props.snapshot.sessionId, draftKey], () => {
  awaitingSend.value = ''
  clearTimeout(sendTimer)
  unread.value = false
  clearPeek()
})
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
  clearTimeout(shrinkTimer)
  clearTimeout(chatsHideTimer)
  window.removeEventListener('resize', clampPosition)
})
</script>

<template>
  <section
    ref="box"
    class="mini-surface"
    :class="{ 'is-native': native, 'is-expanded': chatsOpen, 'has-peek': peekVisible }"
    :style="surfaceStyle"
    :data-side="side"
    aria-label="Luczor Mini"
    :data-reduce-motion="snapshot.hud.reduceMotion"
    @pointermove="moveDrag"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @keydown.esc="!$event.defaultPrevented && collapse()"
  >
    <aside v-if="peekVisible" class="mini-peek" @mouseenter="pausePeek" @mouseleave="armPeek">
      <header>
        <strong>Neue Antwort</strong
        ><button type="button" aria-label="Antwortvorschau schließen" @click="clearPeek">
          <AiIcon name="close" :size="13" />
        </button>
      </header>
      <p>{{ peek }}</p>
      <button type="button" class="mini-read" @click="expand">
        Unterhaltung öffnen <AiIcon name="arrow" :size="13" />
      </button>
    </aside>
    <div
      class="mini-orb-dock"
      :data-phase="status.phase"
      :class="{ 'has-pin': !!pinnedPane, 'is-chat-open': chatsOpen }"
      @pointerenter="enterGrip"
      @pointerleave="leaveGrip"
    >
      <!-- Compact grip: chat, system status and connection remain one-click surfaces. -->
      <div
        class="mini-grip"
        role="group"
        aria-label="Mini-Chat, Systemstatus und Verbindung"
        :data-phase="status.phase"
        @keydown="moveKey"
        @pointerdown="beginDrag"
      >
        <button
          type="button"
          class="mini-grip__icon"
          data-kind="chats"
          :class="{ 'is-pinned': pinnedPane === 'chats', 'is-active': activePane === 'chats' }"
          :data-state="chatsState"
          :title="status.detail"
          :aria-label="`Mini-Chat öffnen: ${chatsTitle}`"
          @pointerenter="hoverPane = 'chats'"
          @focus="hoverPane = 'chats'"
          @click="pinPane('chats')"
        >
          <AiIcon name="chat" :size="14" /><span v-if="unread" class="mini-unread">1</span>
        </button>
        <button
          type="button"
          class="mini-grip__icon"
          data-kind="system"
          :class="{ 'is-pinned': pinnedPane === 'system', 'is-active': activePane === 'system' }"
          :data-state="systemState"
          title="Systemstatus · CPU, GPU, RAM, Temperaturen und lokales Modell"
          aria-label="Systemstatus öffnen"
          @pointerenter="hoverPane = 'system'"
          @focus="hoverPane = 'system'"
          @click="pinPane('system')"
        >
          <AiIcon name="gauge" :size="13" />
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
          @focus="hoverPane = 'link'"
          @click="pinPane('link')"
        >
          <AiIcon name="link" :size="13" />
        </button>
      </div>
      <!-- Hover fly-out: one pane per grip icon (hover switches, click pins) -->
      <div class="mini-grip-panel" :data-pane="activePane" :class="{ 'is-chat-open': chatsOpen }">
        <div v-if="chatsVisible" class="mini-panel" :inert="!chatsOpen" @focusin="keepChatsOpen">
          <header class="mini-chat-header">
            <div
              class="mini-chat-header__drag"
              tabindex="0"
              role="group"
              aria-label="Mini-Fenster verschieben"
              title="Ziehen zum Verschieben · Pfeiltasten zum Positionieren"
              @pointerdown="beginDrag"
              @keydown="moveKey"
            >
              <div class="mini-chat-header__orb">
                <StatusOrb :phase="connectionError ? 'error' : status.phase" :level="snapshot.hud.micLevel" />
              </div>
              <div class="mini-chat-header__identity">
                <strong>{{ snapshot.appearance?.assistantName || 'Luczor' }}</strong>
                <span
                  role="status"
                  :title="connectionError || status.detail"
                  :data-phase="connectionError ? 'error' : status.phase"
                  >{{ connectionError ? 'Offline' : status.label }} · {{ modeLabel }}</span
                >
              </div>
            </div>
            <button
              type="button"
              class="mini-chat-icon"
              title="Im Hauptfenster öffnen"
              aria-label="Großes Luczor-Fenster öffnen"
              @click="windowAction('main')"
            >
              <AiIcon name="panel" :size="14" />
            </button>
            <MiniChatPopover label="Mini-Chat Optionen">
              <template #trigger><span class="mini-chat-more" aria-hidden="true">•••</span></template>
              <template #default="{ close }">
                <div class="mini-chat-options">
                  <p>Steuerung · {{ modeLabel }}</p>
                  <button
                    type="button"
                    :aria-pressed="snapshot.mode === 'observe'"
                    @click="menuAction('observe', close)"
                  >
                    <AiIcon name="shield" :size="14" /><span>Beobachten</span
                    ><AiIcon v-if="snapshot.mode === 'observe'" name="check" :size="12" />
                  </button>
                  <button type="button" :aria-pressed="snapshot.mode === 'act'" @click="menuAction('act', close)">
                    <AiIcon name="tool" :size="14" /><span>Handeln mit Freigabe</span
                    ><AiIcon v-if="snapshot.mode === 'act'" name="check" :size="12" />
                  </button>
                  <div class="mini-chat-options__divider"></div>
                  <button v-if="native" type="button" :aria-pressed="pinned" @click="menuAction('pin', close)">
                    <AiIcon name="panel" :size="14" /><span>Immer im Vordergrund</span
                    ><AiIcon v-if="pinned" name="check" :size="12" />
                  </button>
                  <button type="button" @click="menuAction('system', close)">
                    <AiIcon name="gauge" :size="14" /><span>Systemstatus</span>
                  </button>
                  <button type="button" @click="menuAction('link', close)">
                    <AiIcon name="link" :size="14" /><span>{{
                      connectionError ? 'Verbindung prüfen' : 'Verbindung'
                    }}</span>
                  </button>
                  <button type="button" @click="menuAction('position', close)">
                    <AiIcon name="arrow" :size="14" /><span>Unten rechts platzieren</span>
                  </button>
                  <div class="mini-chat-options__divider"></div>
                  <button type="button" @click="menuAction('hide', close)">
                    <AiIcon name="close" :size="14" /><span>Mini-Chat ausblenden</span>
                  </button>
                </div>
              </template>
            </MiniChatPopover>
            <button
              type="button"
              class="mini-chat-icon"
              title="Einklappen"
              aria-label="Mini-Chat einklappen"
              @click="collapse"
            >
              <span aria-hidden="true">−</span>
            </button>
          </header>
          <MiniChatContextPicker :snapshot="snapshot" :disabled="!!connectionError" @action="emit('action', $event)" />
          <ChatComposer
            :title="isChat ? 'Gemeinsame Unterhaltung' : 'Temporäre Workspace-Unterhaltung'"
            :follow="snapshot.messages.length > 0"
          >
            <div v-if="!snapshot.messages.length" class="mini-welcome">
              <AiIcon name="spark" :size="25" />
              <strong>Wobei kann ich helfen?</strong>
              <p>
                {{ isChat ? 'Mit deinem Hauptchat verbunden.' : 'Temporär · bleibt außerhalb deines Chatverlaufs.' }}
              </p>
              <div>
                <button type="button" @click="draft = 'Hilf mir, die nächsten Schritte zu planen.'">
                  Gemeinsam planen <AiIcon name="arrow" :size="12" />
                </button>
                <button type="button" @click="draft = 'Hilf mir, eine Idee weiterzuentwickeln.'">
                  Eine Idee entwickeln <AiIcon name="arrow" :size="12" />
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
                  :waiting="message.status === 'running' && !!decision"
                />
                <ThinkingState
                  v-if="message.activity"
                  :active="message.status === 'running'"
                  :status="
                    message.status === 'running' ? (decision ? 'waiting' : message.activity.status) : message.status
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
                <p
                  v-if="!message.activity && (message.status === 'canceled' || message.status === 'failed')"
                  class="mini-message-status"
                  role="status"
                >
                  {{ message.status === 'canceled' ? 'Abgebrochen' : 'Anfrage fehlgeschlagen' }}
                </p>
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
                <div
                  v-if="decision && message.id === lastAssistant?.id"
                  class="mini-message__approval"
                  aria-label="Freigabe zur aktuellen Antwort"
                >
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
          <p v-if="error" class="mini-error" role="alert">{{ error }}</p>
          <p v-if="copied || clipboardError" class="mini-copy-status" role="status">
            {{ clipboardError || 'Antwort kopiert' }}
          </p>
          <form class="mini-chat-composer" @submit.prevent="send()">
            <p
              v-if="voiceView.error || voiceView.notice || voiceView.mode"
              class="mini-chat-voice-status"
              :role="voiceView.error ? 'alert' : 'status'"
            >
              {{
                voiceView.error ||
                voiceView.notice ||
                (voiceView.mode === 'hands_free' ? 'Zuhören aktiv' : 'Diktat läuft')
              }}
            </p>
            <textarea
              ref="field"
              v-model="draft"
              aria-label="Nachricht im Mini-Chat"
              placeholder="Schreib eine Nachricht …"
              rows="1"
              maxlength="12000"
              @keydown="inputKey"
              @input="miniVoice.manualInput()"
            />
            <div class="mini-chat-composer__actions">
              <label class="mini-chat-attachment" title="Textdatei hinzufügen">
                <AiIcon name="plus" :size="16" />
                <input
                  type="file"
                  aria-label="Textdatei hinzufügen"
                  accept=".txt,.md,.json,.csv,.log,.xml,.html,.css,.js,.ts,.vue,.php"
                  @change="attachFile"
                />
              </label>
              <div @keydown.esc.stop>
                <ThinkingSelector
                  :model-value="snapshot.thinkingTier"
                  :next-prompt="snapshot.busy"
                  @update:model-value="
                    emit('action', { type: 'thinking_tier', sessionId: snapshot.sessionId, tier: $event })
                  "
                />
              </div>
              <span class="mini-chat-composer__spacer"></span>
              <VoiceInputSettings
                compact
                :busy="disabled || voiceView.starting || voiceView.finishing"
                :active="!!voiceView.mode"
                @start="miniVoice.start($event)"
                @stop="miniVoice.stop()"
              />
              <button
                type="button"
                class="mini-chat-icon"
                :title="voiceView.mode === 'hands_free' ? 'Zuhören stoppen' : 'Zuhören'"
                :aria-label="voiceView.mode === 'hands_free' ? 'Zuhören stoppen' : 'Zuhören'"
                :aria-pressed="voiceView.mode === 'hands_free'"
                :disabled="voiceView.starting || voiceView.finishing || (disabled && !voiceView.mode)"
                @click="toggleVoice('hands_free')"
              >
                <AiIcon name="sound" :size="15" />
              </button>
              <button
                type="button"
                class="mini-chat-icon"
                :title="voiceView.mode === 'push_to_talk' ? 'Diktat beenden' : 'Diktieren'"
                :aria-label="voiceView.mode === 'push_to_talk' ? 'Diktat beenden' : 'Diktieren'"
                :aria-pressed="voiceView.mode === 'push_to_talk'"
                :disabled="voiceView.starting || voiceView.finishing || (disabled && !voiceView.mode)"
                @click="toggleVoice('push_to_talk')"
              >
                <AiIcon name="mic" :size="15" />
              </button>
              <button
                v-if="snapshot.busy || snapshot.mainBusy"
                type="button"
                class="mini-chat-send is-stop"
                aria-label="Mini-Anfrage stoppen"
                @click="emit('action', { type: 'stop', sessionId: snapshot.sessionId })"
              >
                <AiIcon name="stop" :size="14" />
              </button>
              <button
                v-else
                type="submit"
                class="mini-chat-send"
                aria-label="Mini-Nachricht senden"
                :disabled="disabled || !draft.trim()"
              >
                <AiIcon name="send" :size="16" />
              </button>
            </div>
          </form>
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
            <template v-else-if="activePane === 'system'">
              <MiniSystemPane
                :system="snapshot.system ?? null"
                :phase="{
                  label: status.label,
                  moving: ['thinking', 'executing', 'listening', 'speaking'].includes(status.phase),
                  locked: snapshot.hud.killSwitch,
                }"
              />
            </template>
            <template v-else>
              <dl class="mini-grip-panel__kv">
                <dt>Server</dt>
                <dd :class="connectionError ? 'is-error' : 'is-ok'">{{ connectionError || 'Verbunden' }}</dd>
                <dt>Projekt</dt>
                <dd>{{ snapshot.project?.name || '–' }}</dd>
                <dt>Modus</dt>
                <dd>{{ snapshot.mode === 'observe' ? 'Beobachten' : 'Handeln' }}</dd>
                <dt>Agent</dt>
                <dd>{{ snapshot.agentMode ? 'aktiv' : 'aus' }}</dd>
                <dt>Sprache</dt>
                <dd>
                  {{ snapshot.voice.recording ? 'nimmt auf' : snapshot.voice.wakeWord ? 'Wake-Word an' : 'aus' }}
                </dd>
                <dt>HUD</dt>
                <dd>{{ snapshot.hud.status || '–' }}</dd>
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
