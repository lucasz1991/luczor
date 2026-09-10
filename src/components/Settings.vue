<!-- src/components/Settings.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { loadLocalSpeechConsent, saveLocalSpeechConsent } from '@/services/voice/speechConsent'
import { Store } from '@tauri-apps/plugin-store'
import PrivacyDiagnosticsSettings from '@/components/PrivacyDiagnosticsSettings.vue'
import AppearanceSettingsSection from '@/components/settings/AppearanceSettingsSection.vue'
import AccountConnection from '@/components/settings/AccountConnection.vue'
import ChatSettingsSection from '@/components/settings/ChatSettingsSection.vue'
import { modelUsageSettings, saveModelUsageSettings } from '@/services/inference/modelUsageSettings'
import { DEFAULT_TOOL_LIMITS, loadToolLimits, validToolRounds } from '@/services/toolLimits'
import ExecutionSettingsSection from '@/components/settings/ExecutionSettingsSection.vue'
import { listTools } from '@/services/tools/registry'
import type { LuczorMode } from '@/services/inference/types'
import VoiceSettingsSection from '@/components/settings/VoiceSettingsSection.vue'
import { loadDeviceKey } from '@/services/secureDeviceKey'
import { DISABLED_API_BASE_URL, persistApiIdentity } from '@/services/apiIdentitySettings'
import { pushAllToServer, pullServerDefaults } from '@/services/api/sync'
import {
  APP_NOTIFICATION_CATEGORIES,
  getApiConfig,
  DEFAULT_BASE_URL,
  type AppNotificationCategory,
  type NotificationCategoryPreferences,
} from '@/services/api/luczorApi'
import { reinitializeLocalInferenceForCurrentApi } from '@/services/inference/coordinator'
import { loadAppearance, type HudPosition } from '@/services/appearance'
import {
  getPushNotificationPreferences,
  hasNativeNotificationPermission,
  setPushNotificationPreferences,
} from '@/services/notifications'
import { AUTO_EXECUTE_MUTATING_TOOLS_KEY, DEFAULT_EXECUTION_POLICY } from '@/services/executionPolicy'
import { FLASH_EXPERIMENT_SETTING_KEY } from '@/services/inference/hybridRouter'
import {
  getVoiceConfig,
  resolveVoiceSettings,
  validateVoiceSettings,
  voiceSettingsToStore,
  VOICE_DEFAULTS,
  type VoiceMode,
} from '@/services/voice/localVoice'

type SettingsTab = 'server' | 'notifications' | 'execution' | 'voice' | 'chat' | 'appearance' | 'privacy'

const props = withDefaults(
  defineProps<{
    open: boolean
    initialTab?: SettingsTab
    mode?: LuczorMode
    killSwitch?: boolean
    testSpeech: (text: string, signal?: AbortSignal, voiceId?: string) => Promise<'completed' | 'cancelled'>
  }>(),
  {
    initialTab: 'server',
    mode: 'observe',
    killSwitch: false,
  }
)
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

/* ---------------------------
 * Store / State
 * --------------------------- */
type ChatAutoSpeechMode = 'off' | 'assistant_only' | 'all'

type AppSettings = {
  // Luczor Admin API (Laravel sync backend)
  luczor_api_base_url: string
  luczor_device_key: string

  // Chat
  chat_auto_speech: boolean
  chat_auto_speech_mode: ChatAutoSpeechMode
  voice_tts_allow_local_content: boolean
  voice_tts_voice_id: string
  client_history_token_budget: number
  local_model_flash_experiment: boolean

  // Tool execution
  chat_tool_rounds: number
  agent_tool_rounds: number
  background_model_preparation: boolean
  background_context_preparation: boolean
  auto_execute_mutating_tools: boolean

  // Local voice runtime (model binaries stay release-managed)
  voice_mode: VoiceMode
  voice_wake_word: string
  voice_end_phrase: string
  voice_continuous_silence_ms: number
  voice_end_mode: 'close_word' | 'silence' | 'either'
  voice_auto_submit: boolean
  voice_local_stt_language: string

  // Personalization
  ui_accent: string
  ui_hud_visible: boolean
  ui_hud_position: HudPosition
  ui_reduce_motion: boolean
  ui_show_grid: boolean
  ui_scale: number
  assistant_name: string

  // Sync + Memory
  sync_auto: boolean
  sync_auto_threshold: number
  memory_use_server: boolean
  memory_inject: boolean
  memory_inject_count: number
  memory_auto_remember: boolean
  use_server_proxy: boolean
}

const DEFAULTS: AppSettings = {
  luczor_api_base_url: DEFAULT_BASE_URL,
  luczor_device_key: '',

  chat_auto_speech: true,
  chat_auto_speech_mode: 'assistant_only',
  voice_tts_allow_local_content: false,
  voice_tts_voice_id: '',
  client_history_token_budget: 2400,
  local_model_flash_experiment: false,
  chat_tool_rounds: DEFAULT_TOOL_LIMITS.chat,
  agent_tool_rounds: DEFAULT_TOOL_LIMITS.agent,
  background_model_preparation: true,
  background_context_preparation: true,
  auto_execute_mutating_tools: DEFAULT_EXECUTION_POLICY.autoExecuteMutatingTools,
  voice_mode: VOICE_DEFAULTS.mode,
  voice_wake_word: VOICE_DEFAULTS.wakeWord,
  voice_end_phrase: VOICE_DEFAULTS.endPhrase,
  voice_continuous_silence_ms: VOICE_DEFAULTS.continuousSilenceMs,
  voice_end_mode: 'either',
  voice_auto_submit: VOICE_DEFAULTS.autoSubmit,
  voice_local_stt_language: VOICE_DEFAULTS.localSttLanguage,

  ui_accent: 'violet',
  ui_hud_visible: true,
  ui_hud_position: 'br',
  ui_reduce_motion: false,
  ui_show_grid: true,
  ui_scale: 1.0,
  assistant_name: 'Luczor',

  sync_auto: false,
  sync_auto_threshold: 20,
  memory_use_server: true,
  memory_inject: true,
  memory_inject_count: 5,
  memory_auto_remember: true,
  use_server_proxy: true,
}

const ui = reactive({
  tab: 'server' as SettingsTab,
  saved: false,
  error: null as string | null,
  loaded: false,

  // Server tab
  clientId: '',
  serverBusy: false,
  serverResult: null as { ok: boolean; message: string } | null,
})

const notificationCategoryLabels: Record<AppNotificationCategory, { title: string; desc: string }> = {
  general: { title: 'Allgemein', desc: 'Hinweise und wichtige Neuigkeiten' },
  agent: { title: 'Agenten', desc: 'Ergebnisse und Rückfragen laufender Agenten' },
  workflow: { title: 'Workflows', desc: 'Status und Abschluss automatisierter Abläufe' },
  device: { title: 'Gerät', desc: 'Desktop-Aufgaben und Geräteverbindung' },
  security: { title: 'Sicherheit', desc: 'Freigaben und sicherheitskritische Ereignisse' },
}

const notificationUi = reactive({
  loaded: false,
  busy: false,
  enabled: false,
  permission: 'unknown' as 'unknown' | 'granted' | 'missing',
  categories: {
    general: true,
    agent: true,
    workflow: true,
    device: true,
    security: true,
  } as NotificationCategoryPreferences,
  message: null as { ok: boolean; text: string } | null,
})

const settings = reactive<AppSettings>({ ...DEFAULTS })
const modelUsageDraft = ref({ ...modelUsageSettings.value })
const saving = ref(false)
const registeredTools = listTools()

let settingsStore: Store | null = null

const canSave = computed(() => ui.loaded && !saving.value)

function closeModal() {
  emit('update:open', false)
  ui.saved = false
  ui.error = null
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function setSavedPulse() {
  ui.saved = true
  window.setTimeout(() => (ui.saved = false), 900)
}

async function ensureStoreLoaded() {
  if (ui.loaded) return

  settingsStore = await Store.load('luczor.settings.json')

  // Luczor Admin API
  const apiBase = await settingsStore.get<string>('luczor_api_base_url')
  if (apiBase) settings.luczor_api_base_url = apiBase
  if (apiBase === DISABLED_API_BASE_URL) {
    ui.error =
      'Die Serververbindung wurde nach einem Speicherfehler gesperrt. Bitte die gewünschte Server-URL und den Device-Key erneut eintragen und speichern.'
  }
  settings.luczor_device_key = await loadDeviceKey()
  ui.clientId = (await getApiConfig()).clientId

  // Chat
  const autoSpeech = await settingsStore.get<boolean>('chat_auto_speech')
  if (typeof autoSpeech === 'boolean') settings.chat_auto_speech = autoSpeech
  settings.voice_tts_allow_local_content = await loadLocalSpeechConsent()
  settings.voice_tts_voice_id = (await settingsStore.get<string>('voice_tts_voice_id')) || ''

  const mode = await settingsStore.get<ChatAutoSpeechMode>('chat_auto_speech_mode')
  if (mode === 'off' || mode === 'assistant_only' || mode === 'all') settings.chat_auto_speech_mode = mode
  const historyBudget = await settingsStore.get<number>('client_history_token_budget')
  if (typeof historyBudget === 'number' && !Number.isNaN(historyBudget))
    settings.client_history_token_budget = clamp(historyBudget, 400, 12000)
  settings.local_model_flash_experiment = (await settingsStore.get<boolean>(FLASH_EXPERIMENT_SETTING_KEY)) === true
  const toolLimits = await loadToolLimits()
  settings.chat_tool_rounds = toolLimits.chat
  settings.agent_tool_rounds = toolLimits.agent
  settings.background_model_preparation = (await settingsStore.get<unknown>('background_model_preparation')) !== false
  settings.background_context_preparation =
    (await settingsStore.get<unknown>('background_context_preparation')) !== false
  const autoExecuteMutatingTools = await settingsStore.get<unknown>(AUTO_EXECUTE_MUTATING_TOOLS_KEY)
  settings.auto_execute_mutating_tools = autoExecuteMutatingTools === true
  Object.assign(settings, voiceSettingsToStore(await getVoiceConfig()))

  // Personalization
  const accent = await settingsStore.get<string>('ui_accent')
  if (accent) settings.ui_accent = accent
  settings.ui_hud_visible = true
  const hudPos = await settingsStore.get<HudPosition>('ui_hud_position')
  if (hudPos === 'br' || hudPos === 'bl' || hudPos === 'tr' || hudPos === 'tl') settings.ui_hud_position = hudPos
  const rm = await settingsStore.get<boolean>('ui_reduce_motion')
  if (typeof rm === 'boolean') settings.ui_reduce_motion = rm
  const grid = await settingsStore.get<boolean>('ui_show_grid')
  if (typeof grid === 'boolean') settings.ui_show_grid = grid
  const uiScale = await settingsStore.get<number>('ui_scale')
  if (typeof uiScale === 'number' && !Number.isNaN(uiScale)) settings.ui_scale = clamp(uiScale, 0.8, 1.4)
  const aName = await settingsStore.get<string>('assistant_name')
  if (aName) settings.assistant_name = aName

  // Sync + Memory
  const sAuto = await settingsStore.get<boolean>('sync_auto')
  if (typeof sAuto === 'boolean') settings.sync_auto = sAuto
  const sThr = await settingsStore.get<number>('sync_auto_threshold')
  if (typeof sThr === 'number' && !Number.isNaN(sThr)) settings.sync_auto_threshold = sThr
  const memSrv = await settingsStore.get<boolean>('memory_use_server')
  if (typeof memSrv === 'boolean') settings.memory_use_server = memSrv
  const mInj = await settingsStore.get<boolean>('memory_inject')
  if (typeof mInj === 'boolean') settings.memory_inject = mInj
  const mCnt = await settingsStore.get<number>('memory_inject_count')
  if (typeof mCnt === 'number' && !Number.isNaN(mCnt)) settings.memory_inject_count = mCnt
  const mRem = await settingsStore.get<boolean>('memory_auto_remember')
  if (typeof mRem === 'boolean') settings.memory_auto_remember = mRem
  settings.use_server_proxy = true

  // One-way migration: local provider credentials and voice paths must not
  // remain in the desktop settings store.
  for (const key of [
    'openrouter_api_key',
    'elevenlabs_api_key',
    'elevenlabs_voice_id',
    'elevenlabs_tts_model',
    'elevenlabs_tts_output_format',
    'elevenlabs_tts_speed',
    'elevenlabs_stt_model',
    'elevenlabs_stt_language_code',
    'voice_stt_backend',
    'voice_tts_backend',
    'voice_local_stt_binary',
    'voice_local_stt_model',
    'voice_local_tts_binary',
    'voice_local_tts_model',
    'chat_auto_speech_rate',
    'chat_auto_speech_volume',
  ])
    await settingsStore.delete(key)
  await settingsStore.save()

  ui.loaded = true
}

async function saveAll() {
  if (!settingsStore || saving.value) return
  saving.value = true
  ui.saved = false
  try {
    await persistAll()
  } catch (error) {
    ui.error = error instanceof Error ? error.message : 'Die Einstellungen konnten nicht gespeichert werden.'
  } finally {
    saving.value = false
  }
}

async function persistAll() {
  if (!settingsStore) return
  ui.error = null

  if (!validToolRounds(settings.chat_tool_rounds) || !validToolRounds(settings.agent_tool_rounds)) {
    ui.error = 'Tool-Limits: Bitte ganze Zahlen zwischen 1 und 64 eingeben.'
    ui.tab = 'execution'
    return
  }
  const voiceDraft = {
    mode: settings.voice_mode,
    wakeWord: settings.voice_wake_word,
    endPhrase: settings.voice_end_phrase,
    localSttLanguage: settings.voice_local_stt_language,
    continuousSilenceMs: settings.voice_continuous_silence_ms,
    autoSubmit: settings.voice_auto_submit,
    endMode: settings.voice_end_mode,
  }
  const voiceError = validateVoiceSettings(voiceDraft)
  if (voiceError) {
    ui.error = voiceError
    ui.tab = 'voice'
    return
  }
  const voiceValues = voiceSettingsToStore(resolveVoiceSettings(voiceSettingsToStore(voiceDraft)))

  // Minimal validation only when API tab is open (skipped when using the server proxy)
  if (false) {
    const or = 'server-managed'
    if (!or) {
      ui.error = 'Bitte OpenRouter API Key eingeben (oder Server-Proxy nutzen / anderen Tab wählen).'
      return
    }
  }

  // Luczor Admin API. Invalidate the signed local policy before changing the
  // account/server identity; a fresh bootstrap may reactivate it afterwards.
  let apiIdentityChanged: boolean
  try {
    apiIdentityChanged = await persistApiIdentity(
      settingsStore,
      settings.luczor_api_base_url,
      settings.luczor_device_key
    )
  } catch (error) {
    ui.error = error instanceof Error ? error.message : 'Server-Einstellungen konnten nicht gespeichert werden.'
    return
  }

  // Chat
  await settingsStore.set('chat_auto_speech', settings.chat_auto_speech)
  await settingsStore.set('chat_auto_speech_mode', settings.chat_auto_speech_mode)
  if (apiIdentityChanged) settings.voice_tts_allow_local_content = false
  if (apiIdentityChanged) settings.voice_tts_voice_id = ''
  await saveLocalSpeechConsent(settings.voice_tts_allow_local_content)
  await settingsStore.set('voice_tts_voice_id', settings.voice_tts_voice_id)
  await settingsStore.set(
    'client_history_token_budget',
    clamp(Math.round(settings.client_history_token_budget), 400, 12000)
  )
  await settingsStore.set(FLASH_EXPERIMENT_SETTING_KEY, settings.local_model_flash_experiment)
  await settingsStore.set('chat_tool_rounds', settings.chat_tool_rounds)
  await settingsStore.set('agent_tool_rounds', settings.agent_tool_rounds)
  await settingsStore.set('background_model_preparation', settings.background_model_preparation)
  await settingsStore.set('background_context_preparation', settings.background_context_preparation)
  await settingsStore.set(AUTO_EXECUTE_MUTATING_TOOLS_KEY, settings.auto_execute_mutating_tools)
  for (const [key, value] of Object.entries(voiceValues)) await settingsStore.set(key, value)

  // Personalization
  await settingsStore.set('ui_accent', settings.ui_accent)
  settings.ui_hud_visible = true
  await settingsStore.set('ui_hud_visible', true)
  await settingsStore.set('ui_hud_position', settings.ui_hud_position)
  await settingsStore.set('ui_reduce_motion', settings.ui_reduce_motion)
  await settingsStore.set('ui_show_grid', settings.ui_show_grid)
  await settingsStore.set('ui_scale', clamp(settings.ui_scale, 0.8, 1.4))
  await settingsStore.set('assistant_name', settings.assistant_name.trim() || 'Luczor')

  // Sync + Memory
  await settingsStore.set('sync_auto', settings.sync_auto)
  await settingsStore.set('sync_auto_threshold', clamp(Math.round(settings.sync_auto_threshold), 1, 500))
  await settingsStore.set('memory_use_server', settings.memory_use_server)
  await settingsStore.set('memory_inject', settings.memory_inject)
  await settingsStore.set('memory_inject_count', clamp(Math.round(settings.memory_inject_count), 0, 20))
  await settingsStore.set('memory_auto_remember', settings.memory_auto_remember)
  settings.use_server_proxy = true
  await settingsStore.set('use_server_proxy', true)

  await settingsStore.save()
  await saveModelUsageSettings({ ...modelUsageDraft.value })
  Object.assign(settings, voiceValues)
  window.dispatchEvent(new Event('luczor:voice-settings-changed'))
  if (apiIdentityChanged) void refreshServerPolicy()
  await loadAppearance() // re-apply theme/HUD/name live
  setSavedPulse()
}

async function resetChatSettings() {
  settings.chat_auto_speech = DEFAULTS.chat_auto_speech
  settings.chat_auto_speech_mode = DEFAULTS.chat_auto_speech_mode
  settings.voice_tts_allow_local_content = DEFAULTS.voice_tts_allow_local_content
  await saveAll()
}

/* ---------------------------
 * Server (Laravel Admin API)
 * --------------------------- */
async function refreshServerPolicy(diagnoseUnavailable = false) {
  try {
    const result = await reinitializeLocalInferenceForCurrentApi({ diagnoseUnavailable })
    if (!result.stale) ui.serverResult = result
  } catch {
    ui.serverResult = {
      ok: false,
      message: 'Die Modellrichtlinie konnte nicht geprüft werden. Bitte die Verbindung erneut testen.',
    }
  }
}

async function persistServerConfig(refreshPolicy = true) {
  if (!settingsStore) return
  const apiIdentityChanged = await persistApiIdentity(
    settingsStore,
    settings.luczor_api_base_url,
    settings.luczor_device_key
  )
  if (apiIdentityChanged && refreshPolicy) void refreshServerPolicy()
}

async function testServer() {
  if (ui.serverBusy) return
  ui.serverResult = null
  ui.serverBusy = true
  try {
    await persistServerConfig(false)
    await refreshServerPolicy(true)
  } catch (e: any) {
    ui.serverResult = { ok: false, message: e?.message ?? String(e) }
  } finally {
    ui.serverBusy = false
  }
}

async function acceptAccountKey(key: string) {
  settings.luczor_device_key = key
  await testServer()
}

async function pullDefaults() {
  ui.serverResult = null
  ui.serverBusy = true
  try {
    await persistServerConfig()
    const n = await pullServerDefaults()
    ui.loaded = false
    await ensureStoreLoaded()
    await loadAppearance()
    ui.serverResult = { ok: true, message: `${n} Server-Einstellungen übernommen.` }
  } catch (e: any) {
    ui.serverResult = { ok: false, message: e?.message ?? String(e) }
  } finally {
    ui.serverBusy = false
  }
}

async function syncNow() {
  ui.serverResult = null
  ui.serverBusy = true
  try {
    await persistServerConfig()
    const r = await pushAllToServer()
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0)
    const detail = Object.entries(r.counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ')
    ui.serverResult = { ok: true, message: `Synchronisiert: ${total} Einträge (${detail}).` }
  } catch (e: any) {
    ui.serverResult = { ok: false, message: e?.message ?? String(e) }
  } finally {
    ui.serverBusy = false
  }
}

async function loadNotificationSettings(force = false) {
  if (notificationUi.loaded && !force) return
  notificationUi.busy = true
  notificationUi.message = null
  try {
    notificationUi.permission = (await hasNativeNotificationPermission()) ? 'granted' : 'missing'
    const preferences = await getPushNotificationPreferences()
    notificationUi.enabled = preferences.enabled
    Object.assign(notificationUi.categories, preferences.categories)
    notificationUi.loaded = true
  } catch (error: any) {
    notificationUi.message = {
      ok: false,
      text: error?.message ?? 'Benachrichtigungseinstellungen konnten nicht geladen werden.',
    }
  } finally {
    notificationUi.busy = false
  }
}

async function togglePushNotifications() {
  if (notificationUi.busy) return
  notificationUi.busy = true
  notificationUi.message = null
  const nextEnabled = !notificationUi.enabled
  try {
    const preferences = await setPushNotificationPreferences({ enabled: nextEnabled })
    notificationUi.enabled = preferences.enabled
    Object.assign(notificationUi.categories, preferences.categories)
    notificationUi.permission = (await hasNativeNotificationPermission()) ? 'granted' : 'missing'
    notificationUi.loaded = true
    notificationUi.message = {
      ok: true,
      text: nextEnabled
        ? 'Push-Benachrichtigungen sind auf diesem Gerät aktiv.'
        : 'Push-Benachrichtigungen sind auf diesem Gerät pausiert.',
    }
  } catch (error: any) {
    notificationUi.permission = (await hasNativeNotificationPermission()) ? 'granted' : 'missing'
    notificationUi.message = {
      ok: false,
      text: error?.message ?? 'Push-Benachrichtigungen konnten nicht geändert werden.',
    }
  } finally {
    notificationUi.busy = false
  }
}

async function toggleNotificationCategory(category: AppNotificationCategory) {
  if (notificationUi.busy) return
  notificationUi.busy = true
  notificationUi.message = null
  const nextValue = !notificationUi.categories[category]
  try {
    const preferences = await setPushNotificationPreferences({
      categories: { [category]: nextValue },
    })
    Object.assign(notificationUi.categories, preferences.categories)
    notificationUi.enabled = preferences.enabled
    notificationUi.message = { ok: true, text: 'Kategorie aktualisiert.' }
  } catch (error: any) {
    notificationUi.message = {
      ok: false,
      text: error?.message ?? 'Kategorie konnte nicht geändert werden.',
    }
  } finally {
    notificationUi.busy = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') closeModal()
}

watch(
  () => props.open,
  async v => {
    if (v) {
      document.body.style.overflow = 'hidden'
      ui.saved = false
      ui.error = null
      modelUsageDraft.value = { ...modelUsageSettings.value }
      ui.tab = props.initialTab
      await ensureStoreLoaded()
      if (ui.tab === 'notifications') await loadNotificationSettings(true)
    } else {
      document.body.style.overflow = ''
      ui.saved = false
      ui.error = null
    }
  },
  { immediate: true }
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

/* ---------------------------
 * Sidebar items
 * --------------------------- */
const tabs: Array<{
  id: SettingsTab
  title: string
  desc: string
  icon: string
}> = [
  { id: 'server', title: 'Server', desc: 'Laravel Sync API', icon: 'server' },
  { id: 'notifications', title: 'Benachrichtigungen', desc: 'Native Pushs', icon: 'bell' },
  { id: 'execution', title: 'Ausführung', desc: 'Freigaben & Sicherheit', icon: 'shield' },
  { id: 'voice', title: 'Voice', desc: 'Lokale STT · Server-TTS', icon: 'mic' },
  { id: 'chat', title: 'Chat & Agenten', desc: 'Modelle, Ressourcen & Sprache', icon: 'chat' },
  { id: 'appearance', title: 'Appearance', desc: 'UI (später)', icon: 'palette' },
  { id: 'privacy', title: 'Datenschutz', desc: 'Diagnose & Freigabe', icon: 'shield' },
]

function selectTab(id: SettingsTab) {
  ui.tab = id
  ui.error = null
  ui.saved = false
  if (id === 'notifications') void loadNotificationSettings()
}

function iconPath(kind: string) {
  switch (kind) {
    case 'key':
      return 'M21 2l-2 2m-7.5 7.5L19 4M7 14a4 4 0 1 1 3.9-5M7 18h4l1.5-1.5L14 18h2l1.5-1.5L19 18h2v-2l-5.5-5.5'
    case 'chat':
      return 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'
    case 'server':
      return 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 16a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 6.5h.01M8 17.5h.01'
    case 'mic':
      return 'M9 4a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3'
    case 'bell':
      return 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4'
    case 'palette':
      return 'M12 22a10 10 0 1 0-10-10 3 3 0 0 0 3 3h1a2 2 0 0 1 2 2 3 3 0 0 0 3 3zm5.5-9.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z'
    case 'shield':
    default:
      return 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'
  }
}
</script>

<template>
  <teleport to="body">
    <div v-if="open" class="lz-root">
      <button type="button" class="lz-backdrop" aria-label="Einstellungen schließen" @click="closeModal" />

      <div class="lz-modal" role="dialog" aria-modal="true" aria-label="Luczor Einstellungen">
        <!-- Header -->
        <div class="lz-head">
          <div class="lz-head__brand">
            <span class="lz-dot" />
            <div>
              <div class="lz-title">Konfiguration</div>
              <div class="lz-sub">Luczor · System</div>
            </div>
          </div>
          <div class="lz-head__actions">
            <transition name="lz-fade">
              <span v-if="ui.saved" class="lz-saved">gespeichert</span>
            </transition>
            <button type="button" class="lz-x" title="Schließen (Esc)" @click="closeModal">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div class="lz-body">
          <!-- Sidebar -->
          <aside class="lz-nav" role="tablist" aria-label="Einstellungsbereiche">
            <div class="tac-label lz-nav__label">Bereiche</div>
            <button
              v-for="t in tabs"
              :key="t.id"
              type="button"
              class="lz-tab"
              :class="{ 'is-active': ui.tab === t.id }"
              role="tab"
              :aria-selected="ui.tab === t.id"
              :aria-current="ui.tab === t.id ? 'page' : undefined"
              @click="selectTab(t.id)"
            >
              <span class="lz-tab__icon">
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
                  <path :d="iconPath(t.icon)" />
                </svg>
              </span>
              <span class="min-w-0">
                <span class="lz-tab__title">{{ t.title }}</span>
                <span class="lz-tab__desc">{{ t.desc }}</span>
              </span>
            </button>
          </aside>

          <!-- Main -->
          <section class="lz-main" role="tabpanel">
            <div class="lz-scroll">
              <p v-if="ui.error" class="lz-result is-fail" role="alert">{{ ui.error }}</p>
              <!-- SERVER -->
              <div v-if="ui.tab === 'server'" class="lz-section">
                <AccountConnection
                  :base-url="settings.luczor_api_base_url"
                  :client-id="ui.clientId || ''"
                  @connected="acceptAccountKey"
                />
                <div class="lz-section__head">
                  <h3>Luczor Server (Admin API)</h3>
                  <p>
                    Verbindung für Synchronisierung, Serverdienste und die gemeinsame Sprachausgabe. Lokale
                    Spracheingabe und installierte lokale Funktionen bleiben auf dem Gerät nutzbar; Server-Sprachausgabe
                    benötigt eine Verbindung.
                  </p>
                </div>
                <div class="lz-card">
                  <label class="lz-label">Server URL (optional)</label>
                  <input
                    v-model="settings.luczor_api_base_url"
                    type="text"
                    autocomplete="off"
                    :placeholder="DEFAULT_BASE_URL"
                    class="lz-input"
                  />
                  <p class="lz-hint">
                    Leer = Standard <span class="mono">{{ DEFAULT_BASE_URL }}</span
                    >. Eigene URL nur bei Bedarf. Provider-Keys liegen verschlüsselt auf dem Server.
                  </p>

                  <label class="lz-label">Device Key</label>
                  <input
                    v-model="settings.luczor_device_key"
                    type="password"
                    autocomplete="off"
                    placeholder="Device API Key aus dem Admin-Dashboard"
                    class="lz-input"
                  />
                  <p class="lz-hint">Wird als <span class="mono">Authorization: Bearer …</span> gesendet.</p>

                  <div class="lz-card__meta">
                    Client-ID: <span class="mono">{{ ui.clientId || '—' }}</span>
                  </div>

                  <div class="lz-actions">
                    <button type="button" class="lz-btn lz-btn--ghost" :disabled="ui.serverBusy" @click="testServer">
                      {{ ui.serverBusy ? '…' : 'Verbindung testen' }}
                    </button>
                    <button type="button" class="lz-btn lz-btn--primary" :disabled="ui.serverBusy" @click="syncNow">
                      {{ ui.serverBusy ? '…' : 'Jetzt synchronisieren' }}
                    </button>
                    <button type="button" class="lz-btn lz-btn--ghost" :disabled="ui.serverBusy" @click="pullDefaults">
                      Server-Defaults übernehmen
                    </button>
                  </div>
                  <p v-if="ui.serverResult" class="lz-result" :class="ui.serverResult.ok ? 'is-ok' : 'is-fail'">
                    {{ ui.serverResult.message }}
                  </p>
                </div>

                <div class="lz-card">
                  <div class="lz-card__title">Provider-Proxy & Sync</div>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Provider-Proxy (Keys auf dem Server)</span>
                    <button type="button" class="lz-switch is-on" disabled><span /></button>
                  </div>
                  <p class="lz-hint">
                    An = Chat läuft über den Server, der den OpenRouter-Key injiziert. Dann ist lokal kein
                    OpenRouter-Key nötig.
                  </p>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Flash-Next lokal experimentell bevorzugen</span>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': settings.local_model_flash_experiment }"
                      role="switch"
                      :aria-checked="settings.local_model_flash_experiment"
                      @click="settings.local_model_flash_experiment = !settings.local_model_flash_experiment"
                    >
                      <span />
                    </button>
                  </div>
                  <p class="lz-hint">
                    Standardmäßig aus. Wirkt nur, wenn das signierte Manifest Flash-Next ausdrücklich aktiviert, aber
                    noch nicht zum stabilen Hauptmodell befördert hat, und alle lokalen Prüfungen bestehen.
                  </p>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Auto-Sync im Hintergrund</span>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': settings.sync_auto }"
                      @click="settings.sync_auto = !settings.sync_auto"
                    >
                      <span />
                    </button>
                  </div>
                  <div>
                    <label class="lz-label">Auto-Sync ab Schwelle</label>
                    <div class="lz-range">
                      <input v-model.number="settings.sync_auto_threshold" type="range" min="1" max="100" step="1" />
                      <span class="lz-range__val">{{ settings.sync_auto_threshold }}</span>
                    </div>
                  </div>

                  <div class="lz-row">
                    <span class="lz-rowlabel">Server-Memory (Cognee) nutzen</span>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': settings.memory_use_server }"
                      @click="settings.memory_use_server = !settings.memory_use_server"
                    >
                      <span />
                    </button>
                  </div>
                  <p class="lz-hint">
                    An = Erinnerungen laufen über den Server (Cognee bleibt intern, kein Endpoint/Key im Client). Aus =
                    nur lokaler Memory-Puffer.
                  </p>

                  <div class="lz-row">
                    <span class="lz-rowlabel">Erinnerungen in Prompt einblenden</span>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': settings.memory_inject }"
                      @click="settings.memory_inject = !settings.memory_inject"
                    >
                      <span />
                    </button>
                  </div>
                  <div>
                    <label class="lz-label">Anzahl eingeblendeter Erinnerungen</label>
                    <div class="lz-range">
                      <input v-model.number="settings.memory_inject_count" type="range" min="0" max="20" step="1" />
                      <span class="lz-range__val">{{ settings.memory_inject_count }}</span>
                    </div>
                  </div>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Antworten automatisch merken</span>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': settings.memory_auto_remember }"
                      @click="settings.memory_auto_remember = !settings.memory_auto_remember"
                    >
                      <span />
                    </button>
                  </div>
                </div>
              </div>

              <!-- NOTIFICATIONS -->
              <div v-else-if="ui.tab === 'notifications'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Push-Benachrichtigungen</h3>
                  <p>Native Desktop-Hinweise über den privaten Gerätekanal – auch wenn Luczor im Hintergrund läuft.</p>
                </div>

                <div class="lz-card lz-notification-hero">
                  <div class="lz-card__head">
                    <div>
                      <div class="lz-card__title">Push auf diesem Gerät</div>
                      <div class="lz-card__meta">
                        {{
                          notificationUi.permission === 'granted'
                            ? 'Betriebssystem-Berechtigung erteilt'
                            : 'Betriebssystem-Berechtigung noch nicht erteilt'
                        }}
                      </div>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': notificationUi.enabled }"
                      role="switch"
                      :aria-checked="notificationUi.enabled"
                      aria-label="Push-Benachrichtigungen auf diesem Gerät"
                      :disabled="notificationUi.busy"
                      @click="togglePushNotifications"
                    >
                      <span />
                    </button>
                  </div>

                  <div class="lz-permission">
                    <span
                      class="lz-permission__badge"
                      :class="notificationUi.permission === 'granted' ? 'is-ok' : 'is-waiting'"
                    >
                      <i />
                      {{ notificationUi.permission === 'granted' ? 'OS-Zugriff aktiv' : 'Freigabe erforderlich' }}
                    </span>
                    <span>Die Betriebssystemfreigabe wird erst beim bewussten Aktivieren geprüft.</span>
                  </div>

                  <p
                    v-if="notificationUi.message"
                    class="lz-result"
                    :class="notificationUi.message.ok ? 'is-ok' : 'is-fail'"
                    role="status"
                  >
                    {{ notificationUi.message.text }}
                  </p>
                </div>

                <div class="lz-card">
                  <div class="lz-card__title">Kategorien</div>
                  <p class="lz-hint">
                    Wähle, welche Ereignisse als native Hinweise zugestellt werden. Diese Kategorien gelten für alle
                    verbundenen Geräte; der Hauptschalter oben gilt nur für diese Installation.
                  </p>
                  <div class="lz-notification-list">
                    <div v-for="category in APP_NOTIFICATION_CATEGORIES" :key="category" class="lz-notification-row">
                      <div>
                        <span class="lz-rowlabel">{{ notificationCategoryLabels[category].title }}</span>
                        <span class="lz-card__meta">{{ notificationCategoryLabels[category].desc }}</span>
                      </div>
                      <button
                        type="button"
                        class="lz-switch"
                        :class="{ 'is-on': notificationUi.categories[category] }"
                        role="switch"
                        :aria-checked="notificationUi.categories[category]"
                        :aria-label="`${notificationCategoryLabels[category].title} Benachrichtigungen`"
                        :disabled="notificationUi.busy"
                        @click="toggleNotificationCategory(category)"
                      >
                        <span />
                      </button>
                    </div>
                  </div>
                </div>

                <div class="lz-callout">
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
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <path d="M9 12l2 2 4-5" />
                  </svg>
                  <span
                    >Die Zustellung nutzt denselben authentifizierten Reverb-Kanal wie Geräteaufgaben. Es werden keine
                    Browser-Service-Worker oder VAPID-Schlüssel benötigt.</span
                  >
                </div>
              </div>

              <!-- EXECUTION -->
              <ExecutionSettingsSection
                v-else-if="ui.tab === 'execution'"
                v-model:auto-execute-mutating-tools="settings.auto_execute_mutating_tools"
                v-model:chat-tool-rounds="settings.chat_tool_rounds"
                v-model:agent-tool-rounds="settings.agent_tool_rounds"
                v-model:background-model-preparation="settings.background_model_preparation"
                v-model:background-context-preparation="settings.background_context_preparation"
                :mode="props.mode"
                :kill-switch="props.killSwitch"
                :tools="registeredTools"
              />

              <!-- VOICE -->
              <VoiceSettingsSection
                v-else-if="ui.tab === 'voice'"
                v-model:voice-mode="settings.voice_mode"
                v-model:wake-word="settings.voice_wake_word"
                v-model:end-phrase="settings.voice_end_phrase"
                v-model:continuous-silence-ms="settings.voice_continuous_silence_ms"
                v-model:end-mode="settings.voice_end_mode"
                v-model:auto-submit="settings.voice_auto_submit"
                v-model:stt-language="settings.voice_local_stt_language"
                v-model:voice-id="settings.voice_tts_voice_id"
                :test-speech="props.testSpeech"
                :device-key="settings.luczor_device_key"
                @open-server="selectTab('server')"
              />

              <!-- CHAT -->
              <ChatSettingsSection
                v-else-if="ui.tab === 'chat'"
                v-model:model-usage="modelUsageDraft"
                v-model:auto-speech="settings.chat_auto_speech"
                v-model:auto-speech-mode="settings.chat_auto_speech_mode"
                v-model:allow-local-speech="settings.voice_tts_allow_local_content"
                v-model:history-token-budget="settings.client_history_token_budget"
                @reset="resetChatSettings"
              />

              <!-- APPEARANCE / PERSONALIZATION -->
              <AppearanceSettingsSection
                v-else-if="ui.tab === 'appearance'"
                v-model:assistant-name="settings.assistant_name"
                v-model:accent="settings.ui_accent"
                v-model:hud-position="settings.ui_hud_position"
                v-model:ui-scale="settings.ui_scale"
                v-model:hud-visible="settings.ui_hud_visible"
                v-model:show-grid="settings.ui_show_grid"
                v-model:reduce-motion="settings.ui_reduce_motion"
              />
              <!-- PRIVACY -->
              <div v-else-if="ui.tab === 'privacy'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Datenschutz</h3>
                  <p>
                    Ohne ausdrückliche Freigabe werden keine Diagnosedaten erfasst oder an die Administration
                    übertragen.
                  </p>
                </div>
                <PrivacyDiagnosticsSettings />
              </div>
            </div>

            <!-- Footer -->
            <div class="lz-foot">
              <button type="button" class="lz-btn lz-btn--ghost" @click="closeModal">Schließen</button>
              <button type="button" class="lz-btn lz-btn--primary" :disabled="!canSave" @click="saveAll">
                Speichern
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style src="./settings/settings.css"></style>
