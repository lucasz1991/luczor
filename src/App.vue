<!-- App.vue -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Settings from './components/Settings.vue'
import JarvisHud from './components/JarvisHud.vue'
import RichMessage from './components/RichMessage.vue'
import PlanPanel from './components/PlanPanel.vue'
import AmbientBackdrop from './components/vengeance/AmbientBackdrop.vue'
import SpotlightSurface from './components/vengeance/SpotlightSurface.vue'
import { type LuczorMode, type WireMessage } from './services/openrouter.service'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { runAgent, buildSystemPreamble, shouldRequireToolCall } from '@/services/agent'
import { parseEnvelope } from '@/services/envelope'
import { resolveApproval, rejectAllApprovals } from '@/services/approvals'
import { usePushToTalk } from '@/services/pushToTalk'
import { Store } from '@tauri-apps/plugin-store'
import { VoiceEngine } from '@/services/voice/voiceEngine'
import { getVoiceConfig, getHandsFreeConfig, localStt } from '@/services/voice/localVoice'
import { streamSpeak, stopSpeak } from '@/services/voice/speak'
import { luczorMemory, getMemoryPrefs, type MemoryRecord } from '@/services/memory/luczorMemory'
import { buildPromptContextDetails, inferTaskType, type PromptContextDetails } from '@/services/contextController'
import { LuczorApi } from '@/services/api/luczorApi'
import { refreshStatus } from '@/services/status'
import { appearance } from '@/services/appearance'
import { recordDebugEvent } from '@/services/debug'
import { getSafeRecordValue } from '@/services/safeRecord'
import { buildRecentToolOutcomeContext, toolOutcomePreview } from '@/services/toolOutcomeContext'
import { buildPlanContext } from '@/services/plan'
import { ACTIVE_MODE_KEY, createAppRuntimeLifecycle } from '@/services/appRuntimeLifecycle'
import {
  bindRepository,
  getRepositoryExternalPolicy,
  indexRepository,
  repositoryGraphStatus,
  unbindRepository,
  type RepositoryExternalPolicy,
  type RepositoryGraphStatus,
} from '@/services/repositoryGraph'

import { setStatus } from '@/state/hud'
import { state, mutations } from '@/state/store'
import { scheduleSave } from '@/services/persistence'
import { playSfx, stopSfx } from '@/services/sfx'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { useChatComposer } from '@/composables/useChatComposer'
import {
  clampNumber,
  compactHistory,
  formatChatTime,
  goalStatusLabel,
  previewToolArguments,
  safeTrim,
} from '@/services/chatPresentation'

/* -------------------------------------------------
 * Local UI state
 * ------------------------------------------------- */
type SettingsStartTab = 'server' | 'notifications'
const showSettings = ref(false)
const settingsStartTab = ref<SettingsStartTab>('server')
const showSystemPanel = ref(false)
const { input, composerRef, autoGrow, setInput: setComposerInput, consumeInputSource } = useChatComposer()
const sending = ref(false)
const mode = ref<LuczorMode>('observe')
const allowUnrestricted = ref(false)

function openSettings(tab: SettingsStartTab = 'server') {
  settingsStartTab.value = tab
  showSettings.value = true
}

const abortController = ref<AbortController | null>(null)
let cancelCurrent: null | (() => Promise<void>) = null

function openNotificationCenter() {
  openSettings('notifications')
}

/* -------------------------------------------------
 * Runtime lifecycle
 * ------------------------------------------------- */
const appRuntimeLifecycle = createAppRuntimeLifecycle({
  mode,
  allowUnrestricted,
  getActiveProjectId: () => activeProjectId.value,
  openProject,
  openNotificationCenter,
  togglePushToTalk,
})

onMounted(() => appRuntimeLifecycle.start())
onBeforeUnmount(() => appRuntimeLifecycle.stop())

/* -------------------------------------------------
 * Auto-Speech (Settings -> speak())
 * ------------------------------------------------- */
type ChatAutoSpeechMode = 'off' | 'assistant_only' | 'all'

async function getAutoSpeechSettings(): Promise<{
  enabled: boolean
  mode: ChatAutoSpeechMode
  rate: number
  volume: number
}> {
  const store = await Store.load('luczor.settings.json')

  const enabled = (await store.get<boolean>('chat_auto_speech')) ?? false
  const mode = (await store.get<ChatAutoSpeechMode>('chat_auto_speech_mode')) ?? 'assistant_only'
  const rate = (await store.get<number>('chat_auto_speech_rate')) ?? 1.0
  const volume = (await store.get<number>('chat_auto_speech_volume')) ?? 90

  const safeMode: ChatAutoSpeechMode =
    mode === 'off' || mode === 'assistant_only' || mode === 'all' ? mode : 'assistant_only'

  return {
    enabled: !!enabled,
    mode: safeMode,
    rate: clampNumber(Number(rate) || 1.0, 0.5, 2.0),
    volume: clampNumber(Number(volume) || 90, 0, 100),
  }
}

function shouldSpeakAssistant(m: ChatAutoSpeechMode) {
  return m === 'assistant_only' || m === 'all'
}

type InterruptMode = 'on_speech' | 'on_activation_phrase' | 'off'
/** SOLL §6 — TTS playback controls (rate 0.5–2, volume 0–1) + interrupt mode. */
async function getTtsConfig(): Promise<{ rate: number; volume: number; interruptMode: InterruptMode }> {
  const store = await Store.load('luczor.settings.json')
  const rateRaw = Number(
    (await store.get<number>('voice_tts_rate')) ?? (await store.get<number>('chat_auto_speech_rate')) ?? 1.0
  )
  const volRaw = Number(
    (await store.get<number>('voice_tts_volume')) ?? (await store.get<number>('chat_auto_speech_volume')) ?? 90
  )
  const im = String((await store.get<string>('voice_interrupt_mode')) ?? 'on_speech')
  return {
    rate: clampNumber(Number.isFinite(rateRaw) ? rateRaw : 1.0, 0.5, 2.0),
    volume: clampNumber(Number.isFinite(volRaw) ? volRaw : 90, 0, 100) / 100,
    interruptMode: im === 'off' || im === 'on_activation_phrase' ? (im as InterruptMode) : 'on_speech',
  }
}

let _lastSpokenAssistantId: string | null = null

function speakMessage(m: any) {
  try {
    const q = ((m?.meta as any)?.question ?? '').toString().trim()
    const content = (m?.content ?? '').toString().trim()
    const text = (content + (q ? ' ' + q : '')).trim()
    if (!text) return
    void speakWithVoiceMuted(text).catch(error => {
      void recordDebugEvent('error', 'manual_tts_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    })
  } catch (e) {
    console.error('[speakMessage] error:', e)
  }
}

async function rateAssistantMessage(m: any, rating: 1 | -1) {
  const requestId = String(m?.meta?.llmRequestId ?? '')
  if (!requestId) return
  const current = mutations.getProjectMessages(m.projectId ?? activeProjectId.value).find(x => x.id === m.id)
  mutations.patchMessage(m.projectId ?? activeProjectId.value, m.id, {
    meta: { ...(current?.meta ?? {}), userFeedback: rating } as any,
  })
  try {
    await LuczorApi.evaluateLlmRun(requestId, {
      evaluator_id: 'luczor.user.feedback.v1',
      status: rating > 0 ? 'passed' : 'failed',
      success_score: rating > 0 ? 1 : 0,
      quality_score: rating > 0 ? 1 : 0,
      user_feedback: rating,
    })
  } catch (e) {
    console.warn('[evaluation] feedback sync failed:', e)
  }
}

async function autoSpeakAssistantIfEnabled(pid: string, assistantId: string) {
  if (_lastSpokenAssistantId === assistantId) return

  const msg = mutations.getProjectMessages(pid).find(m => m.id === assistantId)
  const parts = [
    safeTrim(msg?.content),
    safeTrim((msg?.meta as any)?.question ?? (msg?.meta as any)?.content ?? ''),
  ].filter(Boolean)
  const text = parts.join(' ')

  if (!text) return
  if (text.startsWith('[Fehler]')) return

  const s = await getAutoSpeechSettings()
  if (!s.enabled) return
  if (!shouldSpeakAssistant(s.mode)) return

  _lastSpokenAssistantId = assistantId

  try {
    await speakWithVoiceMuted(text)
  } catch (e) {
    console.error('[AutoSpeech] speak() failed:', e)
    void recordDebugEvent('error', 'auto_tts_failed', { message: e instanceof Error ? e.message : String(e) })
  }
}

/* -------------------------------------------------
 * Loading indicator (Assistant bubble)
 * ------------------------------------------------- */
const assistantLoadingTimer = ref<number | null>(null)
const assistantLoadingId = ref<string | null>(null)

function startAssistantLoading(pid: string, msgId: string) {
  stopAssistantLoading()
  assistantLoadingId.value = msgId

  // No placeholder text: the UI shows animated typing dots while
  // meta.isLoading is true and there is no content yet.
  const current = mutations.getProjectMessages(pid).find(m => m.id === msgId)
  mutations.patchMessage(pid, msgId, {
    content: '',
    meta: { ...(current?.meta ?? {}), isLoading: true } as any,
  })
}

function stopAssistantLoading() {
  if (assistantLoadingTimer.value) {
    window.clearInterval(assistantLoadingTimer.value)
    assistantLoadingTimer.value = null
  }
  assistantLoadingId.value = null
}

/* -------------------------------------------------
 * Derived state from store
 * ------------------------------------------------- */
const projects = computed(() => state.projects)

const activeProjectId = computed<string>({
  get() {
    state.global.ui ??= {}
    return state.global.ui.lastProjectId ?? state.projects[0]?.id ?? 'default'
  },
  set(id) {
    mutations.setActiveProject(id)
  },
})

const activeProject = computed(() => projects.value.find(p => p.id === activeProjectId.value))
const messages = computed(() => mutations.getProjectMessages(activeProjectId.value))

const { forceScroll } = useAutoScroll(messages, {
  selector: '#messages',
  thresholdPx: 140,
  behavior: 'smooth',
})

/* -------------------------------------------------
 * Project Info Panel (Goals + Summaries)
 * ------------------------------------------------- */
const projectGoals = computed<any[]>(() => {
  const p: any = activeProject.value as any
  return Array.isArray(p?.goals) ? p.goals : []
})

const goalStats = computed(() => {
  const goals = projectGoals.value
  const total = goals.length
  const done = goals.filter(g => g?.status === 'done').length
  const inProgress = goals.filter(g => g?.status === 'in_progress').length
  const open = goals.filter(g => g?.status === 'open').length
  return { total, open, inProgress, done }
})

const projectSummaries = computed<any[]>(() => {
  const pid = activeProjectId.value
  const p: any = activeProject.value as any

  const items: any[] = []

  const rolling = safeTrim(p?.summary)
  if (rolling) {
    items.push({
      id: `rolling_${pid}`,
      createdAt: p?.updatedAt ?? Date.now(),
      text: rolling,
    })
  }

  const history: any[] = Array.isArray((state as any).summaries) ? (state as any).summaries : []
  const last = history
    .filter(s => s?.projectId === pid)
    .sort((a, b) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0))
    .slice(-3)

  for (const s of last) {
    items.push({
      id: s.id ?? `sum_${s.createdAt ?? s.ts ?? Math.random()}`,
      createdAt: s.createdAt ?? s.ts ?? Date.now(),
      text: s.text ?? s.summary ?? s.content ?? '',
    })
  }

  return items
    .filter(x => safeTrim(x.text).length)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 3)
})

/* -------------------------------------------------
 * Core actions
 * ------------------------------------------------- */
async function stopGenerating() {
  stopAssistantLoading()
  _lastSpokenAssistantId = null

  // Unblock any tool call awaiting user approval (rejects them).
  rejectAllApprovals()

  try {
    stopSfx('loading')
  } catch {}

  if (cancelCurrent) {
    try {
      await cancelCurrent()
    } catch {}
    cancelCurrent = null
  }

  abortController.value?.abort()
  abortController.value = null
  sending.value = false
}

function openProject(id: string) {
  void stopGenerating()
  activeProjectId.value = id
}

function newChat() {
  void stopGenerating()
  mutations.resetProjectChat(activeProjectId.value)
}

function addProject() {
  void stopGenerating()
  const id = `p_${Math.random().toString(16).slice(2)}`
  const name = `Projekt ${projects.value.length + 1}`
  mutations.addProject({ id, name })
  activeProjectId.value = id
}

/* -------------------------------------------------
 * Push-to-talk (local whisper.cpp STT)
 * ------------------------------------------------- */
const { isRecording, start: startPtt, stop: stopPtt, cancel: cancelPtt } = usePushToTalk()

async function togglePushToTalk() {
  const pid = activeProjectId.value

  if (!isRecording.value) {
    try {
      await startPtt()
      setStatus('listening')
    } catch (e: any) {
      setStatus('error')
      mutations.addMessage(mutations.makeMsg('assistant', `Mikrofon-Fehler: ${e?.message ?? String(e)}`, pid))
    }
    return
  }

  const audio = await stopPtt()
  setStatus('idle')
  if (!audio) return

  try {
    setComposerInput(await transcribeLocal(audio.base64), 'push_to_talk')
  } catch (e: any) {
    void recordDebugEvent('error', 'assistant_request_failed', {
      message: e?.message ?? String(e),
      status: e?.status ?? null,
    })
    mutations.addMessage(mutations.makeMsg('assistant', `STT Fehler: ${e?.message ?? String(e)}`, pid))
  }
}

/* -------------------------------------------------
 * Continuous listening (VAD + wake word)
 * ------------------------------------------------- */
const voiceEngine = new VoiceEngine()
const listening = ref(false)
const lastHeard = ref('')
let voiceMuteDepth = 0

/** Keep continuous STT from hearing Luczor's own local TTS output. */
async function speakWithVoiceMuted(text: string): Promise<void> {
  const tts = await getTtsConfig()
  voiceMuteDepth += 1
  voiceEngine.setMuted(true)
  try {
    await streamSpeak(text, { rate: tts.rate, volume: tts.volume })
  } finally {
    voiceMuteDepth = Math.max(0, voiceMuteDepth - 1)
    voiceEngine.setMuted(voiceMuteDepth > 0)
  }
}
const listenLabel = ref('Zuhören')

async function transcribeLocal(wavBase64: string): Promise<string> {
  const cfg = await getVoiceConfig()
  return localStt(wavBase64, cfg.localSttLanguage)
}

async function transcribeUtterance(wavBase64: string): Promise<string> {
  return transcribeLocal(wavBase64)
}

async function toggleListening() {
  if (listening.value) {
    await voiceEngine.stop()
    listening.value = false
    lastHeard.value = ''
    return
  }
  const cfg = await getVoiceConfig()
  const hf = await getHandsFreeConfig()
  const tts = await getTtsConfig()
  listenLabel.value = hf.strategy === 'safeword' ? `Aktivierungsphrase „${hf.triggerPhrase}“` : 'Dauerzuhören'
  lastHeard.value = ''
  try {
    await voiceEngine.start({
      // SOLL §5.3 — the hands-free strategy (continuous XOR safeword) drives
      // segmentation; the legacy mode field is kept only for type compatibility.
      mode: 'continuous',
      wakeWord: cfg.wakeWord,
      handsFree: hf,
      bargeIn: tts.interruptMode === 'on_speech',
      onInterrupt: () => stopSpeak(),
      transcribe: wav => transcribeUtterance(wav),
      onUtterance: text => {
        lastHeard.value = text
      },
      onPartial: text => {
        lastHeard.value = text
      },
      onError: error => {
        void recordDebugEvent('error', 'continuous_stt_failed', { message: error.message })
      },
      onCommand: text => {
        const t = text.trim()
        if (!t || sending.value) return
        setComposerInput(t, 'hands_free')
        void send()
      },
    })
    listening.value = true
  } catch (e: any) {
    listening.value = false
    setStatus('error')
    mutations.addMessage(
      mutations.makeMsg('assistant', `Zuhören fehlgeschlagen: ${e?.message ?? String(e)}`, activeProjectId.value)
    )
  }
}

/* -------------------------------------------------
 * Tool-call approvals (human-in-the-loop)
 * ------------------------------------------------- */
const pendingApprovals = computed(() => {
  const pid = activeProjectId.value
  const bucket = getSafeRecordValue(state.pending?.toolCallsByProject ?? {}, pid) ?? []
  return bucket.filter(c => c.status === 'proposed' && c.requiresApproval)
})

function approveTool(id: string) {
  mutations.updateToolCallStatus(activeProjectId.value, id, 'approved')
  resolveApproval(id, true)
}

function rejectTool(id: string) {
  mutations.updateToolCallStatus(activeProjectId.value, id, 'rejected')
  resolveApproval(id, false)
}

/**
 * Cycle: Beobachten -> Handeln -> Vollzugriff -> Beobachten.
 * Entering "unrestricted" requires an explicit confirmation, because it
 * bypasses the approval gate entirely (only the Not-Aus still stops tools).
 */
async function persistActiveMode(value: LuczorMode) {
  try {
    const st = await Store.load('luczor.settings.json')
    await st.set(ACTIVE_MODE_KEY, value)
    await st.save()
  } catch {
    /* the in-memory selection still applies for this session */
  }
}

function toggleMode() {
  const next: LuczorMode =
    mode.value === 'observe' ? 'act' : mode.value === 'act' && allowUnrestricted.value ? 'unrestricted' : 'observe'

  if (next === 'unrestricted') {
    const ok = window.confirm(
      'VOLLZUGRIFF aktivieren?\n\n' +
        'Luczor führt dann ALLE Tools (Maus, Tastatur, Programme, Dateien) OHNE Rückfrage aus. ' +
        'Nur der Not-Aus im HUD stoppt ihn noch.\n\nWirklich aktivieren?'
    )
    if (!ok) {
      return
    }
  }
  mode.value = next
  void persistActiveMode(next)
}

const modeLabel = computed(() =>
  mode.value === 'unrestricted' ? 'Vollzugriff' : mode.value === 'act' ? 'Handeln' : 'Beobachten'
)
const modeTitle = computed(() => {
  switch (mode.value) {
    case 'act':
      return allowUnrestricted.value
        ? 'Handeln: Tools mit Bestätigung. Klicken für Vollzugriff.'
        : 'Handeln: Tools mit Bestätigung. Vollzugriff ist administrativ deaktiviert; klicken für Beobachten.'
    case 'unrestricted':
      return 'Vollzugriff: alle Tools OHNE Rückfrage. Klicken für Beobachten.'
    default:
      return 'Beobachten: nur lesen. Klicken für Handeln.'
  }
})

/* -------------------------------------------------
 * Tool audit log (from hidden tool messages)
 * ------------------------------------------------- */
const showAudit = ref(false)
// Context panel (goals + summaries) is collapsed by default for a chat-first UI.
const showContext = ref(false)
const repositoryRootInput = ref('')
const localGraphStatus = ref<RepositoryGraphStatus>({
  status: 'unbound',
  files: 0,
  symbols: 0,
  edges: 0,
  skipped: 0,
})
const localGraphBusy = ref(false)
const localGraphMessage = ref('')
const repositoryExternalPolicy = ref<RepositoryExternalPolicy>('deny')
const memoryCandidates = ref<MemoryRecord[]>([])
const memoryCandidateBusyId = ref('')

async function requireRepositoryPrincipalId(): Promise<string> {
  const account = await getVerifiedAccountSnapshot()
  if (!account) {
    throw new Error(
      'Für einen accountgebundenen lokalen Repository-Graph muss zuerst ein Device-Key eingerichtet sein.'
    )
  }
  return account.principalId
}

async function refreshMemoryCandidates() {
  try {
    memoryCandidates.value = await luczorMemory.listCandidates(activeProjectId.value)
  } catch (error) {
    console.warn('[memory] candidate list unavailable:', error)
    memoryCandidates.value = []
  }
}

async function acceptMemoryCandidate(record: MemoryRecord) {
  if (memoryCandidateBusyId.value) return
  memoryCandidateBusyId.value = record.id
  try {
    await luczorMemory.promote(record.id)
    await refreshMemoryCandidates()
    void refreshStatus()
  } finally {
    memoryCandidateBusyId.value = ''
  }
}

async function rejectMemoryCandidate(record: MemoryRecord) {
  if (memoryCandidateBusyId.value) return
  memoryCandidateBusyId.value = record.id
  try {
    await luczorMemory.forget('project', record.id, { projectId: activeProjectId.value })
    await refreshMemoryCandidates()
    void refreshStatus()
  } finally {
    memoryCandidateBusyId.value = ''
  }
}

async function refreshLocalGraphStatus() {
  try {
    const principalId = await requireRepositoryPrincipalId()
    localGraphStatus.value = await repositoryGraphStatus(principalId, activeProjectId.value)
  } catch (error) {
    localGraphStatus.value = {
      status: 'error',
      files: 0,
      symbols: 0,
      edges: 0,
      skipped: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function bindAndIndexRepository() {
  const root = repositoryRootInput.value.trim()
  if (!root || localGraphBusy.value) return
  localGraphBusy.value = true
  localGraphMessage.value = 'Repository wird lokal gebunden …'
  try {
    const principalId = await requireRepositoryPrincipalId()
    await bindRepository(principalId, activeProjectId.value, root)
    repositoryRootInput.value = ''
    localGraphMessage.value = 'Lokaler Index wird aufgebaut …'
    await indexRepository(principalId, activeProjectId.value)
    localGraphMessage.value = 'Lokaler Repository-Graph ist bereit.'
  } catch (error) {
    localGraphMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    localGraphBusy.value = false
    await refreshLocalGraphStatus()
  }
}

async function reindexRepository() {
  if (localGraphBusy.value) return
  localGraphBusy.value = true
  localGraphMessage.value = 'Änderungen werden lokal indexiert …'
  try {
    const principalId = await requireRepositoryPrincipalId()
    await indexRepository(principalId, activeProjectId.value)
    localGraphMessage.value = 'Lokaler Repository-Graph ist aktuell.'
  } catch (error) {
    localGraphMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    localGraphBusy.value = false
    await refreshLocalGraphStatus()
  }
}

async function removeRepositoryBinding() {
  if (localGraphBusy.value) return
  localGraphBusy.value = true
  try {
    const principalId = await requireRepositoryPrincipalId()
    await unbindRepository(principalId, activeProjectId.value, true)
    localGraphMessage.value = 'Lokale Repository-Bindung und Index wurden gelöscht.'
  } finally {
    localGraphBusy.value = false
    await refreshLocalGraphStatus()
  }
}

async function saveRepositoryPolicy() {
  const settings = await Store.load('luczor.settings.json')
  await settings.set('repository_external_policy', repositoryExternalPolicy.value)
  await settings.save()
}

watch(
  activeProjectId,
  async () => {
    repositoryRootInput.value = ''
    localGraphMessage.value = ''
    repositoryExternalPolicy.value = await getRepositoryExternalPolicy()
    await Promise.all([refreshLocalGraphStatus(), refreshMemoryCandidates()])
  },
  { immediate: true }
)
// Plan panel starts expanded: it only appears once the agent created a plan.
const planCollapsed = ref(false)

const toolAudit = computed(() => {
  const pid = activeProjectId.value
  return mutations
    .getProjectMessages(pid, { includeHidden: true })
    .filter(m => m.role === 'tool')
    .slice(-12)
    .reverse()
    .map(m => ({
      id: m.id,
      name: (m.meta as any)?.toolName ?? 'tool',
      ok: !!(m.parsed as any)?.ok,
      error: safeTrim((m.parsed as any)?.error),
      result: toolOutcomePreview(m),
      ts: m.ts,
    }))
})

/* -------------------------------------------------
 * Streamed envelope -> message rendering
 * ------------------------------------------------- */
function applyStreamedContent(pid: string, msgId: string, raw: string, done: boolean) {
  const env = parseEnvelope(raw)
  if (env) {
    mutations.patchMessage(pid, msgId, {
      raw,
      parsed: env as any,
      content: env.summary,
      meta: {
        isLoading: done ? false : !env.complete,
        summary: env.summary,
        question: env.question,
        bullets: env.bullets,
      } as any,
    })
    return
  }

  // Plain (non-envelope) text. Reset any question/bullets/summary that a
  // transient partial-envelope parse may have left behind, so stale suggestion
  // chips don't linger when the final text is not a valid envelope.
  const text = safeTrim(raw)
  mutations.patchMessage(pid, msgId, {
    raw,
    content: text || (done ? 'Fertig.' : ''),
    meta: { isLoading: !done, question: '', bullets: [], summary: '' } as any,
  })
}

/** Click a suggestion chip -> send it as the next user message. */
function sendSuggestion(text: string) {
  const t = safeTrim(text)
  if (!t || sending.value) return
  input.value = t
  void send()
}

/** Persist the exchange to long-term memory (project scope). */
async function rememberExchange(pid: string, userText: string, assistantId: string) {
  try {
    const prefs = await getMemoryPrefs()
    if (!prefs.autoRemember) return
    const msg = mutations.getProjectMessages(pid).find(m => m.id === assistantId)
    const summary = safeTrim(msg?.content)
    if (userText) {
      await luczorMemory.remember({
        content: userText,
        scope: 'project',
        projectId: pid,
        source: 'user',
        writeIntent: 'automatic',
      })
    }
    if (summary && !summary.startsWith('[Fehler]') && summary !== 'Fertig.') {
      await luczorMemory.remember({
        content: summary,
        scope: 'project',
        projectId: pid,
        source: 'assistant',
        writeIntent: 'automatic',
      })
    }
    await refreshMemoryCandidates()
    void refreshStatus()
  } catch (e) {
    console.warn('[memory] remember skipped:', e)
  }
}

/* -------------------------------------------------
 * Send
 * ------------------------------------------------- */
async function send() {
  const pid = activeProjectId.value
  const text = input.value.trim()
  if (!text || sending.value) return
  const taskType = inferTaskType(text)
  // Capture + reset how this turn was produced (spoken vs typed).
  const inputSource = consumeInputSource()

  void playSfx('submit')
  await stopGenerating()

  // user message (tag spoken input for the "Gesprochen" badge)
  const userMsg = mutations.makeMsg('user', text, pid)
  userMsg.meta = { ...(userMsg.meta ?? {}), inputSource }
  mutations.addMessage(userMsg)
  await forceScroll('auto')
  input.value = ''
  void nextTick(() => autoGrow())
  sending.value = true

  // assistant placeholder
  const assistant = mutations.makeMsg('assistant', '', pid)
  assistant.raw = ''
  assistant.parsed = null
  mutations.addMessage(assistant)
  await forceScroll('auto')

  await nextTick()
  startAssistantLoading(pid, assistant.id)

  const abort = new AbortController()
  abortController.value = abort
  cancelCurrent = async () => abort.abort()

  // Build the wire history: system preamble + visible user/assistant text.
  const prj = activeProject.value
  const fullHistory: WireMessage[] = mutations
    .getProjectMessages(pid)
    .filter(m => m.id !== assistant.id)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => safeTrim(m.content).length > 0)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  const settingsStore = await Store.load('luczor.settings.json')
  const historyBudget = clampNumber(
    (await settingsStore.get<number>('client_history_token_budget')) ?? 2400,
    400,
    12000
  )
  const history = compactHistory(fullHistory, historyBudget)

  const baseMessages: WireMessage[] = [
    { role: 'system', content: buildSystemPreamble(mode.value, prj?.name ?? pid, appearance.assistantName) },
    ...(safeTrim((prj as any)?.summary)
      ? [{ role: 'system' as const, content: `Projektzusammenfassung: ${safeTrim((prj as any).summary)}` }]
      : []),
    ...history,
  ]
  const recentToolContext = buildRecentToolOutcomeContext(mutations.getProjectMessages(pid, { includeHidden: true }))
  if (recentToolContext) baseMessages.splice(1, 0, { role: 'system', content: recentToolContext })

  // Keep the active plan in front of the model across turns.
  const planContext = buildPlanContext(pid)
  if (planContext) baseMessages.splice(1, 0, { role: 'system', content: planContext })

  // Inject relevant long-term memory (project scope) as an extra system note.
  let promptContext: PromptContextDetails = { text: '', taskType }
  try {
    const prefs = await getMemoryPrefs()
    if (prefs.inject) {
      // Context Controller (server) ranks + budgets memory; local fallback.
      promptContext = await buildPromptContextDetails(pid, text, prefs.injectCount, taskType)
      if (promptContext.repositoryApprovalRequired) {
        const approved = window.confirm(
          'Für diese Codefrage wurden passende lokale Repository-Treffer gefunden.\n\n' +
            'Dürfen ausschließlich die ausgewählten, begrenzten und redigierten Ausschnitte für diese eine Modellanfrage verwendet werden?'
        )
        if (approved) {
          promptContext = await buildPromptContextDetails(pid, text, prefs.injectCount, taskType, true)
        }
      }
      if (promptContext.text) baseMessages.splice(1, 0, { role: 'system', content: promptContext.text })
    }
  } catch (e) {
    console.warn('[memory] context injection skipped:', e)
  }

  let streamStarted = false

  try {
    void playSfx('loading')
    const { finalText, requestId, model, provider, useCase, toolFailures, toolSuccesses } = await runAgent({
      projectId: pid,
      baseMessages,
      mode: mode.value,
      getMode: () => mode.value,
      toolChoice: shouldRequireToolCall(text) ? 'required' : 'auto',
      taskType: promptContext.taskType,
      contextId: promptContext.contextId,
      repoId: promptContext.repoId,
      branch: promptContext.branch,
      commitSha: promptContext.commitSha,
      inputSource,
      signal: abort.signal,

      // Live streaming: parse the envelope progressively and render it.
      onToken: raw => {
        if (!streamStarted) {
          streamStarted = true
          stopAssistantLoading()
          try {
            stopSfx('loading')
          } catch {}
        }
        applyStreamedContent(pid, assistant.id, raw, false)
      },
    })

    try {
      stopSfx('loading')
    } catch {}
    stopAssistantLoading()

    applyStreamedContent(pid, assistant.id, finalText, true)
    // Attach the server-reported routing metadata to the assistant message.
    {
      const current = mutations.getProjectMessages(pid).find(m => m.id === assistant.id)
      mutations.patchMessage(pid, assistant.id, {
        meta: { ...(current?.meta ?? {}), model, provider, useCase },
      })
    }
    if (requestId) {
      const current = mutations.getProjectMessages(pid).find(m => m.id === assistant.id)
      mutations.patchMessage(pid, assistant.id, {
        meta: { ...(current?.meta ?? {}), llmRequestId: requestId, userFeedback: null } as any,
      })
      void LuczorApi.evaluateLlmRun(requestId, {
        evaluator_id: 'luczor.client.outcome.v1',
        status: toolFailures > 0 ? 'needs_review' : 'unverified',
        success_score: toolFailures > 0 ? 0.25 : toolSuccesses > 0 ? 0.75 : 0.5,
        payload: { tool_failures: toolFailures, tool_successes: toolSuccesses, finish: 'assistant_response' },
      }).catch(e => console.warn('[evaluation] deferred:', e))
    }

    setStatus('idle')
    void autoSpeakAssistantIfEnabled(pid, assistant.id)
    void rememberExchange(pid, text, assistant.id)
  } catch (e: any) {
    try {
      stopSfx('loading')
    } catch {}
    stopAssistantLoading()

    const current = mutations.getProjectMessages(pid).find(m => m.id === assistant.id)
    const currentContent = safeTrim(current?.content)

    if (e?.name === 'AbortError') {
      setStatus('idle')
      mutations.patchMessage(pid, assistant.id, {
        content: currentContent || 'Abgebrochen.',
        meta: { ...(current?.meta ?? {}), isLoading: false } as any,
      })
      return
    }

    setStatus('error')
    mutations.patchMessage(pid, assistant.id, {
      content: `[Fehler] ${e?.message ?? String(e)}`,
      meta: { ...(current?.meta ?? {}), isLoading: false } as any,
    })
  } finally {
    try {
      stopSfx('loading')
    } catch {}

    if (abortController.value === abort) abortController.value = null
    sending.value = false
    cancelCurrent = null
  }
}

/* -------------------------------------------------
 * Persistence (autosave)
 * ------------------------------------------------- */
watch(
  () => state,
  () => scheduleSave(state),
  { deep: true }
)
</script>

<template>
  <Settings :open="showSettings" :initial-tab="settingsStartTab" @update:open="showSettings = $event" />
  <AmbientBackdrop />

  <div class="app-shell">
    <aside class="sidebar" aria-label="Hauptnavigation">
      <div class="brand" :title="appearance.assistantName">
        <span class="brand__dot" />
        <span class="brand__word">{{ appearance.assistantName.slice(0, 1).toUpperCase() }}</span>
      </div>
      <div class="brand__project">Workspace</div>

      <div class="side-actions">
        <button class="btn-ghost" type="button" title="Neuer Chat" @click="newChat">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span class="dock-label">Neuer Chat</span>
        </button>
        <button class="btn-ghost" type="button" title="Neues Projekt" @click="addProject">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 19V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
            <path d="M12 11v6M9 14h6" />
          </svg>
          <span class="dock-label">Neues Projekt</span>
        </button>
      </div>

      <div class="side-listhead">
        <span class="tac-label">Projekte</span>
        <span class="side-count">{{ projects.length }}</span>
      </div>

      <div class="project-list">
        <button
          v-for="p in projects"
          :key="p.id"
          type="button"
          class="project-item"
          :class="{ 'is-active': p.id === activeProjectId }"
          :title="p.name"
          :aria-label="`Projekt ${p.name}`"
          :aria-current="p.id === activeProjectId ? 'page' : undefined"
          @click="openProject(p.id)"
        >
          <span class="project-item__glyph">{{ p.name.slice(0, 2).toUpperCase() }}</span>
          <span class="project-item__copy">
            <span class="project-item__name">{{ p.name }}</span>
            <span class="project-item__id">{{ p.id }}</span>
          </span>
        </button>
      </div>

      <div class="side-settings">
        <button
          class="settings-btn system-panel-toggle"
          type="button"
          :aria-expanded="showSystemPanel"
          aria-controls="system-panel"
          title="Systemstatus und Not-Aus"
          @click="showSystemPanel = !showSystemPanel"
        >
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="4" y="4" width="16" height="16" rx="4" />
            <path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
          </svg>
          <span class="dock-label">Systemstatus</span>
        </button>
        <button class="settings-btn" type="button" @click="openSettings('server')">
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M10 12a2 2 0 1 1 4 0v1" />
            <path d="M9 13h6v4H9z" />
          </svg>
          <span class="dock-label">Einstellungen</span>
        </button>
      </div>
    </aside>

    <main class="main-col">
      <div class="header">
        <div class="header__identity">
          <span class="header__eyebrow">Aktiver Raum</span>
          <div class="header__title">{{ activeProject?.name }}</div>
        </div>

        <button
          type="button"
          class="mode-toggle"
          :class="`is-${mode}`"
          :title="modeTitle"
          :aria-label="modeTitle"
          @click="toggleMode"
        >
          <span class="mode-toggle__dot" />
          {{ modeLabel }}
        </button>

        <button
          type="button"
          class="icon-btn"
          :class="{ 'is-on': showContext }"
          title="Projektziele & Zusammenfassungen"
          :aria-expanded="showContext"
          @click="showContext = !showContext"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </button>

        <button
          type="button"
          class="icon-btn"
          :class="{ 'is-on': showAudit }"
          title="Tool-Protokoll"
          :aria-expanded="showAudit"
          @click="showAudit = !showAudit"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="8" y1="6" x2="20" y2="6" />
            <line x1="8" y1="12" x2="20" y2="12" />
            <line x1="8" y1="18" x2="20" y2="18" />
            <circle cx="3.5" cy="6" r="1" />
            <circle cx="3.5" cy="12" r="1" />
            <circle cx="3.5" cy="18" r="1" />
          </svg>
        </button>

        <button
          type="button"
          class="icon-btn notification-btn"
          title="Push-Benachrichtigungen"
          aria-label="Push-Benachrichtigungen"
          @click="openSettings('notifications')"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </svg>
        </button>

        <button
          type="button"
          class="icon-btn icon-btn--danger"
          title="Neuer Chat / Reset"
          aria-label="Neuer Chat / Reset"
          @click="newChat"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      <!-- Unrestricted-mode warning -->
      <div v-if="mode === 'unrestricted'" class="mode-warning">
        ⚠ VOLLZUGRIFF AKTIV — Luczor führt Tools ohne Rückfrage aus. Not-Aus im HUD stoppt sofort.
      </div>

      <!-- Project info strip (collapsible) -->
      <div v-if="showContext" class="info-strip">
        <div class="info-block">
          <div class="info-head">
            <span class="tac-label">Projektziele</span>
            <span class="info-stat">
              {{ goalStats.done }}/{{ goalStats.total }} erledigt · {{ goalStats.inProgress }} aktiv ·
              {{ goalStats.open }} offen
            </span>
          </div>
          <div v-if="projectGoals.length" class="goal-cards">
            <div v-for="g in projectGoals.slice(0, 6)" :key="g.id" class="goal-card">
              <span class="goal-card__text">{{ g.title }}</span>
              <span class="badge" :class="g.status" :title="g.status">{{ goalStatusLabel(g.status) }}</span>
            </div>
          </div>
          <div v-else class="empty">Noch keine Ziele im Projekt.</div>
        </div>

        <div class="info-block">
          <span class="tac-label">Zusammenfassungen</span>
          <div v-if="projectSummaries.length" class="summaries">
            <div v-for="s in projectSummaries" :key="s.id ?? s.createdAt ?? s.ts" class="summary-row">
              {{ s.text ?? s.summary ?? s.content ?? '' }}
              <time>{{ formatChatTime(s.createdAt ?? s.ts ?? Date.now()) }}</time>
            </div>
          </div>
          <div v-else class="empty">Noch keine Summaries.</div>
        </div>

        <div class="info-block repo-graph-block">
          <div class="info-head">
            <span class="tac-label">Lokaler Repository-Graph</span>
            <span class="info-stat" :class="`is-${localGraphStatus.status}`">
              {{ localGraphStatus.status === 'ready' ? 'bereit' : localGraphStatus.status }}
            </span>
          </div>

          <div v-if="localGraphStatus.status === 'ready'" class="repo-graph-summary">
            <strong>{{ localGraphStatus.display_name }}</strong>
            <span>
              {{ localGraphStatus.files }} Dateien · {{ localGraphStatus.symbols }} Symbole ·
              {{ localGraphStatus.edges }} Beziehungen
            </span>
            <span v-if="localGraphStatus.branch || localGraphStatus.commit_sha" class="repo-graph-revision">
              {{ localGraphStatus.branch || 'detached' }} · {{ localGraphStatus.commit_sha?.slice(0, 10) }}
            </span>
          </div>

          <label class="repo-graph-field">
            <span>Lokaler Git-Pfad</span>
            <input
              v-model="repositoryRootInput"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="E:\\projekte\\mein-projekt"
              :disabled="localGraphBusy"
              @keydown.enter.prevent="bindAndIndexRepository"
            />
          </label>

          <label class="repo-graph-field">
            <span>Code an externe Modelle</span>
            <select v-model="repositoryExternalPolicy" @change="saveRepositoryPolicy">
              <option value="deny">Nie übertragen</option>
              <option value="ask">Nur nach Freigabe</option>
              <option value="allow_selected">Ausgewählte Treffer erlauben</option>
            </select>
          </label>

          <div class="repo-graph-actions">
            <button
              type="button"
              :disabled="localGraphBusy || !repositoryRootInput.trim()"
              @click="bindAndIndexRepository"
            >
              {{ localGraphStatus.status === 'unbound' ? 'Binden & indexieren' : 'Anderen Pfad binden' }}
            </button>
            <button
              v-if="localGraphStatus.status !== 'unbound'"
              type="button"
              :disabled="localGraphBusy"
              @click="reindexRepository"
            >
              Aktualisieren
            </button>
            <button
              v-if="localGraphStatus.status !== 'unbound'"
              type="button"
              class="is-danger"
              :disabled="localGraphBusy"
              @click="removeRepositoryBinding"
            >
              Lokal löschen
            </button>
          </div>
          <p v-if="localGraphMessage || localGraphStatus.error" class="repo-graph-message">
            {{ localGraphMessage || localGraphStatus.error }}
          </p>
          <p class="repo-graph-privacy">
            Pfad, Index, Symbole und Graph bleiben im App-Datenverzeichnis dieses Geräts.
          </p>
        </div>

        <div class="info-block memory-candidates-block">
          <div class="info-head">
            <span class="tac-label">Memory-Kandidaten</span>
            <span class="info-stat">{{ memoryCandidates.length }} offen</span>
          </div>
          <p class="memory-candidates-help">
            Automatisch erkannte Inhalte bleiben lokal und werden erst nach deiner Bestätigung dauerhaft übernommen.
          </p>
          <div v-if="memoryCandidates.length" class="memory-candidate-list">
            <article v-for="candidate in memoryCandidates" :key="candidate.id" class="memory-candidate">
              <p>{{ candidate.content }}</p>
              <div class="memory-candidate-meta">
                <span>{{ candidate.source === 'assistant' ? 'Assistent' : 'Du' }}</span>
                <time>{{ formatChatTime(candidate.updatedAt) }}</time>
              </div>
              <div class="memory-candidate-actions">
                <button type="button" :disabled="!!memoryCandidateBusyId" @click="acceptMemoryCandidate(candidate)">
                  Übernehmen
                </button>
                <button
                  type="button"
                  class="is-danger"
                  :disabled="!!memoryCandidateBusyId"
                  @click="rejectMemoryCandidate(candidate)"
                >
                  Verwerfen
                </button>
              </div>
            </article>
          </div>
          <div v-else class="empty">Keine ungeprüften Erinnerungen.</div>
        </div>
      </div>

      <!-- Messages -->
      <div id="messages" class="messages">
        <div class="thread">
          <div v-if="!messages.length" class="chat-empty">
            <div class="chat-empty__orb"></div>
            <div class="chat-empty__kicker">{{ appearance.assistantName }}</div>
            <div class="chat-empty__title">Bereit für die nächste Aufgabe.</div>
            <div class="chat-empty__text">
              Schreibe direkt los oder nutze Push-to-Talk. Kontext und Memory werden automatisch schlank in den Prompt
              gelegt.
            </div>
          </div>

          <div
            v-for="m in messages"
            :key="m.id"
            class="msg"
            :class="m.role === 'user' ? 'msg--user' : 'msg--assistant'"
          >
            <div class="msg__meta">
              <span class="msg__role">{{ m.role === 'user' ? 'Du' : appearance.assistantName }}</span>
              <span class="msg__time">{{ formatChatTime(m.ts) }}</span>
              <span
                v-if="m.role === 'user' && (m as any)?.meta?.inputSource && (m as any).meta.inputSource !== 'keyboard'"
                class="msg__badge"
                :title="
                  (m as any).meta.inputSource === 'hands_free' ? 'Freihändig diktiert' : 'Per Push-to-Talk gesprochen'
                "
                >🎤 Gesprochen</span
              >
              <span
                v-if="m.role === 'assistant' && ((m as any)?.meta?.model || (m as any)?.meta?.provider)"
                class="msg__model"
                :title="'Use-Case: ' + ((m as any)?.meta?.useCase || '—')"
                >{{ (m as any).meta.provider
                }}<template v-if="(m as any).meta.model"> · {{ (m as any).meta.model }}</template></span
              >
              <button
                v-if="m.role === 'assistant' && m.content && m.content.trim()"
                type="button"
                class="speak-btn"
                title="Vorlesen"
                aria-label="Nachricht vorlesen"
                @click.stop="speakMessage(m)"
              >
                🔊
              </button>
              <button
                v-if="m.role === 'assistant' && (m as any)?.meta?.llmRequestId"
                type="button"
                class="feedback-btn"
                :class="{ 'is-on': (m as any)?.meta?.userFeedback === 1 }"
                title="Hilfreich"
                aria-label="Antwort als hilfreich bewerten"
                @click.stop="rateAssistantMessage(m, 1)"
              >
                ↑
              </button>
              <button
                v-if="m.role === 'assistant' && (m as any)?.meta?.llmRequestId"
                type="button"
                class="feedback-btn"
                :class="{ 'is-on is-negative': (m as any)?.meta?.userFeedback === -1 }"
                title="Nicht hilfreich"
                aria-label="Antwort als nicht hilfreich bewerten"
                @click.stop="rateAssistantMessage(m, -1)"
              >
                ↓
              </button>
            </div>

            <div class="bubble">
              <template v-if="m.role === 'assistant'">
                <div v-if="(m as any)?.meta?.isLoading && !(m.content && m.content.trim())" class="typing">
                  <i></i><i></i><i></i>
                </div>
                <p v-else class="answer__summary">
                  {{ m.content }}<span v-if="(m as any)?.meta?.isLoading" class="stream-caret"></span>
                </p>

                <div v-if="(m as any)?.meta?.question" class="answer__question">
                  {{ (m as any).meta.question }}
                </div>

                <div v-if="(m as any)?.meta?.bullets && (m as any).meta.bullets.length" class="chips">
                  <button
                    v-for="(b, i) in (m as any).meta.bullets.slice(0, 10)"
                    :key="i"
                    type="button"
                    class="chip"
                    :title="b"
                    @click="sendSuggestion(b)"
                  >
                    {{ b }}
                  </button>
                </div>
              </template>
              <template v-else>{{ m.content }}</template>
            </div>
          </div>
        </div>
      </div>

      <!-- Tool audit log -->
      <div v-if="showAudit" class="audit">
        <span class="tac-label audit__title">Tool-Protokoll</span>
        <div v-if="toolAudit.length" class="audit-list">
          <div v-for="a in toolAudit" :key="a.id" class="audit-row" :class="a.ok ? 'is-ok' : 'is-fail'">
            <span class="audit-row__status" />
            <span class="audit-row__tool"
              >{{ a.name }}<template v-if="a.error"> — {{ a.error }}</template
              ><template v-else-if="a.result"> — {{ a.result }}</template></span
            >
            <span class="audit-row__verdict">{{ a.ok ? 'OK' : 'FAIL' }}</span>
            <span class="audit-row__time">{{ formatChatTime(a.ts, true) }}</span>
          </div>
        </div>
        <div v-else class="empty">Noch keine Tool-Ausführungen.</div>
      </div>

      <!-- Pending tool-call approvals -->
      <div v-if="pendingApprovals.length" class="approvals">
        <span class="tac-label approvals__title">Bestätigung erforderlich ({{ pendingApprovals.length }})</span>
        <div v-for="call in pendingApprovals" :key="call.id" class="approval">
          <div class="approval__head">
            <span class="approval__cat">{{ call.category }}</span>
            <span class="approval__tool">{{ call.name }}</span>
          </div>
          <pre class="approval__args">{{ previewToolArguments(call.args) }}</pre>
          <div class="approval__actions">
            <button type="button" class="btn-reject" @click="rejectTool(call.id)">Ablehnen</button>
            <button type="button" class="btn-exec" @click="approveTool(call.id)">Ausführen</button>
          </div>
        </div>
      </div>

      <!-- Live listening bar -->
      <div v-if="listening" class="listen-bar">
        <span class="listen-bar__dot" />
        <span class="listen-bar__label">{{ listenLabel }}</span>
        <span class="listen-bar__text">{{ lastHeard || '…' }}</span>
      </div>

      <!-- Composer -->
      <div class="composer">
        <textarea
          ref="composerRef"
          v-model="input"
          class="composer__input"
          rows="1"
          placeholder="Nachricht an Luczor…"
          @input="autoGrow"
          @keydown.enter.exact.prevent="send"
        />
        <button
          type="button"
          class="mic-btn listen-btn"
          :class="{ 'is-listening': listening }"
          :title="listening ? 'Dauer-Zuhören stoppen' : 'Dauer-Zuhören / Wake-Word starten'"
          @click="toggleListening"
        >
          <svg
            v-if="!listening"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 12a9 9 0 0 1 18 0" />
            <path d="M7 12a5 5 0 0 1 10 0" />
            <circle cx="12" cy="12" r="1.6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
        <button
          type="button"
          class="mic-btn"
          :class="{ 'is-recording': isRecording }"
          :disabled="sending"
          :title="isRecording ? 'Aufnahme stoppen' : 'Push-to-talk'"
          @click="togglePushToTalk"
        >
          <svg
            v-if="!isRecording"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
        <button type="button" class="send-btn" :disabled="sending || !input.trim()" title="Senden" @click="send">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="6 11 12 5 18 11" />
          </svg>
        </button>
      </div>
    </main>

    <SpotlightSurface id="system-panel" class="system-panel" :class="{ 'is-open': showSystemPanel }">
      <div class="system-panel__head">
        <div>
          <span class="system-panel__eyebrow">Systemkern</span>
          <strong>Live-Status</strong>
        </div>
        <span class="system-panel__state"><i /> Bereit</span>
        <button
          type="button"
          class="system-panel__close"
          aria-label="Systembereich schließen"
          @click="showSystemPanel = false"
        >
          ×
        </button>
      </div>
      <JarvisHud embedded />
      <div class="system-panel__foot">
        <span>{{ activeProject?.name }}</span>
        <span>Privater Gerätekanal</span>
      </div>
    </SpotlightSurface>
  </div>
</template>

<style scoped src="./styles/app-shell.css"></style>
