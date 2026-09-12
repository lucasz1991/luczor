<!-- App.vue -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import { loadPendingTaskCreates, replacePendingTaskCreates } from '@/services/agents/taskCreateRecoveryLedger'
import Settings from './components/Settings.vue'
import { modelUsageSettings, type ChatRouteMode } from '@/services/inference/modelUsageSettings'
import SystemStatusPanel from './components/SystemStatusPanel.vue'
import type { SystemStatusDisplayMode } from '@/features/system-status/model'
import AgentTeamResults from './components/ai/AgentTeamResults.vue'
import ChatCommentary from './components/ai/ChatCommentary.vue'
import { localAssistantProfilePrompt, refreshAssistantProfile } from '@/services/assistantProfile'
import PlanPanel from './components/PlanPanel.vue'
import ChatProjectOverlay from './components/ChatProjectOverlay.vue'
import SidebarNav from './components/ai/SidebarNav.vue'
import CloudProjectsPanel from './components/projects/CloudProjectsPanel.vue'
import { useCloudProjects } from '@/composables/useCloudProjects'
import { canAccessCloudProject } from '@/services/cloudProjectAccess'
import AgentHub from './components/agents/AgentHub.vue'
import PlanningWorkspace from './components/planning/PlanningWorkspace.vue'
import WorkflowWorkspace from './components/workflows/WorkflowWorkspace.vue'
import WorkflowChatCards from './components/workflows/WorkflowChatCards.vue'
import { workflowReferences, type WorkflowChatReference } from '@/services/workflows/presentation'
import { useWorkflowWatchers } from '@/composables/useWorkflowWatchers'
import { planningHub } from '@/services/planning/hub'
import {
  createPlanPrincipalBinding,
  planningCommandObjective,
  planningDiscussionMessage,
} from '@/services/planningEntry'
import { configureAgentHub } from '@/services/agents/hub'
import { teamPresetForRouteMode } from '@/services/agents/teamPolicy'
import {
  executionGate,
  invalidateExecution,
  updateExecutionControls,
  type ExecutionTicket,
} from '@/services/executionGate'
import ChatComposer from './components/ai/ChatComposer.vue'
import PromptBar from './components/ai/PromptBar.vue'
import ThinkingState from './components/ai/ThinkingState.vue'
import StreamingText from './components/ai/StreamingText.vue'
import ToolChips from './components/ai/ToolChips.vue'
import ApprovalCard from './components/ai/ApprovalCard.vue'
import PayloadApproval from './components/ai/PayloadApproval.vue'
import { requestPayloadApproval } from '@/services/payloadApproval'
import { requestConfirmation } from '@/services/confirmation'
import {
  buildTargetContextPackages,
  sanitizeInferenceMessagesForTarget,
  type ContextScopeKey,
} from '@/services/inference/contextBroker'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import ContextCards from './components/ai/ContextCards.vue'
import RecommendationCard from './components/ai/RecommendationCard.vue'
import SelectionActions from './components/ai/SelectionActions.vue'
import AiIcon from './components/ai/AiIcon.vue'
import MiniChatSurface from './components/mini/MiniChatSurface.vue'
import ToolCenterPanel from './components/tools/ToolCenterPanel.vue'
import BrowserPanel from './components/browser/BrowserPanel.vue'
import { browserPanel } from '@/services/browserPanel'
import { useMiniChatHost } from '@/composables/useMiniChatHost'
import AssistantResponseFooter from '@/components/ai/AssistantResponseFooter.vue'
import {
  isThinkingTier,
  type ThinkingTier,
  type ThinkingBudgetProgress,
  type ThinkingControlAction,
} from '@/services/inference/thinking'
import { captureThinking, thinkingSettings } from '@/services/inference/thinkingSettings'
import { controlLocalReasoning } from '@/services/inference/tauriLocalRuntime'
import { useBackgroundPreparation } from '@/composables/useBackgroundPreparation'
import { useIdleOptimization } from '@/composables/useIdleOptimization'
import { miniStatus } from '@/services/miniChat/presentation'
import {
  activityLabel,
  createChatActivity,
  finishChatActivity,
  updateChatActivity,
  type ChatActivity,
} from '@/services/chatActivity'
import { presentLocalToolResult } from '@/services/toolProgressPresentation'
import type { Message } from '@/state/types'
import { type LuczorMode, type WireMessage } from './services/openrouter.service'
import { runAgent, buildSystemPreamble, shouldRequireToolCall, type AgentRunEvaluation } from '@/services/agent'
import { presentEnvelopeStream } from '@/services/envelope'
import { resolveApproval, rejectAllApprovals, hasPendingApproval } from '@/services/approvals'
import { Store } from '@tauri-apps/plugin-store'
import { VoiceEngine } from '@/services/voice/voiceEngine'
import { ensureVoiceRuntime, getVoiceConfig, handsFreeFromVoice, localStt } from '@/services/voice/localVoice'
import { useVoiceInputOwnership } from '@/composables/useVoiceInputOwnership'
import { loadAudioTriggers } from '@/services/voice/audioTriggers'
import { streamSpeak, stopSpeak, type SpeakOptions } from '@/services/voice/speak'
import { serverSpeechText } from '@/services/voice/messageSpeech'
import { createCommentarySpeechQueue } from '@/services/voice/commentarySpeech'
import { createProgressiveCommentary } from '@/services/voice/progressiveCommentary'
import { completedCommentary } from '@/services/chatCommentary'
import { readAlongState } from '@/services/voice/readAlong'
import ReadAloudText from '@/components/ai/ReadAloudText.vue'
import { loadLocalSpeechConsent } from '@/services/voice/speechConsent'
import { createVoiceInputSession, idleVoiceInput } from '@/services/voice/voiceInputSession'
import { luczorMemory, getMemoryPrefs, type MemoryRecord } from '@/services/memory/luczorMemory'
import { MEMORY_PRIORITIES, memoryPriority } from '@/services/memory/memoryPriority'
import { buildLocalPromptContextDetails, inferTaskType, type PromptContextDetails } from '@/services/contextController'
import { LuczorApi } from '@/services/api/luczorApi'
import {
  cancelProjectSync,
  commitProjectSync,
  enqueueProjectSync,
  flushProjectSyncQueue,
  type StagedProjectSync,
} from '@/services/api/projectSyncQueue'
import { refreshStatus } from '@/services/status'
import { appearance, appearanceAccentColor } from '@/services/appearance'
import { miniProjectList, projectChatBinding } from '@/services/miniChat/projectChat'
import { recordDebugEvent } from '@/services/debug'
import { getSafeRecordValue } from '@/services/safeRecord'
import { buildRecentToolOutcomeContext, toolOutcomePreview } from '@/services/toolOutcomeContext'
import { getTool } from '@/services/tools/registry'
import { bindPlanPrincipal, buildPlanContext, getPlan } from '@/services/plan'
import { type PromptFragment } from '@/services/prompt/promptContextAssembler'
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

import { hud, setStatus, setKillSwitch } from '@/state/hud'
import { state, mutations } from '@/state/store'
import { saveAppStateStrict, scheduleSave } from '@/services/persistence'
import { playSfx, stopSfx } from '@/services/sfx'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { useChatComposer, type ComposerInputSource } from '@/composables/useChatComposer'
import {
  clampNumber,
  compactHistory,
  localConversationHistory,
  composeProviderSystemPrompt,
  formatChatTime,
  goalStatusLabel,
  messageRouteLabel,
  normalizeConversationHistory,
  previewToolArguments,
  safeTrim,
} from '@/services/chatPresentation'

/* -------------------------------------------------
 * Local UI state
 * ------------------------------------------------- */
type SettingsStartTab = 'server' | 'notifications' | 'execution' | 'chat'
const showSettings = ref(false)
const settingsStartTab = ref<SettingsStartTab>('server')
const showSystemPanel = ref(false)
const systemStatusDisplayMode = ref<SystemStatusDisplayMode>('tabs')
const showAgentHub = ref(false)
const showCloudProjects = ref(false)
const showPlanning = ref(false)
const showWorkflows = ref(false)
const showToolCenter = ref(false)
const composerShell = ref<HTMLElement | null>(null)
const composerClearance = ref(142)
const appShellStyle = computed<Record<string, string>>(() => ({
  '--system-composer-clearance': `${composerClearance.value}px`,
}))
let composerResizeObserver: ResizeObserver | undefined
onMounted(() => {
  composerResizeObserver = new ResizeObserver(entries => {
    const height =
      entries[0]?.borderBoxSize?.[0]?.blockSize ?? composerShell.value?.getBoundingClientRect().height ?? 134
    composerClearance.value = Math.ceil(height) + 8
  })
  if (composerShell.value) composerResizeObserver.observe(composerShell.value)
})
onBeforeUnmount(() => composerResizeObserver?.disconnect())
const selectedWorkflowId = ref<number>()
const selectedWorkflowRunId = ref<string>()
const planningObjective = ref('')
const planningRevision = ref(0)
const stopPlanningUpdates = planningHub.subscribe(() => planningRevision.value++)
onBeforeUnmount(stopPlanningUpdates)
const planPrincipalBinding = createPlanPrincipalBinding(resolveWorkspacePrincipalId, bindPlanPrincipal)
const refreshPlanPrincipal = () => {
  void planPrincipalBinding.refresh()
}
window.addEventListener('luczor:api-identity-changing', planPrincipalBinding.invalidate)
window.addEventListener('luczor:api-identity-changed', refreshPlanPrincipal)
onBeforeUnmount(() => {
  window.removeEventListener('luczor:api-identity-changing', planPrincipalBinding.invalidate)
  window.removeEventListener('luczor:api-identity-changed', refreshPlanPrincipal)
  planPrincipalBinding.dispose()
})
const { input, autoGrow, setInput: writeComposerInput, consumeInputSource } = useChatComposer()
function setComposerInput(value: string, source: ComposerInputSource) {
  if (source === 'keyboard') voiceInputSession.manualInput()
  writeComposerInput(value, source)
}
const sending = ref(false)
const sendAdmission = ref(false)
// The route mode is a conscious choice for this project in this session.
// Capture it at turn admission so later UI changes cannot change an in-flight route.
const chatRouteMode = ref<ChatRouteMode>(
  modelUsageSettings.value.externalEnabled ? modelUsageSettings.value.chatRouteMode : 'local'
)
const chatThinkingChoices = ref(new Map<string, ThinkingTier>())
const activeThinkingBudget = shallowRef<{
  projectId: string
  messageId: string
  progress: ThinkingBudgetProgress
} | null>(null)
watch(modelUsageSettings, value => {
  chatRouteMode.value = value.externalEnabled ? value.chatRouteMode : 'local'
})
const continuations = shallowRef<Record<string, AgentCheckpoint>>({})
const resetChatRouting = () => {
  chatThinkingChoices.value = new Map()
  activeThinkingBudget.value = null
  continuations.value = {}
  chatRouteMode.value = 'local'
}
const resetProjectRouting = () => {
  chatRouteMode.value = 'local'
}
window.addEventListener('luczor:api-identity-changing', resetChatRouting)
onBeforeUnmount(() => window.removeEventListener('luczor:api-identity-changing', resetChatRouting))
const sidebarCollapsed = ref(false)
const promptBar = ref<InstanceType<typeof PromptBar> | null>(null)
const chatActivities = computed<Record<string, ChatActivity>>(() =>
  Object.fromEntries(
    state.messages.filter(message => message.meta.activity).map(message => [message.id, message.meta.activity!])
  )
)
const activeTurn = ref<{ projectId: string; messageId: string } | null>(null)
const promptCommands = [
  { id: 'summarize', label: '/zusammenfassen', description: 'Den bisherigen Chat zusammenfassen', icon: 'spark' },
  { id: 'plan', label: '/plan', description: 'Ziele, Fragen und Schritte gemeinsam im Chat besprechen', icon: 'check' },
  { id: 'context', label: '@projekt', description: 'Projektkontext ansehen', icon: 'folder' },
  { id: 'settings', label: '/modell', description: 'Modelleinstellungen öffnen', icon: 'settings' },
]
function handlePromptCommand(id: string) {
  if (id === 'plan') {
    startPlanningChat()
    return
  }
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
  setComposerInput('Fasse den bisherigen Chat und die nächsten Schritte zusammen.', 'keyboard')
}
function startPlanningChat() {
  const objective = planningCommandObjective(input.value) ?? input.value.trim()
  setComposerInput(planningDiscussionMessage(objective), 'keyboard')
  void nextTick(() => promptBar.value?.focus())
}
function openPlanning(objective?: string) {
  planningObjective.value = objective ?? ''
  showAgentHub.value = false
  showPlanning.value = true
  void voiceInputSession.stop()
}
function planFromChecklist() {
  const checklist = getPlan(activeProjectId.value)
  const steps = checklist.steps.filter(step => step.status !== 'done' && step.status !== 'skipped')
  openPlanning(
    [
      activeProject.value?.goal || `Arbeitsplan für ${activeProject.value?.name ?? activeProjectId.value}`,
      ...steps.map(step => `- ${step.title}`),
      checklist.note,
    ]
      .filter(Boolean)
      .join('\n')
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
    .map(presentLocalToolResult)
}
function messageWorkflows(message: Message) {
  const calls = getSafeRecordValue(state.pending?.toolCallsByProject ?? {}, message.projectId) ?? []
  const nextUser = messages.value.find(item => item.role === 'user' && item.ts > message.ts)
  return workflowReferences(
    calls.filter(call => call.createdAt >= message.ts && (!nextUser || call.createdAt < nextUser.ts))
  )
}
function openWorkflows(reference?: WorkflowChatReference) {
  selectedWorkflowId.value = reference?.id
  selectedWorkflowRunId.value = reference?.runId
  showPlanning.value = false
  showAgentHub.value = false
  showWorkflows.value = true
}
function discussWorkflow(text: string) {
  setComposerInput(text, 'keyboard')
  void nextTick(() => promptBar.value?.focus())
}
function improveWorkflow(reference: WorkflowChatReference) {
  discussWorkflow(
    `Verbessere mit mir Workflow „${reference.name}“ (ID ${reference.id}). Lies zuerst die aktuelle Definition${reference.runId ? ` und den Lauf ${reference.runId}` : ' und relevante letzte Läufe'}. Begründe die Änderungen anhand meines Ziels und vorhandener Ergebnisse. Starte erst auf meinen Auftrag.`
  )
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
const stopAgentHub = configureAgentHub(() => mode.value)
onBeforeUnmount(stopAgentHub)

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
  void getLocalSpeechConsent().catch(() => undefined)
  refreshPlanPrincipal()
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
async function getTtsConfig(): Promise<{
  rate: number
  volume: number
  interruptMode: InterruptMode
  voiceId: string
}> {
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
    voiceId: String((await store.get<string>('voice_tts_voice_id')) || ''),
  }
}

const speechPending = ref(false)
const speechError = ref('')
const localSpeechAllowed = ref(false)
async function getLocalSpeechConsent(): Promise<boolean> {
  localSpeechAllowed.value = await loadLocalSpeechConsent()
  return localSpeechAllowed.value
}
const speechOutputLabel = computed(() => {
  const playback = readAlongState.value
  if (!playback || playback.phase === 'preparing') return 'Vorlesen wird vorbereitet …'
  if (playback.phase === 'waiting') return 'Wiedergabe wartet auf Audio …'
  return `Wird vorgelesen · ${Math.round((playback.position / Math.max(1, playback.text.length)) * 100)} %`
})
let speechGeneration = 0
const speechControllers = new Set<AbortController>()
let activeSpeechScope: { id: string; projectId: string; generation: number } | null = null
const commentarySpeech = createCommentarySpeechQueue({
  speak: (text, { signal, key, source, beforeChunk }) =>
    speakWithVoiceMuted(text, signal, true, key, undefined, { source, beforeChunk }),
  allowLocalContent: getLocalSpeechConsent,
  onBlocked: () => {
    speechError.value =
      'Lokaler Text wurde nicht vorgelesen. Einstellungen → Chat → Auch lokale Inhalte zum Vorlesen freigeben.'
  },
  canSpeak: async context => {
    const settings = await getAutoSpeechSettings()
    return settings.enabled && shouldSpeakAssistant(settings.mode) && (context.kind === 'message' || sending.value)
  },
  isCurrent: scope =>
    activeSpeechScope?.id === scope &&
    activeSpeechScope.projectId === activeProjectId.value &&
    activeSpeechScope.generation === speechGeneration,
  onError: error => {
    void recordDebugEvent('error', 'auto_tts_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  },
})

function stopVoiceOutput() {
  speechGeneration += 1
  for (const controller of speechControllers) controller.abort()
  activeSpeechScope = null
  commentarySpeech.cancel()
  speechPending.value = false
  stopSpeak()
}

async function speakMessage(m: any) {
  try {
    const generation = speechGeneration
    const allowLocalContent = await getLocalSpeechConsent()
    if (generation !== speechGeneration) return
    const text = serverSpeechText(m, { allowLocalContent })
    if (!text) return
    void speakWithVoiceMuted(text, undefined, false, `${m.id}:answer`).catch(error => {
      void recordDebugEvent('error', 'manual_tts_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    })
  } catch (e) {
    console.error('[speakMessage] error:', e)
  }
}

async function speakSelectedText(text: string) {
  const selected = text.replace(/\s+/gu, ' ').trim()
  if (!selected) return
  try {
    const generation = speechGeneration
    if (!(await getLocalSpeechConsent())) {
      speechError.value =
        'Die Textauswahl wurde nicht vorgelesen. Einstellungen → Chat → Auch lokale Inhalte zum Vorlesen freigeben.'
      return
    }
    if (generation !== speechGeneration) return
    await speakWithVoiceMuted(selected, undefined, false, 'context')
  } catch (error) {
    void recordDebugEvent('error', 'selection_tts_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
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

function evaluateAgentRun(run: AgentRunEvaluation) {
  void LuczorApi.evaluateLlmRun(run.requestId, {
    evaluator_id: 'luczor.client.outcome.v1',
    status: run.interrupted || run.continuation || run.toolFailures > 0 ? 'needs_review' : 'unverified',
    success_score:
      run.interrupted || run.toolFailures > 0 ? 0.25 : run.continuation ? 0.4 : run.toolSuccesses > 0 ? 0.75 : 0.5,
    payload: {
      agent_role: run.role,
      tool_failures: run.toolFailures,
      tool_successes: run.toolSuccesses,
      finish: run.interrupted
        ? 'inference_interrupted'
        : run.continuation
          ? 'continuation_required'
          : 'assistant_response',
      interruption_code: run.interrupted?.code,
    },
  }).catch(e => console.warn('[evaluation] deferred:', e))
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
const projects = computed(() => state.projects.filter(project => canAccessCloudProject(project)))

const activeProjectId = computed<string>({
  get() {
    state.global.ui ??= {}
    const selected = projects.value.find(project => project.id === state.global.ui?.lastProjectId)
    return selected?.id ?? projects.value[0]?.id ?? 'default'
  },
  set(id) {
    const project = state.projects.find(item => item.id === id)
    if (project && !canAccessCloudProject(project)) return
    mutations.setActiveProject(id)
  },
})

const activeProject = computed(() => projects.value.find(p => p.id === activeProjectId.value))
watch(activeProjectId, resetProjectRouting, { flush: 'sync' })
const activePlanningSession = computed(() => {
  void planningRevision.value
  return planningHub.get(activeProjectId.value)
})
const planningBusy = computed(() => {
  const status = activePlanningSession.value?.status
  return status === 'analyzing' || status === 'planning' || status === 'executing'
})
const planningStatusLabel = computed(() => {
  const labels = new Map([
    ['idle', 'Ziel vorbereiten'],
    ['analyzing', 'Projekt wird analysiert'],
    ['planning', 'Vollständiger Plan wird erstellt'],
    ['review', 'Plan bereit zur Prüfung'],
    ['executing', 'Geprüfter Plan wird ausgeführt'],
    ['completed', 'Ausführung beendet – Ergebnisse prüfen'],
    ['failed', 'Planung oder Ausführung fehlgeschlagen'],
    ['cancelled', 'Planung abgebrochen'],
    ['interrupted', 'Unterbrochener Plan – erneut prüfen'],
  ])
  return labels.get(activePlanningSession.value?.status ?? '') ?? 'Planungsmodus'
})
watch(() => ({ mode: mode.value, killSwitch: hud.killSwitch, scope: activeProjectId.value }), updateExecutionControls, {
  immediate: true,
  flush: 'sync',
})
window.addEventListener('luczor:api-identity-changing', invalidateExecution)
onBeforeUnmount(() => {
  window.removeEventListener('luczor:api-identity-changing', invalidateExecution)
  invalidateExecution()
})
const messages = computed(() => mutations.getProjectMessages(activeProjectId.value))
const thinkingTier = computed<ThinkingTier>({
  get: () => {
    const choice = chatThinkingChoices.value.get(activeProjectId.value)
    if (choice) return choice
    const saved = [...messages.value]
      .reverse()
      .find(message => message.role === 'user' && isThinkingTier(message.meta.thinkingTier))?.meta.thinkingTier
    return saved ?? thinkingSettings.value.defaultTier
  },
  set: value => {
    if (isThinkingTier(value)) chatThinkingChoices.value.set(activeProjectId.value, value)
  },
})
const visibleThinkingBudget = computed(() =>
  activeThinkingBudget.value?.projectId === activeProjectId.value ? activeThinkingBudget.value.progress : null
)
async function controlChatThinking(requestId: string, action: ThinkingControlAction, sequence: number) {
  if (
    visibleThinkingBudget.value?.requestId !== requestId ||
    !activeTurn.value ||
    activeTurn.value.messageId !== activeThinkingBudget.value?.messageId
  )
    throw new Error('Der aktive Auftrag wurde gewechselt.')
  return controlLocalReasoning(requestId, action, sequence)
}
const projectActivity = computed<Record<string, boolean>>(() => {
  const active = new Map<string, boolean>()
  for (const message of state.messages) {
    if (!message.projectId || message.visibility === 'hidden') continue
    if (message.meta?.isLoading || message.meta?.activity?.status === 'running') active.set(message.projectId, true)
  }
  for (const [projectId, calls] of Object.entries(state.pending?.toolCallsByProject ?? {})) {
    if (calls?.some(call => ['approved', 'executing'].includes(call.status))) active.set(projectId, true)
  }
  if (planningBusy.value) active.set(activeProjectId.value, true)
  return Object.fromEntries(active)
})
const projectItems = computed(() =>
  projects.value.map(project => ({ id: project.id, label: project.name, busy: !!projectActivity.value[project.id], cloud: !!project.cloud }))
)
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

function renameProject(id: string, name: string) {
  mutations.renameProject(id, name)
  scheduleSave(state)
}

const editingProjectTitle = ref(false)
const projectTitleDraft = ref('')
function beginProjectTitleEdit() {
  projectTitleDraft.value = activeProject.value?.name ?? ''
  editingProjectTitle.value = true
  void nextTick(() => document.getElementById('project-title-input')?.focus())
}
function finishProjectTitleEdit() {
  if (!editingProjectTitle.value) return
  editingProjectTitle.value = false
  if (projectTitleDraft.value.trim()) renameProject(activeProjectId.value, projectTitleDraft.value)
}
watch(activeProjectId, () => {
  editingProjectTitle.value = false
})

function newChat() {
  chatThinkingChoices.value.delete(activeProjectId.value)
  activeThinkingBudget.value = null
  void voiceInputSession.stop()
  void stopGenerating()
  mutations.resetProjectChat(activeProjectId.value)
}

async function addProject() {
  void voiceInputSession.stop()
  void stopGenerating()
  const rootPath = await selectProjectWorkspaceDirectory('Projektordner als neues Luczor-Projekt öffnen')
  if (!rootPath) return

  const id = globalThis.crypto?.randomUUID?.() ?? `p_${Math.random().toString(16).slice(2)}`
  const execution = executionGate.capture()
  let workspace: ProjectWorkspaceBinding | null = null
  let staged: StagedProjectSync | null = null
  let workspacePrincipalId = ''
  let bindingStarted = false
  let localCommitted = false
  try {
    executionGate.assert(execution)
    const apiConfig = await LuczorApi.getConfigSnapshot()
    executionGate.assert(execution)
    workspacePrincipalId = await resolveWorkspacePrincipalId()
    executionGate.assert(execution)
    const trimmedRoot = rootPath.replace(/[\\/]+$/u, '')
    const name = trimmedRoot.split(/[\\/]/u).pop()?.trim() || `Projekt ${projects.value.length + 1}`
    staged = await enqueueProjectSync(id, name, apiConfig, { workspacePrincipalId })
    bindingStarted = true
    workspace = await bindProjectWorkspace(id, rootPath, workspacePrincipalId)
    executionGate.assert(execution)
    await commitProjectSync(staged, async () => {
      executionGate.assert(execution)
      mutations.addProject({ id, name: workspace?.displayName || name }, false)
      try {
        await saveAppStateStrict(state)
        localCommitted = true
      } catch (error) {
        mutations.rollbackProjectCreation(id)
        throw error
      }
    })
    activeProjectId.value = id
    activeWorkspace.value = workspace

    // The queue is API-identity-bound and survives an offline/aborted POST.
    // Capture the new project generation so a later scope change stops only
    // the immediate attempt; the durable heartbeat retry remains available.
    const syncExecution = executionGate.capture()
    void flushProjectSyncQueue({ config: apiConfig, signal: syncExecution.signal }).catch(() => undefined)
    if (workspace.isGitRepository) await bindAndIndexWorkspace(workspace)
  } catch (error) {
    if (!localCommitted) {
      let workspaceRecovered = true
      if (bindingStarted && workspacePrincipalId) {
        workspaceRecovered = await unbindProjectWorkspace(id, workspacePrincipalId).then(
          () => true,
          () => false
        )
      }
      // If native cleanup failed, keep the durable marker so startup/status
      // recovery can retry the exact principal/project unbind later.
      if (staged && workspaceRecovered) await cancelProjectSync(staged).catch(() => undefined)
    }
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
  busy: () => conversationBusy.value,
  async config() {
    const [voice, tts, audioTriggers] = await Promise.all([getVoiceConfig(), getTtsConfig(), loadAudioTriggers()])
    return { voice, handsFree: handsFreeFromVoice(voice), bargeIn: tts.interruptMode === 'on_speech', audioTriggers }
  },
  transcribe: (wav, language) => localStt(wav, language),
  prepare: async () => {
    await claimVoiceInput()
    await ensureVoiceRuntime('stt')
  },
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
const claimVoiceInput = useVoiceInputOwnership(stopAllVoice)

async function startConfiguredVoice(mode: 'push_to_talk' | 'hands_free') {
  await voiceInputSession.start(mode)
}

function stopVoiceInputForSettings() {
  localSpeechAllowed.value = false
  void getLocalSpeechConsent().catch(() => undefined)
  stopVoiceOutput()
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
  if (voiceInputView.value.starting) return 'Spracheingabe wird vorbereitet'
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

/** Keep continuous STT from hearing Luczor's server-generated TTS output. */
async function speakWithVoiceMuted(
  text: string,
  signal?: AbortSignal,
  queued = false,
  key = '',
  voiceId?: string,
  progressive: Pick<SpeakOptions, 'source' | 'beforeChunk'> = {}
): Promise<'completed' | 'cancelled'> {
  if (signal?.aborted) return 'cancelled'
  if (!queued) stopVoiceOutput()
  const ownGeneration = speechGeneration
  const controller = new AbortController()
  speechControllers.add(controller)
  const callerAbort = () => controller.abort()
  signal?.addEventListener('abort', callerAbort, { once: true })
  let abortSettings!: () => void
  const cancelledSettings = new Promise<null>(resolve => {
    abortSettings = () => resolve(null)
    controller.signal.addEventListener('abort', abortSettings, { once: true })
  })
  speechError.value = ''
  speechPending.value = true
  voiceMuteDepth += 1
  voiceInputSession.setMuted(true)
  try {
    const tts = await Promise.race([getTtsConfig(), cancelledSettings])
    if (!tts || ownGeneration !== speechGeneration || controller.signal.aborted) return 'cancelled'
    return await streamSpeak(text, {
      rate: tts.rate,
      volume: tts.volume,
      signal: controller.signal,
      key,
      voiceId: voiceId ?? tts.voiceId,
      ...progressive,
    })
  } catch (error) {
    if (ownGeneration !== speechGeneration || signal?.aborted) return 'cancelled'
    speechError.value = error instanceof Error ? error.message : 'Die Server-Sprachausgabe ist fehlgeschlagen.'
    throw error
  } finally {
    controller.signal.removeEventListener('abort', abortSettings)
    signal?.removeEventListener('abort', callerAbort)
    speechControllers.delete(controller)
    if (ownGeneration === speechGeneration) speechPending.value = false
    voiceMuteDepth = Math.max(0, voiceMuteDepth - 1)
    voiceInputSession.setMuted(voiceMuteDepth > 0 || conversationBusy.value)
  }
}

function testSelectedVoice(text: string, signal?: AbortSignal, voiceId?: string) {
  return speakWithVoiceMuted(text, signal, false, '', voiceId)
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

const modeConfirmationPending = ref(false)
const modeConfirmationError = ref('')

async function toggleMode() {
  if (modeConfirmationPending.value) return
  modeConfirmationError.value = ''
  const previousMode = mode.value
  const next: LuczorMode =
    mode.value === 'observe' ? 'act' : mode.value === 'act' && allowUnrestricted.value ? 'unrestricted' : 'observe'

  if (next === 'unrestricted') {
    const ticket = executionGate.capture()
    modeConfirmationPending.value = true
    const confirmation = await requestConfirmation(
      'VOLLZUGRIFF aktivieren?\n\n' +
        'Luczor führt dann ALLE freigeschalteten Tools (Maus, Tastatur, URLs, lokale Dateien und Coding-Agenten) OHNE Rückfrage aus. ' +
        'Dabei können gelesene lokale Daten einmalig an das aktive Modell übergeben werden. Native Projekt- und Pfadgrenzen sowie der Not-Aus bleiben aktiv.\n\nWirklich aktivieren?'
    )
    modeConfirmationPending.value = false
    if (confirmation.error) modeConfirmationError.value = confirmation.error
    if (!confirmation.approved || !allowUnrestricted.value || mode.value !== previousMode) {
      return
    }
    try {
      executionGate.assert(ticket)
    } catch {
      modeConfirmationError.value = 'Die Steuerung wurde während der Bestätigung geändert. Bitte erneut auswählen.'
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
watch(
  () => [activeWorkspace.value?.rootPath, activeWorkspace.value?.updatedAt],
  () => {
    // Chat continuations may contain workspace-scoped mutation history. The
    // principal/project task ledger is separate and remains available.
    continuations.value = {}
    invalidateExecution()
  },
  { flush: 'sync' }
)
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
const memoryAnalysisBusy = ref(false)
const memoryAnalysisMessage = ref('')
watch(activeProjectId, () => {
  memoryAnalysisMessage.value = ''
})

async function analyzeProjectMemories() {
  if (memoryAnalysisBusy.value) return
  memoryAnalysisBusy.value = true
  memoryAnalysisMessage.value = ''
  const projectId = activeProjectId.value
  try {
    const principalId = await requireRepositoryPrincipalId()
    const result = await luczorMemory.analyze('project', { projectId })
    if (projectId !== activeProjectId.value || principalId !== (await requireRepositoryPrincipalId())) return
    const report = result.local
    memoryAnalysisMessage.value = [
      `${report.analyzed} Erinnerungen geprüft · ${report.duplicates.length} mögliche Duplikatgruppen · ${report.possible_conflicts.length} mögliche Widersprüche.`,
      ...(result.serverUnavailable ? ['Serveranalyse momentan nicht verfügbar; lokale Prüfung angezeigt.'] : []),
      ...report.recommendations,
    ].join(' ')
  } catch {
    if (projectId === activeProjectId.value)
      memoryAnalysisMessage.value = 'Die Erinnerungsanalyse ist gerade nicht verfügbar.'
  } finally {
    memoryAnalysisBusy.value = false
  }
}

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
  const projectId = activeProjectId.value
  const binding = activeWorkspace.value
  const ticket = executionGate.capture()
  workspaceBusy.value = true
  localGraphBusy.value = true
  try {
    const confirmation = await requestConfirmation(
      'Lokale Projektzuordnung lösen? Die Dateien im gewählten Ordner werden nicht verändert oder gelöscht.'
    )
    if (confirmation.error) throw new Error(confirmation.error)
    if (!confirmation.approved) return
    executionGate.assert(ticket)
    const principalId = await requireRepositoryPrincipalId()
    executionGate.assert(ticket)
    if (activeProjectId.value !== projectId || activeWorkspace.value !== binding) return
    await unbindRepository(principalId, projectId, true)
    executionGate.assert(ticket)
    await unbindProjectWorkspace(projectId, principalId)
    executionGate.assert(ticket)
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
const showChecklist = ref(false)
const activeChecklist = computed(() => getPlan(activeProjectId.value))
const checklistDone = computed(
  () => activeChecklist.value.steps.filter(step => step.status === 'done' || step.status === 'skipped').length
)

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
  const presented = presentEnvelopeStream(raw, done)
  mutations.patchMessage(pid, msgId, {
    raw,
    parsed: presented.envelope,
    content: presented.content || (done && !presented.question ? 'Fertig.' : ''),
    meta: {
      isLoading: !done,
      serverSpeechAllowed: false,
      question: presented.question,
      bullets: presented.bullets,
      summary: presented.envelope?.summary ?? '',
    },
  })
}

/** Click a suggestion chip -> send it as the next user message. */
function sendSuggestion(text: string) {
  const t = safeTrim(text)
  if (!t || conversationBusy.value) return
  input.value = t
  void send()
}

/** Persist the exchange to long-term memory (project scope). */
async function rememberExchange(
  pid: string,
  userText: string,
  assistantId: string,
  expectedPrincipalId: string,
  execution: ExecutionTicket
) {
  try {
    const prefs = await getMemoryPrefs()
    executionGate.assert(execution)
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
        expectedPrincipalId,
      })
    }
    if (summary && !summary.startsWith('[Fehler]') && summary !== 'Fertig.') {
      executionGate.assert(execution)
      await luczorMemory.remember({
        content: summary,
        scope: 'project',
        projectId: pid,
        source: 'assistant',
        writeIntent: 'automatic',
        expectedPrincipalId,
      })
    }
    executionGate.assert(execution)
    await refreshMemoryCandidates()
    void refreshStatus()
  } catch (e) {
    console.warn('[memory] remember skipped:', e)
  }
}

/* -------------------------------------------------
 * Send
 * ------------------------------------------------- */
async function resumeWork(messageId: string) {
  const checkpoint = Object.entries(continuations.value).find(([id]) => id === messageId)?.[1]
  if (!checkpoint || conversationBusy.value) return
  await send(false, { checkpoint, messageId })
}
async function send(
  automaticVoice = false,
  resume?: { checkpoint: AgentCheckpoint; messageId: string },
  miniInput?: { text: string; projectId: string }
) {
  const pid = activeProjectId.value
  const turnThinking = resume?.checkpoint.thinkingTier
    ? { thinkingTier: resume.checkpoint.thinkingTier, thinkingConfig: resume.checkpoint.thinkingConfig }
    : captureThinking(thinkingTier.value)
  // Every turn runs as an agent team, so the composer mode is the only route control.
  // A resumed checkpoint keeps its own local-only contract because its saved context was
  // gathered under one, and without the global external switch every mode collapses to
  // local, mirroring resolveInferenceRouteForTurn.
  const turnRouteMode: ChatRouteMode =
    modelUsageSettings.value.externalEnabled && !resume ? chatRouteMode.value : 'local'
  const externalFallbackAllowed = turnRouteMode !== 'local'
  const turnTeamPreset = teamPresetForRouteMode(turnRouteMode)
  const rawText = resume?.checkpoint.objective ?? (miniInput?.text ?? input.value).trim()
  if (!rawText || conversationBusy.value) return
  if (miniInput && miniInput.projectId !== pid) throw new Error('Der Projektchat wurde inzwischen gewechselt.')
  sendAdmission.value = true
  try {
    const planningCommand = planningCommandObjective(rawText)
    const text = planningCommand === null ? rawText : planningDiscussionMessage(planningCommand)
    // Bind the turn before the first await. A project/account switch while the
    // previous turn stops must not combine old input with a new project context.
    const abort = new AbortController()
    const turnExecution = executionGate.capture(abort.signal)
    const prj = activeProject.value
      ? (JSON.parse(JSON.stringify(activeProject.value)) as typeof activeProject.value)
      : null
    const workspace = activeWorkspace.value ? { ...activeWorkspace.value } : null
    const taskType = inferTaskType(text)
    // Capture + reset how this turn was produced (spoken vs typed).
    const inputSource = miniInput ? 'keyboard' : consumeInputSource()
    if (!automaticVoice) void voiceInputSession.stop()

    void playSfx('submit')
    await stopGenerating()
    if (turnExecution.signal.aborted) return
    const turnSpeechGeneration = speechGeneration

    // user message (tag spoken input for the "Gesprochen" badge)
    const userMsg = mutations.makeMsg('user', resume ? 'Weiterarbeiten' : text, pid)
    userMsg.meta = { ...(userMsg.meta ?? {}), inputSource, thinkingTier: turnThinking.thinkingTier }
    mutations.addMessage(userMsg)
    if (!resume && !miniInput) input.value = ''
    void nextTick(() => autoGrow())
    sending.value = true

    // assistant placeholder
    const assistant = mutations.makeMsg('assistant', '', pid)
    assistant.raw = ''
    assistant.parsed = null
    // A live answer has no final retention classification yet.
    assistant.meta = {
      ...assistant.meta,
      serverSpeechAllowed: false,
      dataHandling: 'ephemeral',
      activity: createChatActivity(assistant.ts),
      commentary: [],
    }
    mutations.addMessage(assistant)
    const speechScope = `${pid}:${assistant.id}:${turnSpeechGeneration}`
    activeSpeechScope = { id: speechScope, projectId: pid, generation: turnSpeechGeneration }
    const progressiveSpeech = createProgressiveCommentary({
      scope: speechScope,
      answerKey: `${assistant.id}:answer`,
      queue: commentarySpeech,
      readMessage: () => mutations.getProjectMessages(pid).find(message => message.id === assistant.id),
    })
    void commentarySpeech.enqueueStatus({ scope: speechScope, key: 'context', text: 'Kontext vorbereiten' })
    activeTurn.value = { projectId: pid, messageId: assistant.id }
    abortController.value = abort
    cancelCurrent = async () => abort.abort()
    let checkpointMemoryPrincipal = ''
    let latestPublicCheckpoint = ''

    const retainMemoryCheckpoint = (content: string, final = false) => {
      if (!checkpointMemoryPrincipal || !content.trim()) return
      void luczorMemory
        .captureCheckpoint({
          content,
          scope: 'project',
          projectId: pid,
          sessionId: assistant.id,
          expectedPrincipalId: checkpointMemoryPrincipal,
          final,
        })
        .catch(() => {
          // Memory is best-effort; never replace a chat result with a checkpoint error.
        })
    }

    try {
      await forceScroll('auto')
      await nextTick()
      executionGate.assert(turnExecution)
      startAssistantLoading(pid, assistant.id)
      // Build the wire history: system preamble + visible user/assistant text.
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
      // The laptop profile has an 8k context window. Reduce history and
      // retrieved project context before native tokenization, rather than
      // relying on the runtime to recover after a complete prompt is built.
      const compactLocalProfile = modelUsageSettings.value.localModelId === 'local-tier-light'
      const localHistory = normalizeConversationHistory(
        compactLocalProfile
          ? compactHistory(normalizeConversationHistory(fullHistory), Math.min(historyBudget, 900))
          : fullHistory
      )
      const experimentalFlashNext = (await settingsStore.get<boolean>(FLASH_EXPERIMENT_SETTING_KEY)) === true
      const history = normalizeConversationHistory(
        compactHistory(normalizeConversationHistory(fullHistory), historyBudget)
      )

      const contextFragments: PromptFragment[] = []
      const recentToolContext = buildRecentToolOutcomeContext(
        mutations.getProjectMessages(pid, { includeHidden: true })
      )
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
      const detailedPlan = planningHub.get(pid)
      const planContext = detailedPlan?.plan
        ? JSON.stringify({ revision: detailedPlan.revision, status: detailedPlan.status, plan: detailedPlan.plan })
        : buildPlanContext(pid)
      if (planContext) {
        contextFragments.push({
          id: 'active-plan',
          source: 'project',
          trust: 'untrusted_data',
          scope: 'project',
          egress: detailedPlan?.plan ? 'local_only' : 'allowed',
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
          const startContext = await backgroundPreparation.projectContext(prj, workspace, memoryPrefs, turnExecution)
          contextFragments.push(...startContext.sourceFragments)
        }
      } catch (error) {
        console.warn('[prompt] start context skipped:', error)
      }

      // Add query-specific Memory/Repository retrieval. Repository snippets enter
      // only after a fresh per-turn approval when the local policy requires it.
      try {
        if (memoryPrefs.inject) {
          promptContext = await buildLocalPromptContextDetails(pid, text, memoryPrefs.injectCount, taskType)
          if (promptContext.text) {
            contextFragments.push({
              id: 'query-context',
              source: 'repository',
              trust: 'untrusted_data',
              scope: 'project',
              egress: 'local_only',
              priority: 75,
              content: promptContext.text,
            })
          }
        }
      } catch (e) {
        console.warn('[memory] context injection skipped:', e)
      }

      const accountScope = await getVerifiedAccountSnapshot()
      executionGate.assert(turnExecution)
      const scopeKey: ContextScopeKey = {
        principalId: accountScope?.principalId ?? (await resolveWorkspacePrincipalId()),
        serverInstance: accountScope?.serverInstance ?? 'device-local',
        projectId: pid,
        workspaceBindingId: JSON.stringify([workspace?.rootPath ?? '', workspace?.updatedAt ?? '']),
        sessionId: assistant.id,
        taskType,
      }
      const principalScopeId = JSON.stringify([scopeKey.serverInstance, scopeKey.principalId])
      checkpointMemoryPrincipal = scopeKey.principalId
      let taskCreateRecoveryReady = true
      const pendingTaskCreateVerifications = await loadPendingTaskCreates(principalScopeId, pid).catch(error => {
        taskCreateRecoveryReady = false
        console.warn('[task-create] recovery ledger unavailable:', error)
        return []
      })
      executionGate.assert(turnExecution)
      if (workspace?.rootPath)
        contextFragments.push({
          id: 'local-workspace-path',
          source: 'project',
          trust: 'policy',
          scope: 'workspace',
          egress: 'local_only',
          priority: 100,
          content: `Lokaler Projektordner: ${workspace.rootPath}`,
        })
      const packages = await buildTargetContextPackages({
        scopeKey,
        fragments: contextFragments.map(fragment => ({
          ...fragment,
          scope: scopeKey,
          lifecycle: 'active',
          sensitivity: 'normal',
          audiences: ['local_model', 'external_provider'],
          contentHash: '',
        })),
        budget: compactLocalProfile
          ? { maxChars: 2_400, maxFragments: 6, maxFragmentChars: 500 }
          : { maxChars: 9_000, maxFragments: 20, maxFragmentChars: 1_800 },
      })
      const assistantProfile = await refreshAssistantProfile()
      executionGate.assert(turnExecution)
      const localProfilePrompt = localAssistantProfilePrompt(assistantProfile)
      const baseMessages: WireMessage[] = [
        {
          role: 'system',
          content: composeProviderSystemPrompt(
            buildSystemPreamble(mode.value, prj?.name ?? pid, appearance.assistantName),
            [localProfilePrompt, packages.local.text].filter(Boolean).join('\n\n')
          ),
        },
        ...sanitizeInferenceMessagesForTarget(localConversationHistory(localHistory), 'local_llama_cpp'),
      ]
      const externalBaseMessages: WireMessage[] = [
        {
          role: 'system',
          content: composeProviderSystemPrompt(
            buildSystemPreamble(mode.value, prj?.name ?? pid, appearance.assistantName),
            packages.external.text
          ),
        },
        ...sanitizeInferenceMessagesForTarget(history, 'laravel_proxy'),
      ]

      let streamStarted = false
      executionGate.assert(turnExecution)
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
        tokenUsage,
        specialistOutcomes,
        agentRunEvaluations,
        continuation,
        interrupted,
      } = await runAgent({
        ...turnThinking,
        onBudget: progress => {
          if (turnExecution.signal.aborted || activeTurn.value?.messageId !== assistant.id) return
          activeThinkingBudget.value = progress ? { projectId: pid, messageId: assistant.id, progress } : null
        },
        agentMode: true,
        agentTeamPreset: turnTeamPreset,
        requestAgentTeamApproval: approval =>
          requestPayloadApproval(
            {
              title: `Agententeam freigeben: ${approval.preset}`,
              destination: approval.destination,
              hash: approval.packetHash,
              content: JSON.stringify(
                {
                  hinweis:
                    'Externe Agenten erhalten ausschließlich die folgenden Pakete. Die Modellwahl erfolgt pro Rolle auf dem Server. Kosten und Datennutzung stehen bei den Kandidaten.',
                  ...approval,
                },
                null,
                2
              ),
            },
            turnExecution.signal
          ),
        continuation: resume?.checkpoint,
        pendingTaskCreateVerifications,
        principalScopeId,
        workspaceBindingId: scopeKey.workspaceBindingId,
        taskCreateRecoveryReady,
        projectId: pid,
        baseMessages,
        // This list is assembled exclusively through the existing provider-safe
        // prompt path. Local-only broker fragments are never reused here.
        externalBaseMessages,
        contextEgress: externalFallbackAllowed ? 'external_allowed' : 'local_only',
        routingSettings: {
          preference:
            turnRouteMode === 'external' ? 'force_external' : turnRouteMode === 'auto' ? 'ask_external' : 'local_only',
          experimentalFlashNext,
        },
        requestExternalApproval: ({ packetHash, destination, messages: outgoing }) =>
          requestPayloadApproval(
            {
              title: 'Externes Modell: Nachrichten einmal freigeben',
              destination,
              hash: packetHash,
              content: JSON.stringify(outgoing, null, 2),
            },
            turnExecution.signal
          ),
        mode: mode.value,
        getMode: () => mode.value,
        toolChoice: shouldRequireToolCall(text) ? 'required' : 'auto',
        taskType: promptContext.taskType,
        // The composer is a chat contract. The task type stays a context-retrieval
        // hint; it must not decide the signed capability, which used to change with
        // single keywords like "test", "plan" or "prüfen" in the user's sentence.
        requiredCapability: 'chat',
        contextId: promptContext.contextId,
        repoId: promptContext.repoId,
        branch: promptContext.branch,
        commitSha: promptContext.commitSha,
        inputSource,
        signal: turnExecution.signal,
        onCheckpoint: async checkpoint => {
          if (turnExecution.signal.aborted || checkpoint.principalScopeId !== principalScopeId) return
          const targetMessageId = resume?.messageId ?? assistant.id
          continuations.value = { ...continuations.value, [targetMessageId]: checkpoint }
          await replacePendingTaskCreates(principalScopeId, pid, checkpoint.pendingTaskCreateVerifications ?? [])
        },

        onProgress: event => {
          if (turnExecution.signal.aborted) return
          const activity = chatActivities.value[assistant.id]
          if (activity) updateChatActivity(activity, event)
          // Fixed application phase labels are public; do not read numeric token
          // ticks or raw tool payloads aloud on every update.
          if (activity && event.phase === 'tools')
            void commentarySpeech.enqueueStatus({
              scope: speechScope,
              key: `phase:${event.phase}`,
              text: activityLabel(activity, false),
            })
        },
        onRoundComplete: round => {
          if (turnExecution.signal.aborted || round.kind !== 'commentary') return
          const entry = completedCommentary(round)
          if (!entry) return
          if (entry.serverSpeechAllowed) {
            latestPublicCheckpoint = entry.content
            retainMemoryCheckpoint(entry.content)
          }
          const current = mutations.getProjectMessages(pid).find(message => message.id === assistant.id)
          const previous = current?.meta.commentary ?? []
          if (previous.some(item => item.id === entry.id)) return
          mutations.patchMessage(pid, assistant.id, {
            // Clear only this live slot, after retaining its completed text.
            content: '',
            raw: '',
            parsed: null,
            meta: { commentary: [...previous, entry], question: '', summary: '', bullets: [] },
          })
          progressiveSpeech.completeCommentary(entry)
        },
        onUsage: usage => {
          if (turnExecution.signal.aborted) return
          mutations.patchMessage(pid, assistant.id, { meta: { tokenUsage: usage } })
        },
        // Render public answer content as soon as each transport chunk arrives.
        onToken: raw => {
          if (turnExecution.signal.aborted) return
          if (!streamStarted) {
            streamStarted = true
            stopAssistantLoading()
            try {
              stopSfx('loading')
            } catch {}
          }
          applyStreamedContent(pid, assistant.id, raw, false)
          if (turnSpeechGeneration === speechGeneration) progressiveSpeech.update()
        },
      })

      try {
        stopSfx('loading')
      } catch {}
      stopAssistantLoading()

      if (turnExecution.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      executionGate.assert(turnExecution)
      {
        const next = { ...continuations.value }
        if (resume) delete next[resume.messageId]
        if (continuation) next[assistant.id] = continuation
        else delete next[assistant.id]
        continuations.value = next
      }
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
            tokenUsage,
            specialistOutcomes: ephemeralDataUsed ? undefined : specialistOutcomes,
            serverSpeechAllowed: !ephemeralDataUsed,
            dataHandling: ephemeralDataUsed ? 'ephemeral' : 'syncable',
          },
        })
      }
      if (requestId) {
        const current = mutations.getProjectMessages(pid).find(m => m.id === assistant.id)
        mutations.patchMessage(pid, assistant.id, {
          meta: { ...(current?.meta ?? {}), llmRequestId: requestId, userFeedback: null } as any,
        })
      }
      const evaluations: AgentRunEvaluation[] = agentRunEvaluations?.length
        ? agentRunEvaluations
        : requestId
          ? [
              {
                requestId,
                role: 'worker',
                toolFailures,
                toolSuccesses,
                continuation: Boolean(continuation),
                interrupted,
              },
            ]
          : []
      for (const evaluation of evaluations) evaluateAgentRun(evaluation)

      setStatus('idle')
      if (turnSpeechGeneration === speechGeneration) progressiveSpeech.completeAnswer()
      if (!ephemeralDataUsed && !continuation && !interrupted)
        void rememberExchange(pid, text, assistant.id, scopeKey.principalId, turnExecution)
    } catch (e: any) {
      progressiveSpeech.cancel()
      try {
        stopSfx('loading')
      } catch {}
      stopAssistantLoading()

      const current = mutations.getProjectMessages(pid).find(m => m.id === assistant.id)
      const currentContent = safeTrim(current?.content)

      if (e?.name === 'AbortError' || turnExecution.signal.aborted) {
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
        content: [currentContent, `[Fehler] ${e?.message ?? String(e)}`].filter(Boolean).join('\n\n'),
        meta: { ...(current?.meta ?? {}), isLoading: false } as any,
      })
    } finally {
      retainMemoryCheckpoint(latestPublicCheckpoint, true)
      try {
        stopSfx('loading')
      } catch {}

      if (abortController.value === abort) {
        abortController.value = null
        sending.value = false
        cancelCurrent = null
      }
      if (activeTurn.value?.messageId === assistant.id) activeTurn.value = null
      if (activeThinkingBudget.value?.messageId === assistant.id) activeThinkingBudget.value = null
    }
  } finally {
    sendAdmission.value = false
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
const miniChat = useMiniChatHost({
  thinkingTier: () => thinkingTier.value,
  thinkingBudget: () => visibleThinkingBudget.value,
  setThinkingTier: tier => {
    thinkingTier.value = tier
  },
  controlThinking: controlChatThinking,
  projects: () => miniProjectList(projects.value, state.messages, projectActivity.value),
  chat: () =>
    projectChatBinding(
      activeProject.value,
      state.messages,
      getSafeRecordValue(state.pending?.toolCallsByProject ?? {}, activeProjectId.value) ?? [],
      sending.value || sendAdmission.value
    ),
  sendChat: (text, projectId) => send(false, undefined, { text, projectId }),
  stopChat: stopGenerating,
  selectProject: async id => {
    if (conversationBusy.value) throw new Error('Der aktuelle Auftrag läuft noch.')
    if (!projects.value.some(project => project.id === id && !project.archivedAt))
      throw new Error('Projekt nicht verfügbar.')
    openProject(id)
    await refreshActiveWorkspace()
  },
  openPanel: async panel => {
    if (panel === 'agents') showAgentHub.value = true
    else if (panel === 'planning') openPlanning()
    else if (panel === 'workflows') openWorkflows()
    else if (panel === 'desktop') openSettings('execution')
    else await addProject()
  },
  openWorkflow: async reference => {
    if (reference.projectId !== activeProjectId.value) throw new Error('Workflow-Projekt wurde gewechselt.')
    openWorkflows(reference)
  },
  runWorkflow: async (reference, action) => {
    if (reference.projectId !== activeProjectId.value || sending.value || hud.killSwitch)
      throw new Error('Workflow-Aktion ist derzeit gesperrt.')
    const ticket = executionGate.capture()
    const { workflowTools } = await import('@/services/tools/workflows')
    executionGate.assert(ticket, true)
    const tool = workflowTools.find(
      item => item.name === (action === 'stop' ? 'workflow_run_cancel' : 'workflow_run_start')
    )!
    const result = (await tool.execute(
      {
        workflow_id: reference.id,
        ...(action === 'stop' ? { run_id: reference.runId } : { sandbox: action === 'test' }),
      },
      { projectId: reference.projectId, execution: ticket }
    )) as { ok: boolean; error?: string; workflow_ref?: WorkflowChatReference }
    executionGate.assert(ticket, true)
    if (!result.ok) throw new Error(result.error ?? 'Workflow-Aktion fehlgeschlagen.')
    if (result.workflow_ref) openWorkflows(result.workflow_ref)
  },
  togglePushToTalk,
  toggleWakeWord: toggleListening,
  appearance: () => ({ accent: appearanceAccentColor(), assistantName: appearance.assistantName }),
  context: () => ({
    project: activeProject.value ? { id: activeProject.value.id, name: activeProject.value.name } : null,
    mode: mode.value,
    mainBusy: sending.value || sendAdmission.value || showPlanning.value || planningBusy.value,
    workspaceBindingId: JSON.stringify([activeWorkspace.value?.rootPath ?? '', activeWorkspace.value?.updatedAt ?? '']),
  }),
  setMode: next => {
    mode.value = next
    void persistActiveMode(next)
  },
  telemetry: () => ({
    status: hud.status,
    micLevel: hud.micLevel,
    killSwitch: hud.killSwitch,
    reduceMotion: appearance.reduceMotion,
  }),
  mainDecision: () => {
    const call = pendingApprovals.value.find(item => hasPendingApproval(item.id))
    return call
      ? {
          id: call.id,
          kind: 'tool',
          title: `${call.name} ausführen?`,
          description: `Projektchat · ${activeProject.value?.name ?? ''}`,
          detail: previewToolArguments(call.args, 6000),
        }
      : null
  },
  decideMain: (id, approved) => {
    if (!pendingApprovals.value.some(call => call.id === id) || !hasPendingApproval(id)) return
    if (approved) approveTool(id)
    else rejectTool(id)
  },
  killSwitch: enabled => {
    setKillSwitch(enabled)
    if (enabled) void stopGenerating()
  },
  // Every turn is a team turn now; the mini chat only mirrors that, it cannot switch it.
  agentMode: () => true,
  voice: () => ({
    wakeWord: listening.value,
    recording: isRecording.value,
    busy: voiceInputView.value.starting || voiceInputView.value.finishing,
  }),
})
// Voice and both composers must share admission and mute state, including hotkeys.
const conversationBusy = computed(
  () => sending.value || sendAdmission.value || miniChat.state.busy || showPlanning.value || planningBusy.value
)
const backgroundPreparation = useBackgroundPreparation({
  project: () => activeProject.value,
  workspace: () => activeWorkspace.value,
  busy: () => conversationBusy.value || hud.killSwitch,
  draft: () => input.value,
})
useIdleOptimization({
  project: () => activeProject.value,
  busy: () => conversationBusy.value || hud.killSwitch,
  draft: () => input.value,
})
watch(conversationBusy, busy => voiceInputSession.setMuted(busy || voiceMuteDepth > 0), { flush: 'sync' })
const liveStatus = computed(() => miniStatus(miniChat.snapshot.value))
useWorkflowWatchers()
useCloudProjects(() => conversationBusy.value || Object.values(projectActivity.value).some(Boolean))
</script>

<template>
  <PayloadApproval />
  <CloudProjectsPanel :open="showCloudProjects" :project-id="activeProjectId" :busy="conversationBusy || Object.values(projectActivity).some(Boolean)" @update:open="showCloudProjects = $event" @select="openProject" />
  <WorkflowWorkspace
    :open="showWorkflows"
    :project-id="activeProjectId"
    :mode="mode"
    :kill-switch="hud.killSwitch"
    :busy="sending || miniChat.state.busy"
    :initial-workflow-id="selectedWorkflowId"
    :initial-run-id="selectedWorkflowRunId"
    @update:open="showWorkflows = $event"
    @discuss="discussWorkflow"
  />
  <PlanningWorkspace
    :open="showPlanning"
    :project-id="activeProjectId"
    :initial-objective="planningObjective"
    :mode="mode"
    :kill-switch="hud.killSwitch"
    :busy="sending || miniChat.state.busy"
    @update:open="showPlanning = $event"
  />
  <AgentHub
    :open="showAgentHub"
    :project-id="activeProjectId"
    :mode="mode"
    :kill-switch="hud.killSwitch"
    @update:open="showAgentHub = $event"
    @memory-imported="refreshMemoryCandidates"
  />
  <Settings
    :open="showSettings"
    :initial-tab="settingsStartTab"
    :mode="mode"
    :kill-switch="hud.killSwitch"
    :test-speech="testSelectedVoice"
    @update:open="showSettings = $event"
  />
  <ToolCenterPanel
    :open="showToolCenter"
    :project-id="activeProjectId"
    :mode="mode"
    :kill-switch="hud.killSwitch"
    @update:open="showToolCenter = $event"
  />
  <Teleport to="body">
    <MiniChatSurface
      v-if="miniChat.browserVisible.value"
      :snapshot="miniChat.snapshot.value"
      @action="miniChat.dispatch"
      @hide="miniChat.browserVisible.value = false"
      @show-main="miniChat.browserVisible.value = false"
    />
  </Teleport>

  <div
    class="app-shell ai-workspace"
    :style="appShellStyle"
    :class="{
      'ai-workspace--collapsed': sidebarCollapsed,
      'ai-workspace--browser': browserPanel.expanded,
      'ai-workspace--system-mini': showSystemPanel && systemStatusDisplayMode === 'mini',
    }"
  >
    <SidebarNav
      v-model:collapsed="sidebarCollapsed"
      :title="appearance.assistantName"
      :items="projectItems"
      :active-id="activeProjectId"
      @select="openProject"
      @rename="renameProject"
      @new-chat="newChat"
      @add-project="addProject"
      @settings="openSettings()"
      @system="showSystemPanel = !showSystemPanel"
      @agents="showAgentHub = true"
      @planning="openPlanning()"
      @workflows="openWorkflows()"
      @cloud-projects="showCloudProjects = true"
    />

    <main class="main-col">
      <div class="header">
        <div class="header__identity">
          <span class="header__eyebrow">Aktiver Raum</span>
          <input
            v-if="editingProjectTitle"
            id="project-title-input"
            v-model="projectTitleDraft"
            class="ai-sidebar__rename"
            aria-label="Projektname bearbeiten"
            maxlength="160"
            @blur="finishProjectTitleEdit"
            @keydown.enter.prevent="finishProjectTitleEdit"
            @keydown.esc.prevent="editingProjectTitle = false"
          />
          <button v-else type="button" class="header__title" title="Projekt umbenennen" @click="beginProjectTitleEdit">
            {{ activeProject?.name }}
            <span
              v-if="projectActivity[activeProjectId]"
              class="ai-sidebar__activity"
              role="status"
              aria-label="KI arbeitet"
            />
          </button>
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
          :disabled="modeConfirmationPending"
          @click="toggleMode"
        >
          <span class="mode-toggle__dot" />
          {{ modeLabel }}
        </button>
        <button
          type="button"
          class="icon-btn"
          :class="{ 'is-on': showToolCenter }"
          title="Tool-Center öffnen"
          aria-label="Tool-Center öffnen"
          :aria-expanded="showToolCenter"
          @click="showToolCenter = true"
        >
          <AiIcon name="tool" :size="16" />
        </button>
        <p v-if="modeConfirmationError" class="repo-graph-message" role="alert">{{ modeConfirmationError }}</p>

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
          aria-label="Luczor Mini öffnen"
          title="Schwebenden Mini-Chat öffnen"
          @click="miniChat.open()"
        >
          <AiIcon name="spark" />
        </button>
        <span v-if="miniChat.error.value" class="ai-muted" role="alert">{{ miniChat.error.value }}</span>
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

      <!-- Overlay stays anchored above the independently scrolling conversation. -->
      <ChatComposer scroll-id="messages" :follow="hasConversation">
        <template #overlay>
          <ChatProjectOverlay
            v-model:context-expanded="showContext"
            v-model:checklist-expanded="showChecklist"
            :project-id="activeProjectId"
            :goal-count="goalStats.total"
            :goals-done="goalStats.done"
            :has-checklist="!!activePlanningSession || activeChecklist.steps.length > 0"
            :checklist-count="activeChecklist.steps.length"
            :checklist-done="checklistDone"
          >
            <template #context>
              <div class="info-strip">
                <div class="info-block">
                  <div class="info-head">
                    <span class="tac-label">Projektziele</span>
                    <span class="info-stat">
                      {{ goalStats.done }}/{{ goalStats.total }} erledigt · {{ goalStats.inProgress }} aktiv ·
                      {{ goalStats.open }} offen
                    </span>
                  </div>
                  <div v-if="projectGoals.length" class="goal-cards">
                    <div v-for="g in projectGoals" :key="g.id" class="goal-card">
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
                      {{
                        activeWorkspace?.status === 'ready' ? 'bereit' : (activeWorkspace?.status ?? 'nicht zugeordnet')
                      }}
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
                    Ordne diesem Luczor-Projekt einen lokalen Ordner zu. Dateiwerkzeuge und Coding-Agenten bleiben
                    anschließend strikt auf diesen Ordner begrenzt.
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
                    <button
                      type="button"
                      class="lz-btn lz-btn--ghost"
                      :disabled="memoryAnalysisBusy"
                      @click="analyzeProjectMemories"
                    >
                      {{ memoryAnalysisBusy ? 'Prüft…' : 'Erinnerungen analysieren' }}
                    </button>
                  </div>
                  <p v-if="memoryAnalysisMessage" class="memory-candidates-help" role="status">
                    {{ memoryAnalysisMessage }}
                  </p>
                  <p class="memory-candidates-help">
                    Automatisch erkannte Inhalte bleiben lokal und werden erst nach deiner Bestätigung dauerhaft
                    übernommen.
                  </p>
                  <div v-if="memoryCandidates.length" class="memory-candidate-list">
                    <RecommendationCard
                      v-for="candidate in memoryCandidates"
                      :key="candidate.id"
                      title="Als Erinnerung behalten?"
                      :description="candidate.content"
                      :evidence="`${MEMORY_PRIORITIES[memoryPriority(candidate.importance)].label} · ${candidate.source === 'assistant' ? 'Assistent' : 'Du'} · ${formatChatTime(candidate.updatedAt)}`"
                      :busy="!!memoryCandidateBusyId"
                      @accept="acceptMemoryCandidate(candidate)"
                      @dismiss="rejectMemoryCandidate(candidate)"
                    />
                  </div>
                  <div v-else class="empty">Keine ungeprüften Erinnerungen.</div>
                </div>
              </div>
            </template>
            <template #checklist>
              <section v-if="activePlanningSession" class="planning-status" aria-label="Aktueller Planungsstand">
                <div aria-live="polite">
                  <strong>{{ planningStatusLabel }}</strong>
                  <span v-if="activePlanningSession.plan"
                    >{{ activePlanningSession.plan.steps.length }} Schritte · Revision
                    {{ activePlanningSession.revision }}</span
                  >
                </div>
                <button type="button" @click="openPlanning()">Planungsfenster öffnen</button>
                <button v-if="planningBusy" type="button" @click="planningHub.cancel(activeProjectId)">
                  Abbrechen
                </button>
              </section>
              <PlanPanel
                :project-id="activeProjectId"
                :collapsed="false"
                @toggle="showChecklist = false"
                @planning="planFromChecklist"
              />
            </template>
          </ChatProjectOverlay>
        </template>
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
              <AiIcon name="check" /><span
                >Gemeinsam planen<small>Ziele, Fragen und Schritte im Chat besprechen</small></span
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
              ><span
                v-if="messageRouteLabel(m.meta)"
                class="ai-message__model"
                :title="m.meta.provider || (m.meta.inferenceTarget === 'local_llama_cpp' ? 'Lokales Modell' : '')"
                >{{ messageRouteLabel(m.meta) }}</span
              >
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
              <WorkflowChatCards
                :workflows="messageWorkflows(m)"
                :project-id="activeProjectId"
                :disabled="sending || hud.killSwitch"
                :read-only="mode === 'observe'"
                @open="openWorkflows"
                @discuss="improveWorkflow"
              />
              <SelectionActions :disabled="sending" @action="editSelection" @speak="speakSelectedText">
                <ChatCommentary :entries="m.meta.commentary ?? []" :message-id="m.id" />
                <StreamingText
                  :content="m.content"
                  :streaming="!!m.meta.isLoading"
                  :animate="false"
                  :question="m.meta.question"
                  :follow-ups="m.meta.bullets"
                  :disabled="sending"
                  :speech-key="`${m.id}:answer`"
                  :speech-disabled="!serverSpeechText(m, { allowLocalContent: localSpeechAllowed })"
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
              <AssistantResponseFooter
                :message-id="m.id"
                :active-message-id="activeThinkingBudget?.messageId"
                :usage="m.meta.tokenUsage"
                :active="chatActivities[m.id]?.status === 'running'"
                :budget="visibleThinkingBudget"
                :control="controlChatThinking"
                @stop="stopGenerating"
              />
              <AgentTeamResults v-if="m.meta.specialistOutcomes?.length" :outcomes="m.meta.specialistOutcomes" />
              <div v-if="continuations[m.id]" class="ai-continuation">
                <button class="ai-model-button" type="button" :disabled="conversationBusy" @click="resumeWork(m.id)">
                  Weiterarbeiten
                </button>
              </div>
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
        <ReadAloudText
          v-if="
            readAlongState &&
            (!readAlongState.key || readAlongState.key === 'context' || readAlongState.key.startsWith('phase:'))
          "
          :playback="readAlongState"
        />
        <span v-else>{{ speechError || speechOutputLabel }}</span>
        <button v-if="speechPending" type="button" @click="stopVoiceOutput">Vorlesen stoppen</button>
        <button v-else type="button" @click="speechError = ''">Schließen</button>
      </div>

      <div ref="composerShell" class="ai-main-composer">
        <PromptBar
          ref="promptBar"
          v-model="input"
          v-model:thinking-tier="thinkingTier"
          v-model:route-mode="chatRouteMode"
          :external-allowed="modelUsageSettings.externalEnabled"
          :busy="conversationBusy"
          :recording="isRecording"
          :listening="listening"
          :voice-busy="voiceInputView.starting || voiceInputView.finishing"
          :model-label="
            chatRouteMode === 'external'
              ? 'Externe Modelle'
              : chatRouteMode === 'auto'
                ? 'Lokal + extern'
                : 'Lokales Modell'
          "
          :context-label="activeWorkspace?.displayName || activeProject?.name"
          :commands="promptCommands"
          @input="setComposerInput(input, 'keyboard')"
          @send="send"
          @stop="
            planningBusy
              ? planningHub.cancel(activeProjectId)
              : miniChat.state.busy
                ? miniChat.stop()
                : stopGenerating()
          "
          @record="togglePushToTalk"
          @listen="toggleListening"
          @voice-start="startConfiguredVoice"
          @voice-stop="voiceInputSession.stop()"
          @model="openSettings('chat')"
          @context="showContext = !showContext"
          @command="handlePromptCommand"
        />
      </div>
    </main>

    <BrowserPanel
      :project-id="activeProjectId"
      :suspended="showSettings || showAgentHub || showCloudProjects || showPlanning || showWorkflows || showToolCenter || showSystemPanel"
    />

    <SystemStatusPanel
      :active="showSystemPanel"
      :assistant-phase="liveStatus.phase"
      :project-name="activeProject?.name"
      :sidebar-collapsed="sidebarCollapsed"
      @close="showSystemPanel = false"
      @display-mode="systemStatusDisplayMode = $event"
      @open-mini="miniChat.open()"
    />
  </div>
</template>

<style scoped src="./styles/app-shell.css"></style>
<style scoped src="./styles/ai-workspace.css"></style>
<style scoped>
.chat-routing-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 8px;
  font-size: 12px;
  color: var(--text-muted, #a5adbc);
}
.chat-routing-choice input {
  accent-color: var(--accent, #81c7f5);
}
.planning-status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  width: 100%;
  max-width: 780px;
  margin: 0 auto 12px;
  padding: 14px 16px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--surface-1);
}
.planning-status > div {
  flex: 1 1 240px;
  display: grid;
  gap: 4px;
}
.planning-status span {
  color: var(--text-muted);
  font-size: 12px;
}
.planning-status button {
  padding: 8px 12px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}
</style>
