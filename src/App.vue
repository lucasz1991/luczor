<!-- App.vue -->
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Settings from './components/Settings.vue'
import JarvisHud from './components/JarvisHud.vue'
import PlanPanel from './components/PlanPanel.vue'
import SidebarNav from './components/ai/SidebarNav.vue'
import ChatComposer from './components/ai/ChatComposer.vue'
import PromptBar from './components/ai/PromptBar.vue'
import ThinkingState from './components/ai/ThinkingState.vue'
import StreamingText from './components/ai/StreamingText.vue'
import ToolChips from './components/ai/ToolChips.vue'
import ApprovalCard from './components/ai/ApprovalCard.vue'
import ContextCards from './components/ai/ContextCards.vue'
import RecommendationCard from './components/ai/RecommendationCard.vue'
import SelectionActions from './components/ai/SelectionActions.vue'
import AiIcon from './components/ai/AiIcon.vue'
import {
  activityLabel,
  createChatActivity,
  finishChatActivity,
  presentToolCall,
  updateChatActivity,
  type ChatActivity,
} from '@/services/chatActivity'
import type { Message } from '@/state/types'
const UiLibrary = defineAsyncComponent(() => import('./components/ai/UiLibrary.vue'))
import SpotlightSurface from './components/vengeance/SpotlightSurface.vue'
import { type LuczorMode, type WireMessage } from './services/openrouter.service'
import { runAgent, buildSystemPreamble, shouldRequireToolCall } from '@/services/agent'
import { parseEnvelope } from '@/services/envelope'
import { resolveApproval, rejectAllApprovals } from '@/services/approvals'
import { Store } from '@tauri-apps/plugin-store'
import { VoiceEngine } from '@/services/voice/voiceEngine'
import { getVoiceConfig, handsFreeFromVoice, localStt } from '@/services/voice/localVoice'
import { streamSpeak, stopSpeak } from '@/services/voice/speak'
import { serverSpeechText } from '@/services/voice/messageSpeech'
import { createVoiceInputSession, idleVoiceInput } from '@/services/voice/voiceInputSession'
import { luczorMemory, getMemoryPrefs, type MemoryRecord } from '@/services/memory/luczorMemory'
import { buildPromptContextDetails, inferTaskType, type PromptContextDetails } from '@/services/contextController'
import { LuczorApi } from '@/services/api/luczorApi'
import { refreshStatus } from '@/services/status'
import { appearance } from '@/services/appearance'
import { recordDebugEvent } from '@/services/debug'
import { getSafeRecordValue } from '@/services/safeRecord'
import { buildRecentToolOutcomeContext, toolOutcomePreview } from '@/services/toolOutcomeContext'
import { getTool } from '@/services/tools/registry'
import { buildPlanContext } from '@/services/plan'
import { assemblePromptContext, type PromptFragment } from '@/services/prompt/promptContextAssembler'
import { buildProjectStartContext } from '@/services/prompt/projectStartContext'
import {
  bindProjectWorkspace,
  getProjectWorkspace,
  resolveWorkspacePrincipalId,
  selectProjectWorkspaceDirectory,
  unbindProjectWorkspace,
  type ProjectWorkspaceBinding,
} from '@/services/projectWorkspace'
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
import { FLASH_EXPERIMENT_SETTING_KEY } from '@/services/inference/hybridRouter'

import { setStatus } from '@/state/hud'
import { state, mutations } from '@/state/store'
import { scheduleSave } from '@/services/persistence'
import { playSfx, stopSfx } from '@/services/sfx'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { useChatComposer, type ComposerInputSource } from '@/composables/useChatComposer'
import {
  clampNumber,
  compactHistory,
  composeProviderSystemPrompt,
  formatChatTime,
  goalStatusLabel,
  normalizeConversationHistory,
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
const { input, autoGrow, setInput: writeComposerInput, consumeInputSource } = useChatComposer()
function setComposerInput(value: string, source: ComposerInputSource) {
  if (source === 'keyboard') voiceInputSession.manualInput()
  writeComposerInput(value, source)
}
const sending = ref(false)
const showLibrary = ref(false)
const sidebarCollapsed = ref(false)
const promptBar = ref<InstanceType<typeof PromptBar> | null>(null)
const chatActivities = ref<Record<string, ChatActivity>>({})
const activeTurn = ref<{ projectId: string; messageId: string } | null>(null)
const promptCommands = [
  { id: 'summarize', label: '/zusammenfassen', description: 'Den bisherigen Chat zusammenfassen', icon: 'spark' },
  { id: 'plan', label: '/plan', description: 'Einen konkreten Arbeitsplan erstellen', icon: 'check' },
  { id: 'context', label: '@projekt', description: 'Projektkontext ansehen', icon: 'folder' },
  { id: 'settings', label: '/modell', description: 'Modelleinstellungen öffnen', icon: 'settings' },
]
function handlePromptCommand(id: string) {
  if (id === 'context') {
    showContext.value = true
    input.value = ''
    return
  }
  if (id === 'settings') {
    openSettings()
    input.value = ''
    return
  }
  setComposerInput(
    id === 'plan'
      ? 'Erstelle einen konkreten Arbeitsplan für dieses Projekt.'
      : 'Fasse den bisherigen Chat und die nächsten Schritte zusammen.',
    'keyboard'
  )
}
function editSelection(instruction: string, selection: string) {
  setComposerInput(`${instruction}:\n\n${selection}`, 'keyboard')
  void nextTick(() => promptBar.value?.focus())
}
function messageTools(message: Message) {
  const calls = getSafeRecordValue(state.pending?.toolCallsByProject ?? {}, message.projectId) ?? []
  const nextUser = messages.value.find(item => item.role === 'user' && item.ts > message.ts)
  return calls
    .filter(call => call.createdAt >= message.ts && (!nextUser || call.createdAt < nextUser.ts))
    .map(presentToolCall)
}
function finishActiveTurn(status: 'done' | 'failed' | 'canceled') {
  const turn = activeTurn.value
  if (!turn) return
  const activity = chatActivities.value[turn.messageId]
  if (activity) finishChatActivity(activity, status)
  mutations.patchMessage(turn.projectId, turn.messageId, { meta: { isLoading: false } })
}
const mode = ref<LuczorMode>('observe')
const allowUnrestricted = ref(false)

function openSettings(tab: SettingsStartTab = 'server') {
  void voiceInputSession.stop()
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

onMounted(() => {
  window.addEventListener('luczor:voice-stop', stopAllVoice)
  window.addEventListener('luczor:voice-settings-changed', stopVoiceInputForSettings)
  return appRuntimeLifecycle.start()
})
onBeforeUnmount(() => {
  window.removeEventListener('luczor:voice-stop', stopAllVoice)
  window.removeEventListener('luczor:voice-settings-changed', stopVoiceInputForSettings)
  stopAllVoice()
  appRuntimeLifecycle.stop()
})

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
const speechPending = ref(false)
const speechError = ref('')
let speechGeneration = 0

function stopVoiceOutput() {
  speechGeneration += 1
  speechPending.value = false
  stopSpeak()
}

function speakMessage(m: any) {
  try {
    const text = serverSpeechText(m)
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
  const text = serverSpeechText(msg)

  if (!text) return
  if (text.startsWith('[Fehler]')) return

  const expectedGeneration = speechGeneration
  const s = await getAutoSpeechSettings()
  if (
    expectedGeneration !== speechGeneration ||
    pid !== activeProjectId.value ||
    serverSpeechText(mutations.getProjectMessages(pid).find(m => m.id === assistantId)) !== text
  )
    return
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
const isWelcomeMessage = (message: Message) =>
  message.role === 'assistant' &&
  ['Willkommen. Was ist das Ziel dieses Projekts?', 'Neuer Chat. Was ist das Ziel?'].includes(message.content)
const hasConversation = computed(() => messages.value.some(message => !isWelcomeMessage(message)))

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
  finishActiveTurn('canceled')
  stopVoiceOutput()
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
  void voiceInputSession.stop()
  void stopGenerating()
  activeProjectId.value = id
}

function newChat() {
  void voiceInputSession.stop()
  void stopGenerating()
  mutations.resetProjectChat(activeProjectId.value)
}

async function addProject() {
  void voiceInputSession.stop()
  void stopGenerating()
  const rootPath = await selectProjectWorkspaceDirectory('Projektordner als neues Luczor-Projekt öffnen')
  if (!rootPath) return

  const id = `p_${Math.random().toString(16).slice(2)}`
  try {
    const workspace = await bindProjectWorkspace(id, rootPath)
    mutations.addProject({ id, name: workspace.displayName || `Projekt ${projects.value.length + 1}` })
    activeProjectId.value = id
    activeWorkspace.value = workspace

    // Server mirroring is best-effort; the desktop project remains usable
    // offline and its absolute directory never enters the sync payload.
    void LuczorApi.createProject(id, workspace.displayName).catch(() => undefined)
    if (workspace.isGitRepository) await bindAndIndexWorkspace(workspace)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error))
  }
}

/* -------------------------------------------------
 * Local dictation: one microphone, live draft, wake/close controls and PTT
 * ------------------------------------------------- */
const voiceEngine = new VoiceEngine()
const voiceInputView = ref(idleVoiceInput())
const listening = computed(() => voiceInputView.value.mode === 'hands_free')
const isRecording = computed(() => voiceInputView.value.mode === 'push_to_talk' && !voiceInputView.value.finishing)
let voiceMuteDepth = 0
const voiceInputSession = createVoiceInputSession({
  engine: voiceEngine,
  readInput: () => input.value,
  writeInput: writeComposerInput,
  scope: () => activeProjectId.value,
  busy: () => sending.value,
  async config() {
    const [voice, tts] = await Promise.all([getVoiceConfig(), getTtsConfig()])
    return { voice, handsFree: handsFreeFromVoice(voice), bargeIn: tts.interruptMode === 'on_speech' }
  },
  transcribe: (wav, language) => localStt(wav, language),
  stopOutput: stopVoiceOutput,
  submit: () => send(true),
  changed: view => {
    voiceInputView.value = view
  },
})

function stopAllVoice() {
  void voiceInputSession.stop()
  stopVoiceOutput()
}

function stopVoiceInputForSettings() {
  void voiceInputSession.stop('Voice-Einstellungen gespeichert. Spracheingabe bei Bedarf neu starten.')
}

async function togglePushToTalk() {
  if (voiceInputView.value.mode === 'push_to_talk') await voiceInputSession.finish()
  else await voiceInputSession.start('push_to_talk')
}

async function toggleListening() {
  if (listening.value) await voiceInputSession.stop('Zuhören gestoppt. Der bisherige Text bleibt zum Prüfen stehen.')
  else await voiceInputSession.start('hands_free')
}

const voiceInputLabel = computed(() => {
  if (voiceInputView.value.starting) return 'Mikrofon wird geöffnet'
  if (voiceInputView.value.finishing) return 'Diktat wird abgeschlossen'
  switch (voiceInputView.value.status) {
    case 'armed':
      return 'Wartet auf Wake Word'
    case 'transcribing':
      return 'Lokale Erkennung läuft'
    case 'muted':
      return 'Spracheingabe pausiert'
    case 'dictating':
      return 'Diktat läuft'
    default:
      return 'Lokale Spracheingabe'
  }
})

watch(sending, busy => voiceInputSession.setMuted(busy || voiceMuteDepth > 0), { flush: 'sync' })

/** Keep continuous STT from hearing Luczor's server-generated TTS output. */
async function speakWithVoiceMuted(text: string, signal?: AbortSignal): Promise<'completed' | 'cancelled'> {
  if (signal?.aborted) return 'cancelled'
  stopVoiceOutput()
  const ownGeneration = speechGeneration
  speechError.value = ''
  speechPending.value = true
  voiceMuteDepth += 1
  voiceInputSession.setMuted(true)
  try {
    const tts = await getTtsConfig()
    if (ownGeneration !== speechGeneration || signal?.aborted) return 'cancelled'
    return await streamSpeak(text, { rate: tts.rate, volume: tts.volume, signal })
  } catch (error) {
    if (ownGeneration !== speechGeneration || signal?.aborted) return 'cancelled'
    speechError.value = error instanceof Error ? error.message : 'Die Server-Sprachausgabe ist fehlgeschlagen.'
    throw error
  } finally {
    if (ownGeneration === speechGeneration) speechPending.value = false
    voiceMuteDepth = Math.max(0, voiceMuteDepth - 1)
    voiceInputSession.setMuted(voiceMuteDepth > 0 || sending.value)
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

function approvalDataNotice(toolName: string): string {
  const tool = getTool(toolName)
  if (tool?.dataHandling !== 'ephemeral') return ''
  return 'Das lokale Ergebnis wird nur für diese laufende Modellrunde verwendet, danach redigiert und weder synchronisiert noch als Memory gespeichert.'
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
        'Luczor führt dann ALLE freigeschalteten Tools (Maus, Tastatur, URLs, lokale Dateien und Coding-Agenten) OHNE Rückfrage aus. ' +
        'Dabei können gelesene lokale Daten einmalig an das aktive Modell übergeben werden. Native Projekt- und Pfadgrenzen sowie der Not-Aus bleiben aktiv.\n\nWirklich aktivieren?'
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
const activeWorkspace = ref<ProjectWorkspaceBinding | null>(null)
const workspaceBusy = ref(false)
const workspaceMessage = ref('')
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

function workspacePathLabel(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '')
}

async function requireRepositoryPrincipalId(): Promise<string> {
  return resolveWorkspacePrincipalId()
}

async function refreshActiveWorkspace() {
  try {
    activeWorkspace.value = await getProjectWorkspace(activeProjectId.value)
  } catch (error) {
    activeWorkspace.value = null
    workspaceMessage.value = error instanceof Error ? error.message : String(error)
  }
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

async function bindAndIndexWorkspace(workspace: ProjectWorkspaceBinding) {
  if (!workspace.isGitRepository || localGraphBusy.value) return
  localGraphBusy.value = true
  localGraphMessage.value = 'Repository wird lokal gebunden …'
  try {
    const principalId = await requireRepositoryPrincipalId()
    await bindRepository(principalId, activeProjectId.value, workspace.gitRootPath ?? workspace.rootPath)
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

async function bindCurrentProjectWorkspace() {
  if (workspaceBusy.value || activeWorkspace.value) return
  workspaceBusy.value = true
  workspaceMessage.value = ''
  try {
    const rootPath = await selectProjectWorkspaceDirectory('Lokalen Ordner mit diesem Projekt verknüpfen')
    if (!rootPath) return
    const workspace = await bindProjectWorkspace(activeProjectId.value, rootPath)
    activeWorkspace.value = workspace
    workspaceMessage.value = 'Der Projektordner ist lokal zugeordnet.'
    if (workspace.isGitRepository) await bindAndIndexWorkspace(workspace)
  } catch (error) {
    workspaceMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    workspaceBusy.value = false
    await Promise.all([refreshActiveWorkspace(), refreshLocalGraphStatus()])
  }
}

async function reindexRepository() {
  if (localGraphBusy.value || !activeWorkspace.value?.isGitRepository) return
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
  if (localGraphBusy.value || workspaceBusy.value || !activeWorkspace.value) return
  const confirmed = window.confirm(
    'Lokale Projektzuordnung lösen? Die Dateien im gewählten Ordner werden nicht verändert oder gelöscht.'
  )
  if (!confirmed) return
  workspaceBusy.value = true
  localGraphBusy.value = true
  try {
    const principalId = await requireRepositoryPrincipalId()
    await unbindRepository(principalId, activeProjectId.value, true)
    await unbindProjectWorkspace(activeProjectId.value, principalId)
    activeWorkspace.value = null
    workspaceMessage.value =
      'Die lokale Zuordnung und der Graph-Index wurden entfernt. Projektdateien blieben unverändert.'
    localGraphMessage.value = ''
  } catch (error) {
    workspaceMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    workspaceBusy.value = false
    localGraphBusy.value = false
    await Promise.all([refreshActiveWorkspace(), refreshLocalGraphStatus()])
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
    void voiceInputSession.stop()
    stopVoiceOutput()
    speechError.value = ''
    workspaceMessage.value = ''
    localGraphMessage.value = ''
    repositoryExternalPolicy.value = await getRepositoryExternalPolicy()
    await Promise.all([refreshActiveWorkspace(), refreshLocalGraphStatus(), refreshMemoryCandidates()])
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
        serverSpeechAllowed: false,
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
    meta: { isLoading: !done, serverSpeechAllowed: false, question: '', bullets: [], summary: '' } as any,
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
async function send(automaticVoice = false) {
  const pid = activeProjectId.value
  const text = input.value.trim()
  if (!text || sending.value) return
  const taskType = inferTaskType(text)
  // Capture + reset how this turn was produced (spoken vs typed).
  const inputSource = consumeInputSource()
  if (!automaticVoice) void voiceInputSession.stop()

  void playSfx('submit')
  await stopGenerating()
  const turnSpeechGeneration = speechGeneration

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
  assistant.meta = { ...assistant.meta, serverSpeechAllowed: false }
  mutations.addMessage(assistant)
  chatActivities.value[assistant.id] = createChatActivity(assistant.ts)
  activeTurn.value = { projectId: pid, messageId: assistant.id }
  await forceScroll('auto')

  await nextTick()
  startAssistantLoading(pid, assistant.id)

  const abort = new AbortController()
  abortController.value = abort
  cancelCurrent = async () => abort.abort()

  try {
    // Build the wire history: system preamble + visible user/assistant text.
    const prj = activeProject.value
    const fullHistory: WireMessage[] = mutations
      .getProjectMessages(pid)
      .filter(m => m.id !== assistant.id)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .filter(message => message.meta?.dataHandling !== 'ephemeral')
      .filter(m => safeTrim(m.content).length > 0)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    const settingsStore = await Store.load('luczor.settings.json')
    const historyBudget = clampNumber(
      (await settingsStore.get<number>('client_history_token_budget')) ?? 2400,
      400,
      12000
    )
    const experimentalFlashNext = (await settingsStore.get<boolean>(FLASH_EXPERIMENT_SETTING_KEY)) === true
    const history = normalizeConversationHistory(
      compactHistory(normalizeConversationHistory(fullHistory), historyBudget)
    )

    const contextFragments: PromptFragment[] = []
    const recentToolContext = buildRecentToolOutcomeContext(mutations.getProjectMessages(pid, { includeHidden: true }))
    if (recentToolContext) {
      contextFragments.push({
        id: 'recent-tool-outcomes',
        source: 'tool',
        trust: 'untrusted_data',
        scope: 'session',
        egress: 'allowed',
        priority: 60,
        content: recentToolContext,
      })
    }

    // Keep the active plan in front of the model across turns.
    const planContext = buildPlanContext(pid)
    if (planContext) {
      contextFragments.push({
        id: 'active-plan',
        source: 'project',
        trust: 'untrusted_data',
        scope: 'project',
        egress: 'allowed',
        priority: 80,
        content: planContext,
      })
    }

    // Build one deterministic, bounded and redacted provider context. Absolute
    // workspace paths remain local; providers only ever receive @project.
    let promptContext: PromptContextDetails = { text: '', taskType }
    const memoryPrefs = await getMemoryPrefs().catch(() => ({ inject: true, injectCount: 5 }))
    try {
      if (prj) {
        const startContext = await buildProjectStartContext({
          project: prj,
          workspace: activeWorkspace.value,
          includeMemory: memoryPrefs.inject,
          memoryLimit: memoryPrefs.injectCount,
        })
        contextFragments.push(...startContext.fragments)
      }
    } catch (error) {
      console.warn('[prompt] start context skipped:', error)
    }

    // Add query-specific Memory/Repository retrieval. Repository snippets enter
    // only after a fresh per-turn approval when the local policy requires it.
    try {
      if (memoryPrefs.inject) {
        // Context Controller (server) ranks + budgets memory; local fallback.
        promptContext = await buildPromptContextDetails(pid, text, memoryPrefs.injectCount, taskType)
        if (promptContext.repositoryApprovalRequired) {
          const approved = window.confirm(
            'Für diese Codefrage wurden passende lokale Repository-Treffer gefunden.\n\n' +
              'Dürfen ausschließlich die ausgewählten, begrenzten und redigierten Ausschnitte für diese eine Modellanfrage verwendet werden?'
          )
          if (approved) {
            promptContext = await buildPromptContextDetails(pid, text, memoryPrefs.injectCount, taskType, true)
          }
        }
        if (promptContext.text) {
          contextFragments.push({
            id: 'query-context',
            source: 'repository',
            trust: 'untrusted_data',
            scope: 'project',
            egress: 'allowed',
            priority: 75,
            content: promptContext.text,
          })
        }
      }
    } catch (e) {
      console.warn('[memory] context injection skipped:', e)
    }

    const assembledContext = assemblePromptContext(contextFragments, {
      maxChars: 9_000,
      maxEstimatedTokens: 2_250,
      maxFragments: 20,
      maxFragmentChars: 1_800,
    })
    const baseMessages: WireMessage[] = [
      {
        role: 'system',
        content: composeProviderSystemPrompt(
          buildSystemPreamble(mode.value, prj?.name ?? pid, appearance.assistantName),
          assembledContext.providerText
        ),
      },
      ...history,
    ]

    let streamStarted = false

    if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    void playSfx('loading')
    const {
      finalText,
      requestId,
      model,
      provider,
      useCase,
      inferenceTarget,
      routeDecisionId,
      toolFailures,
      toolSuccesses,
      ephemeralDataUsed,
    } = await runAgent({
      projectId: pid,
      baseMessages,
      // This list is assembled exclusively through the existing provider-safe
      // prompt path. Local-only broker fragments are never reused here.
      externalBaseMessages: baseMessages,
      contextEgress: 'external_allowed',
      routingSettings: { experimentalFlashNext },
      requestExternalApproval: ({ packetHash, destination, messageCount, characterCount }) =>
        window.confirm(
          'Das lokale Modell ist für diese Anfrage nicht verfügbar.\n\n' +
            `Dürfen ${messageCount} begrenzte Nachrichten (${characterCount} Zeichen) einmalig an das externe Modell gesendet werden?\n` +
            `Ziel: ${destination}\n` +
            'Tools und Folgerunden sind in dieser Freigabe gesperrt.\n' +
            `Paket: ${packetHash.slice(0, 16)}…`
        ),
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

      onProgress: event => {
        const activity = chatActivities.value[assistant.id]
        if (activity) updateChatActivity(activity, event)
      },
      // Render only content released by the existing final-answer guard.
      onToken: raw => {
        if (!streamStarted) {
          streamStarted = true
          stopAssistantLoading()
          try {
            stopSfx('loading')
          } catch {}
        }
        if (!abort.signal.aborted) applyStreamedContent(pid, assistant.id, raw, false)
      },
    })

    try {
      stopSfx('loading')
    } catch {}
    stopAssistantLoading()

    if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    applyStreamedContent(pid, assistant.id, finalText, true)
    finishChatActivity(chatActivities.value[assistant.id]!, 'done')
    // Attach the server-reported routing metadata to the assistant message.
    {
      const current = mutations.getProjectMessages(pid).find(m => m.id === assistant.id)
      mutations.patchMessage(pid, assistant.id, {
        meta: {
          ...(current?.meta ?? {}),
          model,
          provider,
          useCase,
          inferenceTarget,
          routeDecisionId,
          serverSpeechAllowed: !ephemeralDataUsed,
          ...(ephemeralDataUsed ? { dataHandling: 'ephemeral' as const } : {}),
        },
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
    if (turnSpeechGeneration === speechGeneration) void autoSpeakAssistantIfEnabled(pid, assistant.id)
    if (!ephemeralDataUsed) void rememberExchange(pid, text, assistant.id)
  } catch (e: any) {
    try {
      stopSfx('loading')
    } catch {}
    stopAssistantLoading()

    const current = mutations.getProjectMessages(pid).find(m => m.id === assistant.id)
    const currentContent = safeTrim(current?.content)

    if (e?.name === 'AbortError') {
      finishChatActivity(chatActivities.value[assistant.id]!, 'canceled')
      setStatus('idle')
      mutations.patchMessage(pid, assistant.id, {
        content: currentContent || 'Abgebrochen.',
        meta: { ...(current?.meta ?? {}), isLoading: false } as any,
      })
      return
    }

    finishChatActivity(chatActivities.value[assistant.id]!, 'failed')
    setStatus('error')
    mutations.patchMessage(pid, assistant.id, {
      content: `[Fehler] ${e?.message ?? String(e)}`,
      meta: { ...(current?.meta ?? {}), isLoading: false } as any,
    })
  } finally {
    try {
      stopSfx('loading')
    } catch {}

    if (abortController.value === abort) {
      abortController.value = null
      sending.value = false
      cancelCurrent = null
    }
    if (activeTurn.value?.messageId === assistant.id) activeTurn.value = null
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
  <Settings
    :open="showSettings"
    :initial-tab="settingsStartTab"
    :test-speech="speakWithVoiceMuted"
    @update:open="showSettings = $event"
  />
  <UiLibrary v-if="showLibrary" @close="showLibrary = false" />

  <div class="app-shell ai-workspace" :class="{ 'ai-workspace--collapsed': sidebarCollapsed }">
    <SidebarNav
      v-model:collapsed="sidebarCollapsed"
      :title="appearance.assistantName"
      :items="projects.map(p => ({ id: p.id, label: p.name }))"
      :active-id="activeProjectId"
      @select="openProject"
      @new-chat="newChat"
      @add-project="addProject"
      @settings="openSettings()"
      @library="showLibrary = true"
      @system="showSystemPanel = !showSystemPanel"
    />

    <main class="main-col">
      <div class="header">
        <div class="header__identity">
          <span class="header__eyebrow">Aktiver Raum</span>
          <div class="header__title">{{ activeProject?.name }}</div>
          <div class="header__workspace">
            {{ activeWorkspace ? `@project · ${activeWorkspace.displayName}` : '@project · kein Ordner' }}
          </div>
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
            <span class="tac-label">Lokaler Projektordner</span>
            <span class="info-stat" :class="`is-${activeWorkspace?.status ?? 'unbound'}`">
              {{ activeWorkspace?.status === 'ready' ? 'bereit' : (activeWorkspace?.status ?? 'nicht zugeordnet') }}
            </span>
          </div>

          <div v-if="activeWorkspace" class="repo-graph-summary workspace-summary">
            <strong>{{ activeWorkspace.displayName }}</strong>
            <code :title="workspacePathLabel(activeWorkspace.rootPath)">{{
              workspacePathLabel(activeWorkspace.rootPath)
            }}</code>
            <span>
              Modellpfad <strong>@project</strong> ·
              {{ activeWorkspace.isGitRepository ? 'Git-Repository' : 'normaler Projektordner' }}
            </span>
          </div>
          <p v-else class="repo-graph-privacy">
            Ordne diesem Luczor-Projekt einen lokalen Ordner zu. Dateiwerkzeuge und Coding-Agenten bleiben anschließend
            strikt auf diesen Ordner begrenzt.
          </p>

          <div v-if="localGraphStatus.status === 'ready'" class="repo-graph-summary">
            <strong>Repository-Graph</strong>
            <span>
              {{ localGraphStatus.files }} Dateien · {{ localGraphStatus.symbols }} Symbole ·
              {{ localGraphStatus.edges }} Beziehungen
            </span>
            <span v-if="localGraphStatus.branch || localGraphStatus.commit_sha" class="repo-graph-revision">
              {{ localGraphStatus.branch || 'detached' }} · {{ localGraphStatus.commit_sha?.slice(0, 10) }}
            </span>
          </div>

          <label v-if="activeWorkspace?.isGitRepository" class="repo-graph-field">
            <span>Code an externe Modelle</span>
            <select v-model="repositoryExternalPolicy" @change="saveRepositoryPolicy">
              <option value="deny">Nie übertragen</option>
              <option value="ask">Nur nach Freigabe</option>
              <option value="allow_selected">Ausgewählte Treffer erlauben</option>
            </select>
          </label>

          <div class="repo-graph-actions">
            <button
              v-if="!activeWorkspace"
              type="button"
              :disabled="workspaceBusy"
              @click="bindCurrentProjectWorkspace"
            >
              Projektordner auswählen
            </button>
            <button
              v-if="activeWorkspace?.isGitRepository"
              type="button"
              :disabled="localGraphBusy"
              @click="reindexRepository"
            >
              Aktualisieren
            </button>
            <button
              v-if="activeWorkspace"
              type="button"
              class="is-danger"
              :disabled="localGraphBusy || workspaceBusy"
              @click="removeRepositoryBinding"
            >
              Zuordnung lösen
            </button>
          </div>
          <p v-if="workspaceMessage || localGraphMessage || localGraphStatus.error" class="repo-graph-message">
            {{ workspaceMessage || localGraphMessage || localGraphStatus.error }}
          </p>
          <p class="repo-graph-privacy">
            Der absolute Pfad, Index, Symbole und Graph bleiben auf diesem Gerät. Externe Modelle sehen nur
            <strong>@project</strong> und ausdrücklich freigegebene, redigierte Ausschnitte.
          </p>
        </div>

        <ContextCards
          :items="
            projectSummaries.map(item => ({
              id: item.id,
              title: 'Projektzusammenfassung',
              content: item.text,
              source: activeProject?.name || 'Projekt',
              kind: 'Memory',
            }))
          "
          title="Projektkontext"
        />

        <div class="info-block memory-candidates-block">
          <div class="info-head">
            <span class="tac-label">Memory-Kandidaten</span>
            <span class="info-stat">{{ memoryCandidates.length }} offen</span>
          </div>
          <p class="memory-candidates-help">
            Automatisch erkannte Inhalte bleiben lokal und werden erst nach deiner Bestätigung dauerhaft übernommen.
          </p>
          <div v-if="memoryCandidates.length" class="memory-candidate-list">
            <RecommendationCard
              v-for="candidate in memoryCandidates"
              :key="candidate.id"
              title="Als Erinnerung behalten?"
              :description="candidate.content"
              :evidence="`${candidate.source === 'assistant' ? 'Assistent' : 'Du'} · ${formatChatTime(candidate.updatedAt)}`"
              :busy="!!memoryCandidateBusyId"
              @accept="acceptMemoryCandidate(candidate)"
              @dismiss="rejectMemoryCandidate(candidate)"
            />
          </div>
          <div v-else class="empty">Keine ungeprüften Erinnerungen.</div>
        </div>
      </div>

      <!-- Shared chat surface: real messages, safe progress events and real tool states. -->
      <ChatComposer scroll-id="messages" :follow="hasConversation">
        <PlanPanel :project-id="activeProjectId" :collapsed="planCollapsed" @toggle="planCollapsed = !planCollapsed" />
        <div v-if="!hasConversation" class="ai-welcome">
          <span class="ai-welcome__mark"><AiIcon :size="32" /></span>
          <span class="ai-eyebrow">DEIN PERSÖNLICHER WORKSPACE</span>
          <h1>Woran arbeiten wir heute?</h1>
          <p>
            Von der ersten Idee bis zum letzten Schritt.<br />Mit deinem Projekt, deinem Kontext und
            {{ appearance.assistantName }}.
          </p>
          <div class="ai-starters">
            <button type="button" @click="handlePromptCommand('plan')">
              <AiIcon name="check" /><span>Eine Aufgabe planen<small>Schritt für Schritt zum Ergebnis</small></span
              ><AiIcon name="arrow" /></button
            ><button
              type="button"
              @click="editSelection('Analysiere', 'den aktuellen Projektzustand und die nächsten sinnvollen Schritte.')"
            >
              <AiIcon name="code" /><span>Ein Projekt verstehen<small>Zusammenhänge sichtbar machen</small></span
              ><AiIcon name="arrow" />
            </button>
          </div>
        </div>
        <template v-for="m in messages" :key="m.id">
          <article
            v-if="!isWelcomeMessage(m)"
            class="ai-message"
            :class="m.role === 'user' ? 'ai-message--user' : 'ai-message--assistant'"
          >
            <header>
              <span v-if="m.role === 'assistant'" class="ai-message__avatar"><AiIcon :size="15" /></span
              ><strong>{{ m.role === 'user' ? 'Du' : appearance.assistantName }}</strong
              ><time>{{ formatChatTime(m.ts) }}</time
              ><span v-if="m.meta.inputSource && m.meta.inputSource !== 'keyboard'" class="ai-badge">Gesprochen</span
              ><span v-if="m.meta.model" class="ai-message__model" :title="m.meta.provider">{{ m.meta.model }}</span>
            </header>
            <template v-if="m.role === 'assistant'">
              <ThinkingState
                v-if="chatActivities[m.id]"
                :active="chatActivities[m.id]!.status === 'running'"
                :label="activityLabel(chatActivities[m.id]!, pendingApprovals.length > 0 && !!m.meta.isLoading)"
                :steps="chatActivities[m.id]!.steps"
                :started-at="chatActivities[m.id]!.startedAt"
                :duration-ms="
                  chatActivities[m.id]!.finishedAt
                    ? chatActivities[m.id]!.finishedAt! - chatActivities[m.id]!.startedAt
                    : undefined
                "
                ><ToolChips :tools="messageTools(m)"
              /></ThinkingState>
              <ToolChips v-else :tools="messageTools(m)" />
              <SelectionActions :disabled="sending" @action="editSelection">
                <StreamingText
                  :content="m.content"
                  :streaming="!!m.meta.isLoading && !!m.content"
                  :animate="!!chatActivities[m.id]"
                  :question="m.meta.question"
                  :follow-ups="m.meta.bullets"
                  :disabled="sending"
                  :speech-disabled="!serverSpeechText(m)"
                  speech-disabled-reason="Lokale oder unvollständige Inhalte werden nicht an den Sprachserver gesendet."
                  @speak="speakMessage(m)"
                  @follow-up="sendSuggestion"
                >
                  <template #actions
                    ><button
                      v-if="m.meta.llmRequestId"
                      type="button"
                      class="ai-icon-button"
                      aria-label="Antwort als hilfreich bewerten"
                      @click="rateAssistantMessage(m, 1)"
                    >
                      ↑</button
                    ><button
                      v-if="m.meta.llmRequestId"
                      type="button"
                      class="ai-icon-button"
                      aria-label="Antwort als nicht hilfreich bewerten"
                      @click="rateAssistantMessage(m, -1)"
                    >
                      ↓
                    </button></template
                  >
                </StreamingText>
              </SelectionActions>
            </template>
            <p v-else class="ai-message__user-text">{{ m.content }}</p>
          </article>
        </template>
      </ChatComposer>

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

      <div v-if="pendingApprovals.length" class="ai-approvals">
        <ApprovalCard
          v-for="call in pendingApprovals"
          :key="call.id"
          :title="call.name"
          :description="`Luczor möchte dieses Tool ausführen${call.category ? ' · ' + call.category : ''}.`"
          :detail="previewToolArguments(call.args, 12000)"
          :notice="approvalDataNotice(call.name)"
          @approve="approveTool(call.id)"
          @reject="rejectTool(call.id)"
        />
      </div>

      <!-- Only gated dictation reaches the composer; ambient speech is never shown. -->
      <div
        v-if="voiceInputView.mode || voiceInputView.notice || voiceInputView.error"
        class="voice-input-status"
        :class="{ 'is-error': !!voiceInputView.error }"
        role="status"
        aria-live="polite"
      >
        <div>
          <strong v-if="voiceInputView.mode">{{ voiceInputLabel }}</strong>
          <span>{{ voiceInputView.error || voiceInputView.notice }}</span>
        </div>
        <button
          v-if="voiceInputView.mode"
          type="button"
          @click="voiceInputSession.stop('Aufnahme gestoppt. Der bisherige Text bleibt zum Prüfen stehen.')"
        >
          Aufnahme abbrechen
        </button>
        <button v-else type="button" @click="voiceInputSession.stop()">Schließen</button>
      </div>

      <div v-if="speechPending || speechError" class="speech-output" aria-live="polite">
        <span>{{ speechError || 'Server-Sprachausgabe aktiv' }}</span>
        <button v-if="speechPending" type="button" @click="stopVoiceOutput">Vorlesen stoppen</button>
        <button v-else type="button" @click="speechError = ''">Schließen</button>
      </div>

      <div class="ai-main-composer">
        <PromptBar
          ref="promptBar"
          v-model="input"
          :busy="sending"
          :recording="isRecording"
          :listening="listening"
          :voice-busy="voiceInputView.starting || voiceInputView.finishing"
          :model-label="'Automatische Modellwahl'"
          :context-label="activeWorkspace?.displayName || activeProject?.name"
          :commands="promptCommands"
          @input="setComposerInput(input, 'keyboard')"
          @send="send"
          @stop="stopGenerating"
          @record="togglePushToTalk"
          @listen="toggleListening"
          @model="openSettings()"
          @context="showContext = !showContext"
          @command="handlePromptCommand"
        />
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
<style scoped src="./styles/ai-workspace.css"></style>
