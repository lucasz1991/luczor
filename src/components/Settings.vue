<!-- src/components/Settings.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, watch } from "vue";
import { Store } from "@tauri-apps/plugin-store";
import { testConnection, pushAllToServer, pullServerDefaults } from "@/services/api/sync";
import { getApiConfig, DEFAULT_BASE_URL } from "@/services/api/luczorApi";
import { loadAppearance, ACCENT_NAMES, type HudPosition } from "@/services/appearance";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

/* ---------------------------
 * Store / State
 * --------------------------- */
type SettingsTab = "api" | "server" | "voice" | "chat" | "appearance" | "privacy";
type ChatAutoSpeechMode = "off" | "assistant_only" | "all";
type VoiceMode = "push_to_talk" | "continuous" | "wakeword";
type VoiceBackend = "cloud" | "local";

type AppSettings = {
  openrouter_api_key: string;

  // Luczor Admin API (Laravel sync backend)
  luczor_api_base_url: string;
  luczor_device_key: string;

  // Voice (continuous listening + local models)
  voice_mode: VoiceMode;
  voice_wake_word: string;
  voice_stt_backend: VoiceBackend;
  voice_tts_backend: VoiceBackend;
  voice_local_stt_binary: string;
  voice_local_stt_model: string;
  voice_local_stt_language: string;
  voice_local_tts_binary: string;
  voice_local_tts_model: string;

  // ElevenLabs
  elevenlabs_api_key: string;
  elevenlabs_voice_id: string; // required for TTS
  elevenlabs_tts_model: string; // e.g. "eleven_multilingual_v2"
  elevenlabs_tts_output_format: string; // e.g. "mp3_44100_128"
  elevenlabs_tts_speed: number; // e.g. 0.7 .. 1.3
  elevenlabs_stt_model: string; // e.g. "scribe_v2"
  elevenlabs_stt_language_code: string; // e.g. "deu"

  // Chat
  chat_auto_speech: boolean;
  chat_auto_speech_mode: ChatAutoSpeechMode;
  chat_auto_speech_rate: number; // 0.5 .. 2.0 (legacy slider, can map to eleven speed later)
  chat_auto_speech_volume: number; // 0 .. 100

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
  cognee_base_url: string;
  memory_inject: boolean;
  memory_inject_count: number;
  memory_auto_remember: boolean;
  use_server_proxy: boolean;
};

const DEFAULTS: AppSettings = {
  openrouter_api_key: "",

  luczor_api_base_url: DEFAULT_BASE_URL,
  luczor_device_key: "",

  voice_mode: "push_to_talk",
  voice_wake_word: "luczor",
  voice_stt_backend: "cloud",
  voice_tts_backend: "cloud",
  voice_local_stt_binary: "",
  voice_local_stt_model: "",
  voice_local_stt_language: "de",
  voice_local_tts_binary: "",
  voice_local_tts_model: "",

  elevenlabs_api_key: "",
  elevenlabs_voice_id: "",
  elevenlabs_tts_model: "eleven_multilingual_v2",
  elevenlabs_tts_output_format: "mp3_44100_128",
  elevenlabs_tts_speed: 1.05,
  elevenlabs_stt_model: "scribe_v2",
  elevenlabs_stt_language_code: "deu",

  chat_auto_speech: false,
  chat_auto_speech_mode: "assistant_only",
  chat_auto_speech_rate: 1.0,
  chat_auto_speech_volume: 90,

  ui_accent: "cyan",
  ui_hud_visible: true,
  ui_hud_position: "br",
  ui_reduce_motion: false,
  ui_show_grid: true,
  ui_scale: 1.0,
  assistant_name: "Luczor",

  sync_auto: false,
  sync_auto_threshold: 20,
  cognee_base_url: "",
  memory_inject: true,
  memory_inject_count: 5,
  memory_auto_remember: true,
  use_server_proxy: true,
};

const ui = reactive({
  tab: "api" as SettingsTab,
  saved: false,
  error: null as string | null,
  loaded: false,

  // Server tab
  clientId: "",
  serverBusy: false,
  serverResult: null as { ok: boolean; message: string } | null,
});

const settings = reactive<AppSettings>({ ...DEFAULTS });

let settingsStore: Store | null = null;

const maskedOrKey = computed(() => maskKey(settings.openrouter_api_key));
const maskedXiKey = computed(() => maskKey(settings.elevenlabs_api_key));

function maskKey(v: string) {
  const t = v.trim();
  if (!t) return "";
  if (t.length <= 10) return "•".repeat(t.length);
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

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

  // OpenRouter
  const orKey = await settingsStore.get<string>("openrouter_api_key");
  if (orKey) settings.openrouter_api_key = orKey;

  // Luczor Admin API
  const apiBase = await settingsStore.get<string>("luczor_api_base_url");
  if (apiBase) settings.luczor_api_base_url = apiBase;
  const devKey = await settingsStore.get<string>("luczor_device_key");
  if (devKey) settings.luczor_device_key = devKey;
  ui.clientId = (await getApiConfig()).clientId;

  // Voice
  const vMode = await settingsStore.get<VoiceMode>("voice_mode");
  if (vMode === "push_to_talk" || vMode === "continuous" || vMode === "wakeword")
    settings.voice_mode = vMode;
  const wake = await settingsStore.get<string>("voice_wake_word");
  if (wake) settings.voice_wake_word = wake;
  const sBack = await settingsStore.get<VoiceBackend>("voice_stt_backend");
  if (sBack === "cloud" || sBack === "local") settings.voice_stt_backend = sBack;
  const tBack = await settingsStore.get<VoiceBackend>("voice_tts_backend");
  if (tBack === "cloud" || tBack === "local") settings.voice_tts_backend = tBack;
  const sBin = await settingsStore.get<string>("voice_local_stt_binary");
  if (sBin) settings.voice_local_stt_binary = sBin;
  const sMod = await settingsStore.get<string>("voice_local_stt_model");
  if (sMod) settings.voice_local_stt_model = sMod;
  const sLang = await settingsStore.get<string>("voice_local_stt_language");
  if (sLang) settings.voice_local_stt_language = sLang;
  const tBin = await settingsStore.get<string>("voice_local_tts_binary");
  if (tBin) settings.voice_local_tts_binary = tBin;
  const tMod = await settingsStore.get<string>("voice_local_tts_model");
  if (tMod) settings.voice_local_tts_model = tMod;

  // ElevenLabs
  const xiKey = await settingsStore.get<string>("elevenlabs_api_key");
  if (xiKey) settings.elevenlabs_api_key = xiKey;

  const voiceId = await settingsStore.get<string>("elevenlabs_voice_id");
  if (voiceId) settings.elevenlabs_voice_id = voiceId;

  const ttsModel = await settingsStore.get<string>("elevenlabs_tts_model");
  if (ttsModel) settings.elevenlabs_tts_model = ttsModel;

  const outFmt = await settingsStore.get<string>("elevenlabs_tts_output_format");
  if (outFmt) settings.elevenlabs_tts_output_format = outFmt;

  const speed = await settingsStore.get<number>("elevenlabs_tts_speed");
  if (typeof speed === "number" && !Number.isNaN(speed))
    settings.elevenlabs_tts_speed = clamp(speed, 0.7, 1.3);

  const sttModel = await settingsStore.get<string>("elevenlabs_stt_model");
  if (sttModel) settings.elevenlabs_stt_model = sttModel;

  const lang = await settingsStore.get<string>("elevenlabs_stt_language_code");
  if (lang) settings.elevenlabs_stt_language_code = lang;

  // Chat
  const autoSpeech = await settingsStore.get<boolean>("chat_auto_speech");
  if (typeof autoSpeech === "boolean") settings.chat_auto_speech = autoSpeech;

  const mode = await settingsStore.get<ChatAutoSpeechMode>("chat_auto_speech_mode");
  if (mode === "off" || mode === "assistant_only" || mode === "all")
    settings.chat_auto_speech_mode = mode;

  const rate = await settingsStore.get<number>("chat_auto_speech_rate");
  if (typeof rate === "number" && !Number.isNaN(rate))
    settings.chat_auto_speech_rate = clamp(rate, 0.5, 2.0);

  const volume = await settingsStore.get<number>("chat_auto_speech_volume");
  if (typeof volume === "number" && !Number.isNaN(volume))
    settings.chat_auto_speech_volume = clamp(volume, 0, 100);

  // Personalization
  const accent = await settingsStore.get<string>("ui_accent");
  if (accent) settings.ui_accent = accent;
  const hudVis = await settingsStore.get<boolean>("ui_hud_visible");
  if (typeof hudVis === "boolean") settings.ui_hud_visible = hudVis;
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
  const cog = await settingsStore.get<string>("cognee_base_url");
  if (cog) settings.cognee_base_url = cog;
  const mInj = await settingsStore.get<boolean>("memory_inject");
  if (typeof mInj === "boolean") settings.memory_inject = mInj;
  const mCnt = await settingsStore.get<number>("memory_inject_count");
  if (typeof mCnt === "number" && !Number.isNaN(mCnt)) settings.memory_inject_count = mCnt;
  const mRem = await settingsStore.get<boolean>("memory_auto_remember");
  if (typeof mRem === "boolean") settings.memory_auto_remember = mRem;
  const proxy = await settingsStore.get<boolean>("use_server_proxy");
  if (typeof proxy === "boolean") settings.use_server_proxy = proxy;

  ui.loaded = true;
}

async function saveAll() {
  if (!settingsStore) return;

  ui.error = null;

  // Minimal validation only when API tab is open (skipped when using the server proxy)
  if (ui.tab === "api" && !settings.use_server_proxy) {
    const or = settings.openrouter_api_key.trim();
    if (!or) {
      ui.error = "Bitte OpenRouter API Key eingeben (oder Server-Proxy nutzen / anderen Tab wählen).";
      return;
    }

    // ElevenLabs is optional; validate only if any xi field is filled
    const xiAny =
      settings.elevenlabs_api_key.trim() ||
      settings.elevenlabs_voice_id.trim() ||
      settings.elevenlabs_tts_model.trim() ||
      settings.elevenlabs_stt_model.trim();

    if (xiAny && !settings.elevenlabs_api_key.trim()) {
      ui.error = "ElevenLabs: Bitte API Key setzen (oder alle ElevenLabs Felder leeren).";
      return;
    }
  }

  await settingsStore.set("openrouter_api_key", settings.openrouter_api_key.trim());

  // Luczor Admin API
  await settingsStore.set("luczor_api_base_url", settings.luczor_api_base_url.trim().replace(/\/+$/, ""));
  await settingsStore.set("luczor_device_key", settings.luczor_device_key.trim());

  // Voice
  await settingsStore.set("voice_mode", settings.voice_mode);
  await settingsStore.set("voice_wake_word", settings.voice_wake_word.trim() || "luczor");
  await settingsStore.set("voice_stt_backend", settings.voice_stt_backend);
  await settingsStore.set("voice_tts_backend", settings.voice_tts_backend);
  await settingsStore.set("voice_local_stt_binary", settings.voice_local_stt_binary.trim());
  await settingsStore.set("voice_local_stt_model", settings.voice_local_stt_model.trim());
  await settingsStore.set("voice_local_stt_language", settings.voice_local_stt_language.trim() || "de");
  await settingsStore.set("voice_local_tts_binary", settings.voice_local_tts_binary.trim());
  await settingsStore.set("voice_local_tts_model", settings.voice_local_tts_model.trim());

  // ElevenLabs
  await settingsStore.set("elevenlabs_api_key", settings.elevenlabs_api_key.trim());
  await settingsStore.set("elevenlabs_voice_id", settings.elevenlabs_voice_id.trim());
  await settingsStore.set("elevenlabs_tts_model", settings.elevenlabs_tts_model.trim());
  await settingsStore.set("elevenlabs_tts_output_format", settings.elevenlabs_tts_output_format.trim());
  await settingsStore.set("elevenlabs_tts_speed", clamp(settings.elevenlabs_tts_speed, 0.7, 1.3));
  await settingsStore.set("elevenlabs_stt_model", settings.elevenlabs_stt_model.trim());
  await settingsStore.set("elevenlabs_stt_language_code", settings.elevenlabs_stt_language_code.trim());

  // Chat
  await settingsStore.set("chat_auto_speech", settings.chat_auto_speech);
  await settingsStore.set("chat_auto_speech_mode", settings.chat_auto_speech_mode);
  await settingsStore.set("chat_auto_speech_rate", clamp(settings.chat_auto_speech_rate, 0.5, 2.0));
  await settingsStore.set("chat_auto_speech_volume", clamp(settings.chat_auto_speech_volume, 0, 100));

  // Personalization
  await settingsStore.set("ui_accent", settings.ui_accent);
  await settingsStore.set("ui_hud_visible", settings.ui_hud_visible);
  await settingsStore.set("ui_hud_position", settings.ui_hud_position);
  await settingsStore.set("ui_reduce_motion", settings.ui_reduce_motion);
  await settingsStore.set("ui_show_grid", settings.ui_show_grid);
  await settingsStore.set("ui_scale", clamp(settings.ui_scale, 0.8, 1.4));
  await settingsStore.set("assistant_name", settings.assistant_name.trim() || "Luczor");

  // Sync + Memory
  await settingsStore.set("sync_auto", settings.sync_auto);
  await settingsStore.set("sync_auto_threshold", clamp(Math.round(settings.sync_auto_threshold), 1, 500));
  await settingsStore.set("cognee_base_url", settings.cognee_base_url.trim().replace(/\/+$/, ""));
  await settingsStore.set("memory_inject", settings.memory_inject);
  await settingsStore.set("memory_inject_count", clamp(Math.round(settings.memory_inject_count), 0, 20));
  await settingsStore.set("memory_auto_remember", settings.memory_auto_remember);
  await settingsStore.set("use_server_proxy", settings.use_server_proxy);

  await settingsStore.save();
  await loadAppearance(); // re-apply theme/HUD/name live
  setSavedPulse();
}

async function clearApiKey(which: "openrouter" | "elevenlabs") {
  if (!settingsStore) return;

  ui.error = null;

  if (which === "openrouter") {
    await settingsStore.delete("openrouter_api_key");
    settings.openrouter_api_key = "";
  } else {
    await settingsStore.delete("elevenlabs_api_key");
    await settingsStore.delete("elevenlabs_voice_id");
    await settingsStore.delete("elevenlabs_tts_model");
    await settingsStore.delete("elevenlabs_tts_output_format");
    await settingsStore.delete("elevenlabs_tts_speed");
    await settingsStore.delete("elevenlabs_stt_model");
    await settingsStore.delete("elevenlabs_stt_language_code");

    settings.elevenlabs_api_key = "";
    settings.elevenlabs_voice_id = "";
    settings.elevenlabs_tts_model = DEFAULTS.elevenlabs_tts_model;
    settings.elevenlabs_tts_output_format = DEFAULTS.elevenlabs_tts_output_format;
    settings.elevenlabs_tts_speed = DEFAULTS.elevenlabs_tts_speed;
    settings.elevenlabs_stt_model = DEFAULTS.elevenlabs_stt_model;
    settings.elevenlabs_stt_language_code = DEFAULTS.elevenlabs_stt_language_code;
  }

  await settingsStore.save();
  setSavedPulse();
}

async function resetChatSettings() {
  settings.chat_auto_speech = DEFAULTS.chat_auto_speech;
  settings.chat_auto_speech_mode = DEFAULTS.chat_auto_speech_mode;
  settings.chat_auto_speech_rate = DEFAULTS.chat_auto_speech_rate;
  settings.chat_auto_speech_volume = DEFAULTS.chat_auto_speech_volume;
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
      await ensureStoreLoaded();
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
  { id: "api", title: "API", desc: "OpenRouter + ElevenLabs", icon: "key" },
  { id: "server", title: "Server", desc: "Laravel Sync API", icon: "server" },
  { id: "voice", title: "Voice", desc: "Wake-Word + lokale Modelle", icon: "mic" },
  { id: "chat", title: "Chat", desc: "Auto Speech", icon: "chat" },
  { id: "appearance", title: "Appearance", desc: "UI (später)", icon: "palette" },
  { id: "privacy", title: "Privacy", desc: "Storage (später)", icon: "shield" },
];

function selectTab(id: SettingsTab) {
  ui.tab = id;
  ui.error = null;
  ui.saved = false;
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
      <button type="button" class="lz-backdrop" aria-label="Close" @click="closeModal" />

      <div class="lz-modal" role="dialog" aria-modal="true">
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
          <aside class="lz-nav">
            <div class="tac-label lz-nav__label">Bereiche</div>
            <button
              v-for="t in tabs"
              :key="t.id"
              type="button"
              class="lz-tab"
              :class="{ 'is-active': ui.tab === t.id }"
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
          <section class="lz-main">
            <div class="lz-scroll">
              <!-- API -->
              <div v-if="ui.tab === 'api'" class="lz-section">
                <div class="lz-section__head">
                  <h3>API-Schlüssel <span class="lz-optbadge">optional</span></h3>
                  <p>Nur nötig, wenn der <b>Server-Proxy</b> (Server-Tab) ausgeschaltet ist. Standardmäßig liegen alle Provider-Keys verschlüsselt auf dem Server.</p>
                </div>

                <div class="lz-card">
                  <div class="lz-card__head">
                    <div>
                      <div class="lz-card__title">OpenRouter</div>
                      <div class="lz-card__meta">Key: <span class="mono">{{ maskedOrKey || "—" }}</span></div>
                    </div>
                    <button type="button" class="lz-btn lz-btn--ghost" @click="clearApiKey('openrouter')">Key löschen</button>
                  </div>
                  <label class="lz-label">OpenRouter API Key</label>
                  <input v-model="settings.openrouter_api_key" type="text" autocomplete="off" placeholder="sk-or-..." class="lz-input" />
                </div>

                <div class="lz-card">
                  <div class="lz-card__head">
                    <div>
                      <div class="lz-card__title">ElevenLabs</div>
                      <div class="lz-card__meta">Key: <span class="mono">{{ maskedXiKey || "—" }}</span></div>
                    </div>
                    <button type="button" class="lz-btn lz-btn--ghost" @click="clearApiKey('elevenlabs')">ElevenLabs löschen</button>
                  </div>

                  <label class="lz-label">ElevenLabs API Key</label>
                  <input v-model="settings.elevenlabs_api_key" type="text" autocomplete="off" placeholder="xi-..." class="lz-input" />
                  <p class="lz-hint">Benötigt für Cloud-STT (scribe_v2) und Cloud-TTS (voice_id).</p>

                  <div class="lz-grid2">
                    <div>
                      <label class="lz-label">TTS Voice ID</label>
                      <input v-model="settings.elevenlabs_voice_id" type="text" autocomplete="off" placeholder="21m00Tcm4TlvDq8ikWAM" class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">TTS Model</label>
                      <input v-model="settings.elevenlabs_tts_model" type="text" autocomplete="off" placeholder="eleven_multilingual_v2" class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">TTS Output Format</label>
                      <input v-model="settings.elevenlabs_tts_output_format" type="text" autocomplete="off" placeholder="mp3_44100_128" class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">TTS Speed</label>
                      <div class="lz-range">
                        <input v-model.number="settings.elevenlabs_tts_speed" type="range" min="0.7" max="1.3" step="0.05" />
                        <span class="lz-range__val">{{ settings.elevenlabs_tts_speed.toFixed(2) }}</span>
                      </div>
                    </div>
                    <div>
                      <label class="lz-label">STT Model</label>
                      <input v-model="settings.elevenlabs_stt_model" type="text" autocomplete="off" placeholder="scribe_v2" class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">STT Language Code</label>
                      <input v-model="settings.elevenlabs_stt_language_code" type="text" autocomplete="off" placeholder="deu" class="lz-input" />
                    </div>
                  </div>
                  <p v-if="ui.error" class="lz-error">{{ ui.error }}</p>
                </div>
              </div>

              <!-- SERVER -->
              <div v-else-if="ui.tab === 'server'" class="lz-section">
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
                    <button type="button" class="lz-switch" :class="{ 'is-on': settings.use_server_proxy }" @click="settings.use_server_proxy = !settings.use_server_proxy"><span /></button>
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

                  <label class="lz-label">Cognee URL (Memory-Engine)</label>
                  <input v-model="settings.cognee_base_url" class="lz-input" placeholder="http://localhost:8765" />
                  <p class="lz-hint">Leer = lokaler Memory-Puffer. Mit URL nutzt Luczor Cognee für semantische Erinnerungen.</p>

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

              <!-- VOICE -->
              <div v-else-if="ui.tab === 'voice'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Voice</h3>
                  <p>Dauer-Zuhören mit Wake-Word und optional lokale Sprachmodelle (offline).</p>
                </div>
                <div class="lz-card">
                  <div class="lz-grid2">
                    <div>
                      <label class="lz-label">Eingabe-Modus</label>
                      <select v-model="settings.voice_mode" class="lz-input">
                        <option value="push_to_talk">Push-to-Talk (Knopf)</option>
                        <option value="continuous">Dauerhaft zuhören</option>
                        <option value="wakeword">Wake-Word</option>
                      </select>
                    </div>
                    <div>
                      <label class="lz-label">Wake-Word</label>
                      <input v-model="settings.voice_wake_word" type="text" placeholder="luczor" class="lz-input" />
                      <p class="lz-hint">Erkennung über das Transkript.</p>
                    </div>
                    <div>
                      <label class="lz-label">STT-Backend</label>
                      <select v-model="settings.voice_stt_backend" class="lz-input">
                        <option value="cloud">Cloud (ElevenLabs)</option>
                        <option value="local">Lokal (whisper.cpp)</option>
                      </select>
                    </div>
                    <div>
                      <label class="lz-label">TTS-Backend</label>
                      <select v-model="settings.voice_tts_backend" class="lz-input">
                        <option value="cloud">Cloud (ElevenLabs)</option>
                        <option value="local">Lokal (Piper)</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div class="lz-card">
                  <div class="lz-card__title">Lokale Modelle (offline)</div>
                  <p class="lz-hint">Pfade zu selbst installierten Binaries/Modellen. Ohne diese nutzt Luczor automatisch Cloud.</p>
                  <div class="lz-grid2">
                    <div>
                      <label class="lz-label">whisper.cpp Binary</label>
                      <input v-model="settings.voice_local_stt_binary" type="text" placeholder="C:\tools\whisper-cli.exe" class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">whisper Modell</label>
                      <input v-model="settings.voice_local_stt_model" type="text" placeholder="ggml-medium.bin" class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">STT Sprache</label>
                      <input v-model="settings.voice_local_stt_language" type="text" placeholder="de" class="lz-input" />
                    </div>
                    <div></div>
                    <div>
                      <label class="lz-label">Piper Binary</label>
                      <input v-model="settings.voice_local_tts_binary" type="text" placeholder="C:\tools\piper.exe" class="lz-input" />
                    </div>
                    <div>
                      <label class="lz-label">Piper Voice (.onnx)</label>
                      <input v-model="settings.voice_local_tts_model" type="text" placeholder="de_DE-thorsten-medium.onnx" class="lz-input" />
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
                        <input v-model.number="settings.chat_auto_speech_rate" type="range" min="0.5" max="2" step="0.1" />
                        <span class="lz-range__val">{{ settings.chat_auto_speech_rate.toFixed(1) }}</span>
                      </div>
                    </div>
                    <div>
                      <label class="lz-label">Volume</label>
                      <div class="lz-range">
                        <input v-model.number="settings.chat_auto_speech_volume" type="range" min="0" max="100" step="1" />
                        <span class="lz-range__val">{{ settings.chat_auto_speech_volume }}</span>
                      </div>
                    </div>
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

                  <div class="lz-row">
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
</style>
