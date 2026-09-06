<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import StatusOrb from './StatusOrb.vue'
import AiIcon from '../ai/AiIcon.vue'
import ChatComposer from '../ai/ChatComposer.vue'
import StreamingText from '../ai/StreamingText.vue'
import ThinkingState from '../ai/ThinkingState.vue'
import ApprovalCard from '../ai/ApprovalCard.vue'
import ToolChips from '../ai/ToolChips.vue'
import { miniStatus } from '@/services/miniChat/presentation'
import type { MiniAction, MiniSnapshot } from '@/services/miniChat/types'
import type { ActivityStatus } from '../ai/types'
import { useClipboard } from '@/composables/useClipboard'

const props = withDefaults(defineProps<{ snapshot: MiniSnapshot; native?: boolean; connectionError?: string }>(), {
  connectionError: '',
})
const emit = defineEmits<{ action: [action: MiniAction]; hide: []; showMain: [] }>()
const expanded = ref(false)
const pinned = ref(true)
const draft = ref('')
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
const surfaceStyle = computed(() =>
  props.native ? undefined : { right: `${right.value}px`, bottom: `${bottom.value}px` }
)
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
const error = computed(() => props.connectionError || windowError.value || props.snapshot.notice)

async function windowAction(action: string) {
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
  () => props.snapshot.sessionId,
  () => {
    draft.value = ''
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
  layout()
})
onBeforeUnmount(() => {
  clearTimeout(peekTimer)
  clearTimeout(sendTimer)
  window.removeEventListener('resize', clampPosition)
})
</script>

<template>
  <section
    ref="box"
    class="mini-surface"
    :class="{ 'is-native': native, 'is-expanded': expanded, 'has-peek': peekVisible }"
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
        <strong>Luczor <span>Mini</span></strong
        ><span class="mini-temp">Temporär</span>
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
      <div v-if="showLegend" class="mini-legend">
        <p><b>Blau, drehend:</b> Modell arbeitet. <b>Orange, drehend:</b> ein Tool läuft.</p>
        <p>
          <b>Gelb, still:</b> deine Entscheidung. <b>Cyan:</b> Mikrofon aktiv; Ausschlag folgt dem Pegel.
          <b>Grün:</b> Sprachausgabe oder neue Antwort. <b>Rot:</b> Fehler.
        </p>
        <p>Die Ringe zeigen Aktivität, keine geschätzten Fortschrittsprozente.</p>
        <button type="button" class="ai-button" @click="resetPosition">Unten rechts platzieren</button>
      </div>
      <div class="mini-context">
        <span :title="snapshot.project?.name">{{ snapshot.project?.name || 'Kein Projekt' }}</span
        ><button
          type="button"
          @click="emit('action', { type: 'mode', mode: snapshot.mode === 'observe' ? 'act' : 'observe' })"
        >
          {{ snapshot.mode === 'observe' ? 'Beobachten' : snapshot.mode === 'act' ? 'Handeln' : 'Vollzugriff' }}
          <AiIcon name="chevron" :size="10" />
        </button>
      </div>
      <ChatComposer title="Temporäre Unterhaltung" :follow="snapshot.messages.length > 0">
        <div v-if="!snapshot.messages.length" class="mini-welcome">
          <strong>Ein kurzer Gedanke?</strong>
          <p>Schreib hier weiter, während du in anderen Apps arbeitest.</p>
          <small>Kein Projektverlauf · Keine automatische Erinnerung</small>
          <div>
            <button type="button" @click="draft = 'Hilf mir, eine Entscheidung zu treffen.'">
              Entscheidung treffen</button
            ><button type="button" @click="draft = 'Hilf mir, die nächsten Schritte zu sortieren.'">
              Gedanken sortieren
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
            <StreamingText
              :content="message.content"
              :streaming="message.status === 'running'"
              animate
              :actions="false"
              :question="message.question"
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
        <textarea
          ref="field"
          v-model="draft"
          aria-label="Nachricht im Mini-Chat"
          placeholder="Schreib Luczor …"
          rows="1"
          maxlength="12000"
          @keydown="inputKey"
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
        <button type="button" @click="resetConfirm = !resetConfirm">
          <AiIcon name="plus" :size="12" /> Neuer temporärer Chat</button
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
          <button
            type="button"
            aria-label="Mini-Chat verschieben"
            title="Ziehen oder Pfeiltasten"
            @pointerdown="beginDrag($event, true)"
            @keydown="moveKey"
          >
            <AiIcon name="grid" :size="12" /></button
          ><button type="button" aria-label="Mini-Chat ausblenden" @click="windowAction('hide')">
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
        <button type="button" class="mini-status-label" @click="expand">{{ status.label }}</button>
        <span v-if="connectionError" class="mini-disconnected" role="alert">Verbindung fehlt</span>
      </div>
    </template>
  </section>
</template>

<style src="../../styles/mini-chat.css"></style>
