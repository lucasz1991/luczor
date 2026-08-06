<!-- src/components/Settings.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, watch } from "vue";
import { Store } from "@tauri-apps/plugin-store";
import { testConnection, pushAllToServer, pullServerDefaults } from "@/services/api/sync";
import {
  APP_NOTIFICATION_CATEGORIES,
  getApiConfig,
  DEFAULT_BASE_URL,
  type AppNotificationCategory,
  type NotificationCategoryPreferences,
} from "@/services/api/luczorApi";
import { loadAppearance, ACCENT_NAMES, type HudPosition } from "@/services/appearance";
import {
  getPushNotificationPreferences,
  hasNativeNotificationPermission,
  setPushNotificationPreferences,
} from "@/services/notifications";
import {
  AUTO_EXECUTE_MUTATING_TOOLS_KEY,
  DEFAULT_EXECUTION_POLICY,
} from "@/services/executionPolicy";
import type { VoiceMode } from "@/services/voice/localVoice";

type SettingsTab = "server" | "notifications" | "execution" | "voice" | "chat" | "appearance" | "privacy";

const props = withDefaults(defineProps<{ open: boolean; initialTab?: SettingsTab }>(), {
  initialTab: "server",
});
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

/* ---------------------------
 * Store / State
 * --------------------------- */
type ChatAutoSpeechMode = "off" | "assistant_only" | "all";

type AppSettings = {
  // Luczor Admin API (Laravel sync backend)
  luczor_api_base_url: string;
  luczor_device_key: string;

  // Chat
  chat_auto_speech: boolean;
  chat_auto_speech_mode: ChatAutoSpeechMode;
  client_history_token_budget: number;

  // Tool execution
  auto_execute_mutating_tools: boolean;

  // Local voice runtime (model binaries stay release-managed)
  voice_mode: VoiceMode;
  voice_wake_word: string;
  voice_local_stt_language: string;

  // Personalization
  ui_accent: string;
  ui_hud_visible: boolean;
  ui_hud_position: HudPosition;
  ui_reduce_motion: boolean;
  ui_show_grid: boolean;
  ui_scale: number;
  assistant_name: string;

  // Sync + Memory
  sync_auto: boolean;
  sync_auto_threshold: number;
  memory_use_server: boolean;
  memory_inject: boolean;
  memory_inject_count: number;
  memory_auto_remember: boolean;
  use_server_proxy: boolean;
};

const DEFAULTS: AppSettings = {
  luczor_api_base_url: DEFAULT_BASE_URL,
  luczor_device_key: "",

  chat_auto_speech: true,
  chat_auto_speech_mode: "assistant_only",
  client_history_token_budget: 2400,
  auto_execute_mutating_tools: DEFAULT_EXECUTION_POLICY.autoExecuteMutatingTools,
  voice_mode: "wakeword",
  voice_wake_word: "luczor",
  voice_local_stt_language: "de",

  ui_accent: "violet",
  ui_hud_visible: true,
  ui_hud_position: "br",
  ui_reduce_motion: false,
  ui_show_grid: true,
  ui_scale: 1.0,
  assistant_name: "Luczor",

  sync_auto: false,
  sync_auto_threshold: 20,
  memory_use_server: true,
  memory_inject: true,
  memory_inject_count: 5,
  memory_auto_remember: true,
  use_server_proxy: true,
};

const ui = reactive({
  tab: "server" as SettingsTab,
  saved: false,
  error: null as string | null,
  loaded: false,

  // Server tab
  clientId: "",
  serverBusy: false,
  serverResult: null as { ok: boolean; message: string } | null,
});

const notificationCategoryLabels: Record<AppNotificationCategory, { title: string; desc: string }> = {
  general: { title: "Allgemein", desc: "Hinweise und wichtige Neuigkeiten" },
  agent: { title: "Agenten", desc: "Ergebnisse und Rückfragen laufender Agenten" },
  workflow: { title: "Workflows", desc: "Status und Abschluss automatisierter Abläufe" },
  device: { title: "Gerät", desc: "Desktop-Aufgaben und Geräteverbindung" },
  security: { title: "Sicherheit", desc: "Freigaben und sicherheitskritische Ereignisse" },
};

const notificationUi = reactive({
  loaded: false,
  busy: false,
  enabled: false,
  permission: "unknown" as "unknown" | "granted" | "missing",
  categories: {
    general: true,
    agent: true,
    workflow: true,
    device: true,
    security: true,
  } as NotificationCategoryPreferences,
  message: null as { ok: boolean; text: string } | null,
});

const settings = reactive<AppSettings>({ ...DEFAULTS });

let settingsStore: Store | null = null;

const canSave = computed(() => true);

function closeModal() {
  emit("update:open", false);
  ui.saved = false;
  ui.error = null;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function setSavedPulse() {
  ui.saved = true;
  window.setTimeout(() => (ui.saved = false), 900);
}

async function ensureStoreLoaded() {
  if (ui.loaded) return;

  settingsStore = await Store.load("luczor.settings.json");

  // Luczor Admin API
  const apiBase = await settingsStore.get<string>("luczor_api_base_url");
  if (apiBase) settings.luczor_api_base_url = apiBase;
  const devKey = await settingsStore.get<string>("luczor_device_key");
  if (devKey) settings.luczor_device_key = devKey;
  ui.clientId = (await getApiConfig()).clientId;

  // Chat
  const autoSpeech = await settingsStore.get<boolean>("chat_auto_speech");
  if (typeof autoSpeech === "boolean") settings.chat_auto_speech = autoSpeech;

  const mode = await settingsStore.get<ChatAutoSpeechMode>("chat_auto_speech_mode");
  if (mode === "off" || mode === "assistant_only" || mode === "all")
    settings.chat_auto_speech_mode = mode;
  const historyBudget = await settingsStore.get<number>("client_history_token_budget");
  if (typeof historyBudget === "number" && !Number.isNaN(historyBudget)) settings.client_history_token_budget = clamp(historyBudget, 400, 12000);
  const autoExecuteMutatingTools = await settingsStore.get<unknown>(AUTO_EXECUTE_MUTATING_TOOLS_KEY);
  settings.auto_execute_mutating_tools = autoExecuteMutatingTools === true;
  const voiceMode = await settingsStore.get<VoiceMode>("voice_mode");
  if (voiceMode === "push_to_talk" || voiceMode === "continuous" || voiceMode === "wakeword") settings.voice_mode = voiceMode;
  const wakeWord = await settingsStore.get<string>("voice_wake_word");
  if (wakeWord) settings.voice_wake_word = wakeWord;
  const sttLanguage = await settingsStore.get<string>("voice_local_stt_language");
  if (sttLanguage) settings.voice_local_stt_language = sttLanguage;

  // Personalization
  const accent = await settingsStore.get<string>("ui_accent");
  if (accent) settings.ui_accent = accent;
  settings.ui_hud_visible = true;
  const hudPos = await settingsStore.get<HudPosition>("ui_hud_position");
  if (hudPos === "br" || hudPos === "bl" || hudPos === "tr" || hudPos === "tl") settings.ui_hud_position = hudPos;
  const rm = await settingsStore.get<boolean>("ui_reduce_motion");
  if (typeof rm === "boolean") settings.ui_reduce_motion = rm;
  const grid = await settingsStore.get<boolean>("ui_show_grid");
  if (typeof grid === "boolean") settings.ui_show_grid = grid;
  const uiScale = await settingsStore.get<number>("ui_scale");
  if (typeof uiScale === "number" && !Number.isNaN(uiScale)) settings.ui_scale = clamp(uiScale, 0.8, 1.4);
  const aName = await settingsStore.get<string>("assistant_name");
  if (aName) settings.assistant_name = aName;

  // Sync + Memory
  const sAuto = await settingsStore.get<boolean>("sync_auto");
  if (typeof sAuto === "boolean") settings.sync_auto = sAuto;
  const sThr = await settingsStore.get<number>("sync_auto_threshold");
  if (typeof sThr === "number" && !Number.isNaN(sThr)) settings.sync_auto_threshold = sThr;
  const memSrv = await settingsStore.get<boolean>("memory_use_server");
  if (typeof memSrv === "boolean") settings.memory_use_server = memSrv;
  const mInj = await settingsStore.get<boolean>("memory_inject");
  if (typeof mInj === "boolean") settings.memory_inject = mInj;
  const mCnt = await settingsStore.get<number>("memory_inject_count");
  if (typeof mCnt === "number" && !Number.isNaN(mCnt)) settings.memory_inject_count = mCnt;
  const mRem = await settingsStore.get<boolean>("memory_auto_remember");
  if (typeof mRem === "boolean") settings.memory_auto_remember = mRem;
  settings.use_server_proxy = true;

  // One-way migration: local provider credentials and voice paths must not
  // remain in the desktop settings store.
  for (const key of [
    "openrouter_api_key", "elevenlabs_api_key", "elevenlabs_voice_id",
    "elevenlabs_tts_model", "elevenlabs_tts_output_format", "elevenlabs_tts_speed",
    "elevenlabs_stt_model", "elevenlabs_stt_language_code",
    "voice_stt_backend", "voice_tts_backend",
    "voice_local_stt_binary", "voice_local_stt_model",
    "voice_local_tts_binary", "voice_local_tts_model", "chat_auto_speech_rate",
    "chat_auto_speech_volume",
  ]) await settingsStore.delete(key);
  await settingsStore.save();

  ui.loaded = true;
}

async function saveAll() {
  if (!settingsStore) return;

  ui.error = null;

  // Minimal validation only when API tab is open (skipped when using the server proxy)
  if (false) {
    const or = "server-managed";
    if (!or) {
      ui.error = "Bitte OpenRouter API Key eingeben (oder Server-Proxy nutzen / anderen Tab wählen).";
      return;
    }

  }

  // Luczor Admin API
  await settingsStore.set("luczor_api_base_url", settings.luczor_api_base_url.trim().replace(/\/+$/, ""));
  await settingsStore.set("luczor_device_key", settings.luczor_device_key.trim());

  // Chat
  await settingsStore.set("chat_auto_speech", settings.chat_auto_speech);
  await settingsStore.set("chat_auto_speech_mode", settings.chat_auto_speech_mode);
  await settingsStore.set("client_history_token_budget", clamp(Math.round(settings.client_history_token_budget), 400, 12000));
  await settingsStore.set(AUTO_EXECUTE_MUTATING_TOOLS_KEY, settings.auto_execute_mutating_tools);
  await settingsStore.set("voice_mode", settings.voice_mode);
  await settingsStore.set("voice_wake_word", settings.voice_wake_word.trim().toLowerCase() || "luczor");
  await settingsStore.set("voice_local_stt_language", settings.voice_local_stt_language.trim().toLowerCase() || "de");

  // Personalization
  await settingsStore.set("ui_accent", settings.ui_accent);
  settings.ui_hud_visible = true;
  await settingsStore.set("ui_hud_visible", true);
  await settingsStore.set("ui_hud_position", settings.ui_hud_position);
  await settingsStore.set("ui_reduce_motion", settings.ui_reduce_motion);
  await settingsStore.set("ui_show_grid", settings.ui_show_grid);
  await settingsStore.set("ui_scale", clamp(settings.ui_scale, 0.8, 1.4));
  await settingsStore.set("assistant_name", settings.assistant_name.trim() || "Luczor");

  // Sync + Memory
  await settingsStore.set("sync_auto", settings.sync_auto);
  await settingsStore.set("sync_auto_threshold", clamp(Math.round(settings.sync_auto_threshold), 1, 500));
  await settingsStore.set("memory_use_server", settings.memory_use_server);
  await settingsStore.set("memory_inject", settings.memory_inject);
  await settingsStore.set("memory_inject_count", clamp(Math.round(settings.memory_inject_count), 0, 20));
  await settingsStore.set("memory_auto_remember", settings.memory_auto_remember);
  settings.use_server_proxy = true;
  await settingsStore.set("use_server_proxy", true);

  await settingsStore.save();
  await loadAppearance(); // re-apply theme/HUD/name live
  setSavedPulse();
}

async function resetChatSettings() {
  settings.chat_auto_speech = DEFAULTS.chat_auto_speech;
  settings.chat_auto_speech_mode = DEFAULTS.chat_auto_speech_mode;
  await saveAll();
}

/* ---------------------------
 * Server (Laravel Admin API)
 * --------------------------- */
async function persistServerConfig() {
  if (!settingsStore) return;
  await settingsStore.set("luczor_api_base_url", settings.luczor_api_base_url.trim().replace(/\/+$/, ""));
  await settingsStore.set("luczor_device_key", settings.luczor_device_key.trim());
  await settingsStore.save();
}

async function testServer() {
  ui.serverResult = null;
  ui.serverBusy = true;
  try {
    await persistServerConfig();
    ui.serverResult = await testConnection();
  } catch (e: any) {
    ui.serverResult = { ok: false, message: e?.message ?? String(e) };
  } finally {
    ui.serverBusy = false;
  }
}

async function pullDefaults() {
  ui.serverResult = null;
  ui.serverBusy = true;
  try {
    await persistServerConfig();
    const n = await pullServerDefaults();
    ui.loaded = false;
    await ensureStoreLoaded();
    await loadAppearance();
    ui.serverResult = { ok: true, message: `${n} Server-Einstellungen übernommen.` };
  } catch (e: any) {
    ui.serverResult = { ok: false, message: e?.message ?? String(e) };
  } finally {
    ui.serverBusy = false;
  }
}

async function syncNow() {
  ui.serverResult = null;
  ui.serverBusy = true;
  try {
    await persistServerConfig();
    const r = await pushAllToServer();
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    const detail = Object.entries(r.counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
    ui.serverResult = { ok: true, message: `Synchronisiert: ${total} Einträge (${detail}).` };
  } catch (e: any) {
    ui.serverResult = { ok: false, message: e?.message ?? String(e) };
  } finally {
    ui.serverBusy = false;
  }
}

async function loadNotificationSettings(force = false) {
  if (notificationUi.loaded && !force) return;
  notificationUi.busy = true;
  notificationUi.message = null;
  try {
    notificationUi.permission = (await hasNativeNotificationPermission()) ? "granted" : "missing";
    const preferences = await getPushNotificationPreferences();
    notificationUi.enabled = preferences.enabled;
    Object.assign(notificationUi.categories, preferences.categories);
    notificationUi.loaded = true;
  } catch (error: any) {
    notificationUi.message = {
      ok: false,
      text: error?.message ?? "Benachrichtigungseinstellungen konnten nicht geladen werden.",
    };
  } finally {
    notificationUi.busy = false;
  }
}

async function togglePushNotifications() {
  if (notificationUi.busy) return;
  notificationUi.busy = true;
  notificationUi.message = null;
  const nextEnabled = !notificationUi.enabled;
  try {
    const preferences = await setPushNotificationPreferences({ enabled: nextEnabled });
    notificationUi.enabled = preferences.enabled;
    Object.assign(notificationUi.categories, preferences.categories);
    notificationUi.permission = (await hasNativeNotificationPermission()) ? "granted" : "missing";
    notificationUi.loaded = true;
    notificationUi.message = {
      ok: true,
      text: nextEnabled
        ? "Push-Benachrichtigungen sind auf diesem Gerät aktiv."
        : "Push-Benachrichtigungen sind auf diesem Gerät pausiert.",
    };
  } catch (error: any) {
    notificationUi.permission = (await hasNativeNotificationPermission()) ? "granted" : "missing";
    notificationUi.message = {
      ok: false,
      text: error?.message ?? "Push-Benachrichtigungen konnten nicht geändert werden.",
    };
  } finally {
    notificationUi.busy = false;
  }
}

async function toggleNotificationCategory(category: AppNotificationCategory) {
  if (notificationUi.busy) return;
  notificationUi.busy = true;
  notificationUi.message = null;
  const nextValue = !notificationUi.categories[category];
  try {
    const preferences = await setPushNotificationPreferences({
      categories: { [category]: nextValue },
    });
    Object.assign(notificationUi.categories, preferences.categories);
    notificationUi.enabled = preferences.enabled;
    notificationUi.message = { ok: true, text: "Kategorie aktualisiert." };
  } catch (error: any) {
    notificationUi.message = {
      ok: false,
      text: error?.message ?? "Kategorie konnte nicht geändert werden.",
    };
  } finally {
    notificationUi.busy = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return;
  if (e.key === "Escape") closeModal();
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      document.body.style.overflow = "hidden";
      ui.saved = false;
      ui.error = null;
      ui.tab = props.initialTab;
      await ensureStoreLoaded();
      if (ui.tab === "notifications") await loadNotificationSettings(true);
    } else {
      document.body.style.overflow = "";
      ui.saved = false;
      ui.error = null;
    }
  },
  { immediate: true }
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
});

/* ---------------------------
 * Sidebar items
 * --------------------------- */
const tabs: Array<{
  id: SettingsTab;
  title: string;
  desc: string;
  icon: string;
}> = [
  { id: "server", title: "Server", desc: "Laravel Sync API", icon: "server" },
  { id: "notifications", title: "Benachrichtigungen", desc: "Native Pushs", icon: "bell" },
  { id: "execution", title: "Ausführung", desc: "Freigaben & Sicherheit", icon: "shield" },
  { id: "voice", title: "Voice", desc: "Lokal · Wake-Word", icon: "mic" },
  { id: "chat", title: "Chat", desc: "Auto Speech", icon: "chat" },
  { id: "appearance", title: "Appearance", desc: "UI (später)", icon: "palette" },
  { id: "privacy", title: "Privacy", desc: "Storage (später)", icon: "shield" },
];

function selectTab(id: SettingsTab) {
  ui.tab = id;
  ui.error = null;
  ui.saved = false;
  if (id === "notifications") void loadNotificationSettings();
}

function accentColor(name: string) {
  switch (name) {
    case "emerald": return "#34d399";
    case "violet": return "#a78bfa";
    case "amber": return "#fbbf24";
    case "rose": return "#fb7185";
    default: return "#38bdf8";
  }
}

function iconPath(kind: string) {
  switch (kind) {
    case "key":
      return "M21 2l-2 2m-7.5 7.5L19 4M7 14a4 4 0 1 1 3.9-5M7 18h4l1.5-1.5L14 18h2l1.5-1.5L19 18h2v-2l-5.5-5.5";
    case "chat":
      return "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z";
    case "server":
      return "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 16a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 6.5h.01M8 17.5h.01";
    case "mic":
      return "M9 4a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3";
    case "bell":
      return "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4";
    case "palette":
      return "M12 22a10 10 0 1 0-10-10 3 3 0 0 0 3 3h1a2 2 0 0 1 2 2 3 3 0 0 0 3 3zm5.5-9.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z";
    case "shield":
    default:
      return "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z";
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
            <button type="button" class="lz-x" @click="closeModal" title="Schließen (Esc)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6 6 18" /><path d="M6 6l12 12" />
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
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
              <!-- SERVER -->
              <div v-if="ui.tab === 'server'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Luczor Server (Admin API)</h3>
                  <p>Optionales Sync-/Archiv-Backend. Die App arbeitet auch ohne Server voll offline.</p>
                </div>
                <div class="lz-card">
                  <label class="lz-label">Server URL (optional)</label>
                  <input v-model="settings.luczor_api_base_url" type="text" autocomplete="off" :placeholder="DEFAULT_BASE_URL" class="lz-input" />
                  <p class="lz-hint">Leer = Standard <span class="mono">{{ DEFAULT_BASE_URL }}</span>. Eigene URL nur bei Bedarf. Provider-Keys liegen verschlüsselt auf dem Server.</p>

                  <label class="lz-label">Device Key</label>
                  <input v-model="settings.luczor_device_key" type="text" autocomplete="off" placeholder="Device API Key aus dem Admin-Dashboard" class="lz-input" />
                  <p class="lz-hint">Wird als <span class="mono">Authorization: Bearer …</span> gesendet.</p>

                  <div class="lz-card__meta">Client-ID: <span class="mono">{{ ui.clientId || "—" }}</span></div>

                  <div class="lz-actions">
                    <button type="button" class="lz-btn lz-btn--ghost" :disabled="ui.serverBusy" @click="testServer">
                      {{ ui.serverBusy ? "…" : "Verbindung testen" }}
                    </button>
                    <button type="button" class="lz-btn lz-btn--primary" :disabled="ui.serverBusy" @click="syncNow">
                      {{ ui.serverBusy ? "…" : "Jetzt synchronisieren" }}
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
                  <p class="lz-hint">An = Chat läuft über den Server, der den OpenRouter-Key injiziert. Dann ist lokal kein OpenRouter-Key nötig.</p>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Auto-Sync im Hintergrund</span>
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.sync_auto }" @click="settings.sync_auto = !settings.sync_auto"><span /></button>
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
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.memory_use_server }" @click="settings.memory_use_server = !settings.memory_use_server"><span /></button>
                  </div>
                  <p class="lz-hint">An = Erinnerungen laufen über den Server (Cognee bleibt intern, kein Endpoint/Key im Client). Aus = nur lokaler Memory-Puffer.</p>

                  <div class="lz-row">
                    <span class="lz-rowlabel">Erinnerungen in Prompt einblenden</span>
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.memory_inject }" @click="settings.memory_inject = !settings.memory_inject"><span /></button>
                  </div>
                  <div>
                    <label class="lz-label">Anzahl eingeblendeter Erinnerungen</label>
                    <div class="lz-range">
                      <input v-model.number="settings.memory_inject_count" type="range" min="0" max="15" step="1" />
                      <span class="lz-range__val">{{ settings.memory_inject_count }}</span>
                    </div>
                  </div>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Antworten automatisch merken</span>
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.memory_auto_remember }" @click="settings.memory_auto_remember = !settings.memory_auto_remember"><span /></button>
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
                          notificationUi.permission === "granted"
                            ? "Betriebssystem-Berechtigung erteilt"
                            : "Betriebssystem-Berechtigung noch nicht erteilt"
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
                    ><span /></button>
                  </div>

                  <div class="lz-permission">
                    <span
                      class="lz-permission__badge"
                      :class="notificationUi.permission === 'granted' ? 'is-ok' : 'is-waiting'"
                    >
                      <i />
                      {{ notificationUi.permission === "granted" ? "OS-Zugriff aktiv" : "Freigabe erforderlich" }}
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
                    Wähle, welche Ereignisse als native Hinweise zugestellt werden. Diese Kategorien gelten
                    für alle verbundenen Geräte; der Hauptschalter oben gilt nur für diese Installation.
                  </p>
                  <div class="lz-notification-list">
                    <div
                      v-for="category in APP_NOTIFICATION_CATEGORIES"
                      :key="category"
                      class="lz-notification-row"
                    >
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
                      ><span /></button>
                    </div>
                  </div>
                </div>

                <div class="lz-callout">
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                       stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <path d="M9 12l2 2 4-5" />
                  </svg>
                  <span>Die Zustellung nutzt denselben authentifizierten Reverb-Kanal wie Geräteaufgaben. Es werden keine Browser-Service-Worker oder VAPID-Schlüssel benötigt.</span>
                </div>
              </div>

              <!-- EXECUTION -->
              <div v-else-if="ui.tab === 'execution'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Ausführung & Freigaben</h3>
                  <p>Steuert, ob erlaubte datenverändernde Tools einzeln bestätigt werden müssen.</p>
                </div>
                <div class="lz-card">
                  <div class="lz-card__head">
                    <div>
                      <div class="lz-card__title">Datenverändernde Tools automatisch ausführen</div>
                      <div class="lz-card__meta">Überspringt die Einzelbestätigung nur im Modus „Handeln“.</div>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': settings.auto_execute_mutating_tools }"
                      :aria-pressed="settings.auto_execute_mutating_tools"
                      aria-label="Datenverändernde Tools automatisch ausführen"
                      @click="settings.auto_execute_mutating_tools = !settings.auto_execute_mutating_tools"
                    ><span /></button>
                  </div>
                  <p class="lz-hint">
                    Beobachten bleibt strikt schreibgeschützt. Der Not-Aus sperrt weiterhin alle Tools.
                    Nicht erlaubte oder unbekannte Aktionen werden durch diese Einstellung nicht freigegeben.
                  </p>
                </div>
              </div>

              <!-- VOICE -->
              <div v-else-if="ui.tab === 'voice'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Voice</h3>
                  <p>Lokale Sprache nutzt whisper.cpp für STT und Piper für TTS. Keine Cloud-Audio-Keys und keine versteckten Fallbacks.</p>
                </div>
                <div v-if="!settings.luczor_device_key.trim()" class="lz-voice-warning" role="alert">
                  <div>
                    <div class="lz-card__title">Device-Key für die erste Voice-Installation fehlt</div>
                    <p class="lz-hint">Der signierte lokale Voice-Runtime-Download benötigt einmalig einen Device-Key. Bereits installierte Sprachmodelle bleiben danach lokal nutzbar.</p>
                  </div>
                  <button type="button" class="lz-btn lz-btn--ghost" @click="selectTab('server')">Device-Key hinterlegen</button>
                </div>
                <div v-if="false" class="lz-section__head">
                  <h3>Voice</h3>
                  <div class="lz-card">
                    <div class="lz-card__title">Lokale Sprache fest verdrahtet</div>
                    <p class="lz-hint">STT nutzt whisper.cpp, TTS nutzt Piper. Es gibt keine ElevenLabs-Konfiguration, keinen Voice-API-Key und keine Backend-Auswahl im Client.</p>
                  </div>
                  <p>Dauer-Zuhören mit Wake-Word und optional lokale Sprachmodelle (offline).</p>
                </div>
                <div class="lz-card">
                  <div class="lz-grid2">
                    <div>
                      <label class="lz-label">Eingabe-Modus</label>
                      <select v-model="settings.voice_mode" class="lz-input">
                        <option value="push_to_talk">Push-to-Talk</option>
                        <option value="continuous">Dauer-Zuhören</option>
                        <option value="wakeword">Wake-Word</option>
                      </select>
                    </div>
                    <div>
                      <label class="lz-label">Wake-Word</label>
                      <input v-model="settings.voice_wake_word" type="text" class="lz-input" :disabled="settings.voice_mode !== 'wakeword'" />
                      <p class="lz-hint">Erkennung über das Transkript.</p>
                    </div>
                    <div>
                      <label class="lz-label">STT-Sprache</label>
                      <input v-model="settings.voice_local_stt_language" type="text" class="lz-input" placeholder="de" />
                    </div>
                    <div v-if="false">
                      <label class="lz-label">STT-Backend</label>
                      <select value="local" class="lz-input" disabled>
                        <option value="local">Lokal (whisper.cpp)</option>
                      </select>
                    </div>
                    <div v-if="false">
                      <label class="lz-label">TTS-Backend</label>
                      <select value="local" class="lz-input" disabled>
                        <option value="local">Lokal (Piper)</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div v-if="false" class="lz-card">
                  <div class="lz-card__title">Lokale Modelle (offline)</div>
                  <p class="lz-hint">Pfade zu selbst installierten Binaries/Modellen. Ohne diese ist Sprache deaktiviert, statt auf Cloud auszuweichen.</p>
                  <div class="lz-grid2">
                    <div>
                      <label class="lz-label">whisper.cpp Binary</label>
                      <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">whisper Modell</label>
                      <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">STT Sprache</label>
                      <input v-model="settings.voice_local_stt_language" type="text" class="lz-input" />
                    </div>
                    <div></div>
                    <div>
                      <label class="lz-label">Piper Binary</label>
                      <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">Piper Voice (.onnx)</label>
                      <input value="automatisch verwaltet" type="text" disabled class="lz-input" />
                    </div>
                  </div>
                </div>
              </div>

              <!-- CHAT -->
              <div v-else-if="ui.tab === 'chat'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Chat</h3>
                  <p>Auto Speech liest neue Antworten automatisch vor (Streaming-TTS).</p>
                </div>
                <div class="lz-card">
                  <div class="lz-card__head">
                    <div>
                      <div class="lz-card__title">Auto Speech</div>
                      <div class="lz-card__meta">Antworten automatisch vorlesen.</div>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': settings.chat_auto_speech }"
                      @click="settings.chat_auto_speech = !settings.chat_auto_speech"
                      aria-label="Toggle Auto Speech"
                    ><span /></button>
                  </div>

                  <div class="lz-grid2">
                    <div>
                      <label class="lz-label">Modus</label>
                      <select v-model="settings.chat_auto_speech_mode" class="lz-input">
                        <option value="assistant_only">Nur Assistant</option>
                        <option value="all">User + Assistant</option>
                        <option value="off">Aus</option>
                      </select>
                    </div>
                    <div>
                      <label class="lz-label">Rate</label>
                      <div class="lz-range">
                        <input value="1" type="range" min="1" max="1" disabled />
                        <span class="lz-range__val">automatisch</span>
                      </div>
                    </div>
                    <div>
                      <label class="lz-label">Volume</label>
                      <div class="lz-range">
                        <input value="100" type="range" min="100" max="100" disabled />
                        <span class="lz-range__val">Systemlautstärke</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label class="lz-label">Lokales Chat-Historienbudget</label>
                    <div class="lz-range">
                      <input v-model.number="settings.client_history_token_budget" type="range" min="400" max="12000" step="200" />
                      <span class="lz-range__val">{{ settings.client_history_token_budget }} Tokens</span>
                    </div>
                    <p class="lz-hint">Begrenzt den Verlauf vor jeder Anfrage. Niedriger spart Kosten und Kontext, höher bewahrt mehr Gesprächsdetails.</p>
                  </div>

                  <div class="lz-actions">
                    <button type="button" class="lz-btn lz-btn--ghost" @click="resetChatSettings">Chat-Settings zurücksetzen</button>
                  </div>
                </div>
              </div>

              <!-- APPEARANCE / PERSONALIZATION -->
              <div v-else-if="ui.tab === 'appearance'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Personalisierung</h3>
                  <p>Name, Akzentfarbe, HUD und Darstellung. Wird beim Speichern übernommen.</p>
                </div>
                <div class="lz-card">
                  <label class="lz-label">Assistenten-Name</label>
                  <input v-model="settings.assistant_name" class="lz-input" placeholder="Luczor" />

                  <label class="lz-label" style="margin-top:6px">Akzentfarbe</label>
                  <div class="lz-swatches">
                    <button
                      v-for="a in ACCENT_NAMES" :key="a" type="button"
                      class="lz-swatch" :class="{ 'is-active': settings.ui_accent === a }"
                      :style="{ background: accentColor(a) }" :title="a"
                      @click="settings.ui_accent = a"
                    />
                  </div>

                  <div class="lz-grid2">
                    <div>
                      <label class="lz-label">HUD-Position</label>
                      <select v-model="settings.ui_hud_position" class="lz-input">
                        <option value="br">Unten rechts</option>
                        <option value="bl">Unten links</option>
                        <option value="tr">Oben rechts</option>
                        <option value="tl">Oben links</option>
                      </select>
                    </div>
                    <div>
                      <label class="lz-label">UI-Skalierung</label>
                      <div class="lz-range">
                        <input v-model.number="settings.ui_scale" type="range" min="0.8" max="1.4" step="0.05" />
                        <span class="lz-range__val">{{ Math.round(settings.ui_scale * 100) }}%</span>
                      </div>
                    </div>
                  </div>

                  <div v-if="false" class="lz-row">
                    <span class="lz-rowlabel">HUD anzeigen</span>
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.ui_hud_visible }" @click="settings.ui_hud_visible = !settings.ui_hud_visible"><span /></button>
                  </div>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Hintergrund-Grid</span>
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.ui_show_grid }" @click="settings.ui_show_grid = !settings.ui_show_grid"><span /></button>
                  </div>
                  <div class="lz-row">
                    <span class="lz-rowlabel">Animationen reduzieren</span>
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.ui_reduce_motion }" @click="settings.ui_reduce_motion = !settings.ui_reduce_motion"><span /></button>
                  </div>
                </div>
              </div>

              <!-- PRIVACY -->
              <div v-else class="lz-section">
                <div class="lz-section__head">
                  <h3>Privacy</h3>
                  <p>Speicher-/Retention-Settings.</p>
                </div>
                <div class="lz-card"><div class="lz-card__meta">History lokal speichern · Auto-Cleanup · Export/Import.</div></div>
              </div>
            </div>

            <!-- Footer -->
            <div class="lz-foot">
              <button type="button" class="lz-btn lz-btn--ghost" @click="closeModal">Schließen</button>
              <button type="button" class="lz-btn lz-btn--primary" :disabled="!canSave" @click="saveAll">Speichern</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.lz-root { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: var(--s4); }
.lz-backdrop {
  position: absolute; inset: 0; border: none; cursor: pointer;
  background: rgba(2, 6, 12, 0.62); backdrop-filter: blur(4px);
}

.lz-modal {
  position: relative;
  width: 100%; max-width: 900px; max-height: 88vh;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface-glass);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-panel), var(--glow-sm);
  backdrop-filter: blur(var(--blur)) saturate(130%);
  animation: lz-in var(--dur) var(--ease) both;
  color: var(--text-primary);
  font-family: var(--font-ui);
}
@keyframes lz-in { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }

.lz-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--s4) var(--s5);
  border-bottom: 1px solid var(--border-hair);
  background: linear-gradient(180deg, var(--glass-wash), transparent);
}
.lz-head__brand { display: flex; align-items: center; gap: var(--s3); }
.lz-dot {
  width: 14px; height: 14px; border-radius: 50%;
  background: radial-gradient(circle at 45% 40%, var(--cy-soft), var(--cy) 55%, transparent 72%);
  box-shadow: var(--glow-md);
}
.lz-title { font-family: var(--font-mono); font-size: var(--fs-title); letter-spacing: 0.14em; text-transform: uppercase; text-shadow: var(--glow-text); }
.lz-sub { font-family: var(--font-mono); font-size: var(--fs-label); letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-muted); }
.lz-head__actions { display: flex; align-items: center; gap: var(--s2); }
.lz-saved {
  font-family: var(--font-mono); font-size: var(--fs-label); letter-spacing: 0.08em;
  color: var(--success-soft); background: var(--success-wash);
  border: 1px solid rgba(52,211,153,0.4); border-radius: var(--r-pill);
  padding: 3px 10px;
}
.lz-x {
  display: inline-grid; place-items: center; width: 34px; height: 34px;
  color: var(--text-secondary); background: var(--cy-08);
  border: 1px solid var(--border-soft); border-radius: var(--r-sm); cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.lz-x:hover { color: var(--danger-soft); background: var(--danger-wash); border-color: rgba(244,63,94,0.5); box-shadow: var(--glow-danger); }

.lz-body { display: grid; grid-template-columns: 220px 1fr; min-height: 0; flex: 1; }

.lz-nav {
  display: flex; flex-direction: column; gap: 4px;
  padding: var(--s4) var(--s3);
  border-right: 1px solid var(--border-hair);
  overflow-y: auto;
}
.lz-nav__label { margin: 0 6px var(--s2); }
.lz-tab {
  position: relative; display: flex; align-items: center; gap: 10px;
  padding: 9px 11px; border-radius: var(--r-md);
  border: 1px solid transparent; background: transparent; cursor: pointer; text-align: left;
  transition: background var(--dur) var(--ease), border-color var(--dur), transform var(--dur-fast);
}
.lz-tab:hover { background: var(--surface-2); border-color: var(--border-soft); transform: translateX(2px); }
.lz-tab__icon {
  display: inline-grid; place-items: center; width: 30px; height: 30px; flex: none;
  color: var(--text-secondary); background: var(--cy-08);
  border: 1px solid var(--border-soft); border-radius: var(--r-sm);
}
.lz-tab__title { display: block; font-size: 13.5px; font-weight: 600; color: var(--text-secondary); }
.lz-tab__desc { display: block; font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lz-tab.is-active { background: linear-gradient(90deg, var(--cy-16), var(--cy-04) 65%); border-color: var(--border); box-shadow: var(--glow-sm); }
.lz-tab.is-active .lz-tab__icon { color: var(--cy-bright); background: var(--cy-16); border-color: var(--border-strong); }
.lz-tab.is-active .lz-tab__title { color: var(--cy-soft); text-shadow: var(--glow-text); }
.min-w-0 { min-width: 0; }

.lz-main { display: flex; flex-direction: column; min-width: 0; }
.lz-scroll { flex: 1; overflow-y: auto; padding: var(--s5); }
.lz-section { display: flex; flex-direction: column; gap: var(--s4); }
.lz-section__head h3 { margin: 0; font-size: var(--fs-title); font-weight: 700; color: var(--text-primary); }
.lz-optbadge {
  margin-left: 8px; padding: 2px 8px; vertical-align: middle;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-muted); background: rgba(150,180,196,0.1);
  border: 1px solid var(--border-hair); border-radius: var(--r-pill);
}
.lz-section__head p { margin: 4px 0 0; font-size: var(--fs-sm); color: var(--text-muted); }

.lz-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: var(--s4);
  background: var(--surface-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
}
.lz-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s3); }
.lz-card__title { font-size: var(--fs-sm); font-weight: 700; color: var(--text-primary); }
.lz-card__meta { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-muted); }

.lz-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }
.lz-label { display: block; font-size: 12.5px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; }
.lz-hint { font-size: 11.5px; color: var(--text-muted); margin: 2px 0 0; }
.mono { font-family: var(--font-mono); color: var(--cy-soft); }

.lz-input {
  width: 100%; padding: 10px 12px;
  font-family: var(--font-ui); font-size: var(--fs-sm); color: var(--text-primary);
  background: var(--bg-sunken);
  border: 1px solid var(--border-soft); border-radius: var(--r-md); outline: none;
  transition: border-color var(--dur), box-shadow var(--dur);
}
.lz-input::placeholder { color: var(--text-faint); }
.lz-input:focus { border-color: var(--border-strong); box-shadow: var(--focus-ring); }
select.lz-input { cursor: pointer; }
select.lz-input option { background: var(--bg-raised); color: var(--text-primary); }

.lz-range { display: flex; align-items: center; gap: 10px; }
.lz-range input[type="range"] { flex: 1; accent-color: var(--cy); }
.lz-range__val { width: 44px; text-align: right; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--cy-soft); }

.lz-actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: 2px; }
.lz-btn {
  height: 36px; padding: 0 16px;
  font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; letter-spacing: 0.03em;
  border-radius: var(--r-sm); cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.lz-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.lz-btn--ghost { color: var(--text-secondary); background: var(--cy-08); border: 1px solid var(--border-soft); }
.lz-btn--ghost:hover:not(:disabled) { color: var(--text-primary); background: var(--cy-12); border-color: var(--border-strong); box-shadow: var(--glow-xs); }
.lz-btn--primary { color: var(--text-on-accent); background: linear-gradient(160deg, var(--cy-soft), var(--cy) 60%, var(--cy-deep)); border: 1px solid rgba(103,232,249,0.5); box-shadow: var(--glow-sm); }
.lz-btn--primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--glow-md); }

.lz-result { font-size: var(--fs-sm); margin: 2px 0 0; }
.lz-result.is-ok { color: var(--success-soft); }
.lz-result.is-fail { color: var(--danger-soft); }
.lz-error { font-size: var(--fs-sm); color: var(--danger-soft); margin: 0; }
.lz-voice-warning {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s3);
  padding: var(--s3) var(--s4); color: var(--text-secondary); background: var(--danger-wash);
  border: 1px solid rgba(244, 63, 94, 0.42); border-radius: var(--r-lg);
}
.lz-voice-warning .lz-hint { max-width: 600px; }

.lz-switch {
  position: relative; width: 46px; height: 26px; flex: none;
  border-radius: var(--r-pill); cursor: pointer;
  background: rgba(120,150,168,0.18); border: 1px solid var(--border-soft);
  transition: background var(--dur), border-color var(--dur), box-shadow var(--dur);
}
.lz-switch span { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: var(--text-secondary); transition: transform var(--dur) var(--ease), background var(--dur); }
.lz-switch.is-on { background: var(--success-wash); border-color: rgba(52,211,153,0.5); box-shadow: var(--glow-success); }
.lz-switch.is-on span { transform: translateX(20px); background: var(--success); }

.lz-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
.lz-rowlabel { font-size: 13px; color: var(--text-secondary); }

.lz-swatches { display: flex; gap: 10px; flex-wrap: wrap; }
.lz-swatch {
  width: 30px; height: 30px; border-radius: 50%; cursor: pointer;
  border: 2px solid transparent; box-shadow: 0 0 0 1px var(--border-soft);
  transition: transform var(--dur-fast) var(--ease), box-shadow var(--dur);
}
.lz-swatch:hover { transform: scale(1.1); }
.lz-swatch.is-active { border-color: #eaf7ff; box-shadow: 0 0 0 2px var(--border-strong), 0 0 12px currentColor; }

.lz-foot {
  display: flex; justify-content: flex-end; gap: var(--s2);
  padding: var(--s3) var(--s5);
  border-top: 1px solid var(--border-hair);
  background: linear-gradient(0deg, var(--glass-wash), transparent);
}

.lz-fade-enter-active, .lz-fade-leave-active { transition: opacity var(--dur); }
.lz-fade-enter-from, .lz-fade-leave-to { opacity: 0; }

@media (max-width: 760px) {
  .lz-body { grid-template-columns: 1fr; }
  .lz-nav { flex-direction: row; overflow-x: auto; border-right: none; border-bottom: 1px solid var(--border-hair); }
  .lz-grid2 { grid-template-columns: 1fr; }
}

/* Vengeance settings workspace */
.lz-root {
  padding: 12px;
}

.lz-backdrop {
  background:
    radial-gradient(circle at 68% 12%, var(--cy-08), transparent 38%),
    rgba(5, 5, 9, 0.78);
  backdrop-filter: blur(18px) saturate(115%);
}

.lz-modal {
  max-width: 1040px;
  max-height: calc(100vh - 24px);
  background:
    radial-gradient(70% 52% at 74% 0%, var(--cy-04), transparent 70%),
    rgba(13, 14, 21, 0.96);
  border-color: rgba(255, 255, 255, 0.085);
  border-radius: 28px;
  box-shadow:
    0 44px 140px rgba(0, 0, 0, 0.62),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(28px) saturate(120%);
}

.lz-head {
  min-height: 76px;
  padding: 13px 18px;
  background: rgba(255, 255, 255, 0.012);
  border-bottom-color: rgba(255, 255, 255, 0.06);
}

.lz-dot {
  display: grid;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 13px;
  background:
    radial-gradient(circle at 30% 22%, rgba(255, 255, 255, 0.28), transparent 28%),
    linear-gradient(145deg, var(--cy-bright), var(--cy-deep));
  box-shadow: var(--glow-sm);
}

.lz-title {
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 680;
  letter-spacing: -0.02em;
  text-transform: none;
  text-shadow: none;
}

.lz-sub {
  color: var(--text-faint);
  font-size: 9px;
  letter-spacing: 0.11em;
}

.lz-x {
  width: 38px;
  height: 38px;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.035);
  border-color: rgba(255, 255, 255, 0.06);
  border-radius: 12px;
}

.lz-x:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.065);
  border-color: rgba(255, 255, 255, 0.09);
  box-shadow: none;
}

.lz-body {
  grid-template-columns: 234px minmax(0, 1fr);
}

.lz-nav {
  gap: 4px;
  padding: 18px 12px;
  background: rgba(7, 8, 12, 0.38);
  border-right-color: rgba(255, 255, 255, 0.055);
}

.lz-nav__label {
  padding: 0 9px 8px;
  color: var(--text-faint);
}

.lz-tab {
  min-height: 54px;
  padding: 8px 9px;
  color: var(--text-muted);
  background: transparent;
  border-color: transparent;
  border-radius: 14px;
}

.lz-tab:hover {
  background: rgba(255, 255, 255, 0.035);
  border-color: rgba(255, 255, 255, 0.055);
  transform: none;
}

.lz-tab__icon {
  width: 32px;
  height: 32px;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(255, 255, 255, 0.055);
  border-radius: 10px;
}

.lz-tab__title {
  color: var(--text-secondary);
  font-size: 12.5px;
}

.lz-tab__desc {
  color: var(--text-faint);
  font-size: 9.5px;
}

.lz-tab.is-active {
  background: linear-gradient(90deg, var(--cy-12), rgba(255, 255, 255, 0.025));
  border-color: var(--border-soft);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
}

.lz-tab.is-active .lz-tab__icon {
  color: var(--cy-soft);
  background: var(--cy-12);
  border-color: var(--border);
}

.lz-tab.is-active .lz-tab__title {
  color: var(--text-primary);
  text-shadow: none;
}

.lz-scroll {
  min-height: 0;
  padding: clamp(18px, 3vw, 30px);
}

.lz-main {
  min-height: 0;
  overflow: hidden;
}

.lz-section {
  gap: 14px;
  max-width: 760px;
}

.lz-section__head {
  margin-bottom: 6px;
}

.lz-section__head h3 {
  color: #f7f5ff;
  font-family: var(--font-display);
  font-size: clamp(21px, 2.8vw, 30px);
  font-weight: 650;
  letter-spacing: -0.045em;
}

.lz-section__head p {
  max-width: 620px;
  margin-top: 6px;
  color: var(--text-muted);
  line-height: 1.65;
}

.lz-card {
  gap: 13px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.026);
  border-color: rgba(255, 255, 255, 0.065);
  border-radius: 18px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
}

.lz-card__title {
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.015em;
}

.lz-card__meta {
  color: var(--text-faint);
  font-size: 9.5px;
}

.lz-input {
  margin: 0;
  padding: 11px 12px;
  background: rgba(5, 6, 10, 0.62);
  border-color: rgba(255, 255, 255, 0.075);
  border-radius: 12px;
}

.lz-btn {
  height: 38px;
  border-radius: 12px;
  font-family: var(--font-ui);
  font-size: 12px;
  letter-spacing: 0;
}

.lz-btn--ghost {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.035);
  border-color: rgba(255, 255, 255, 0.07);
}

.lz-btn--primary {
  color: #fff;
  background: linear-gradient(145deg, var(--cy-bright), var(--cy-deep));
  border-color: rgba(255, 255, 255, 0.11);
  box-shadow: var(--glow-xs);
}

.lz-switch {
  width: 44px;
  height: 25px;
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.08);
}

.lz-switch span {
  width: 19px;
  height: 19px;
  background: #aaa7b4;
}

.lz-switch.is-on {
  background: var(--cy-16);
  border-color: var(--border);
  box-shadow: none;
}

.lz-switch.is-on span {
  transform: translateX(19px);
  background: var(--cy-soft);
  box-shadow: var(--glow-xs);
}

.lz-switch:disabled {
  cursor: default;
  opacity: 0.5;
}

.lz-notification-hero {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(circle at 96% 0%, var(--cy-16), transparent 38%),
    rgba(255, 255, 255, 0.027);
}

.lz-notification-hero::before {
  content: "";
  position: absolute;
  top: -42px;
  right: -42px;
  width: 122px;
  height: 122px;
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  box-shadow: inset 0 0 40px var(--cy-08);
  pointer-events: none;
}

.lz-permission {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  color: var(--text-muted);
  font-size: 11px;
}

.lz-permission__badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  color: var(--warn-soft);
  background: var(--warn-wash);
  border: 1px solid rgba(243, 183, 96, 0.24);
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 9px;
}

.lz-permission__badge i {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--warn);
}

.lz-permission__badge.is-ok {
  color: var(--success-soft);
  background: var(--success-wash);
  border-color: rgba(69, 214, 160, 0.24);
}

.lz-permission__badge.is-ok i {
  background: var(--success);
  box-shadow: var(--glow-success);
}

.lz-notification-list {
  display: grid;
  gap: 0;
}

.lz-notification-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 57px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.lz-notification-row:first-child {
  border-top: 0;
}

.lz-notification-row > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lz-callout {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 13px 15px;
  color: var(--text-muted);
  background: var(--cy-04);
  border: 1px solid var(--border-soft);
  border-radius: 15px;
  font-size: 11px;
  line-height: 1.6;
}

.lz-callout svg {
  flex: none;
  margin-top: 1px;
  color: var(--cy-soft);
}

.lz-result {
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid rgba(255, 255, 255, 0.055);
  border-radius: 10px;
  font-size: 11px;
}

.lz-foot {
  padding: 12px 18px;
  background: rgba(7, 8, 12, 0.52);
  border-top-color: rgba(255, 255, 255, 0.055);
}

.lz-tab:focus-visible,
.lz-switch:focus-visible,
.lz-btn:focus-visible,
.lz-x:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

@media (max-width: 760px) {
  .lz-modal {
    border-radius: 22px;
  }

  .lz-body {
    grid-template-columns: 1fr;
  }

  .lz-nav {
    flex-direction: row;
    padding: 8px 10px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.055);
  }

  .lz-nav__label,
  .lz-tab__desc {
    display: none;
  }

  .lz-tab {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 5px 8px;
  }

  .lz-tab__icon {
    width: 28px;
    height: 28px;
  }
}
</style>
