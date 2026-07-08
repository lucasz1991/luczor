<!-- src/components/Settings.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, watch } from "vue";
import { Store } from "@tauri-apps/plugin-store";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

/* ---------------------------
 * Store / State
 * --------------------------- */
type SettingsTab = "api" | "chat" | "appearance" | "privacy";
type ChatAutoSpeechMode = "off" | "assistant_only" | "all";

type AppSettings = {
  openrouter_api_key: string;

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
};

const DEFAULTS: AppSettings = {
  openrouter_api_key: "",

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
};

const ui = reactive({
  tab: "api" as SettingsTab,
  saved: false,
  error: null as string | null,
  loaded: false,
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

  ui.loaded = true;
}

async function saveAll() {
  if (!settingsStore) return;

  ui.error = null;

  // Minimal validation only when API tab is open
  if (ui.tab === "api") {
    const or = settings.openrouter_api_key.trim();
    if (!or) {
      ui.error = "Bitte OpenRouter API Key eingeben (oder wechsle zu einem anderen Tab).";
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

  await settingsStore.save();
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
  { id: "chat", title: "Chat", desc: "Auto Speech", icon: "chat" },
  { id: "appearance", title: "Appearance", desc: "UI (später)", icon: "palette" },
  { id: "privacy", title: "Privacy", desc: "Storage (später)", icon: "shield" },
];

function selectTab(id: SettingsTab) {
  ui.tab = id;
  ui.error = null;
  ui.saved = false;
}

function iconPath(kind: string) {
  switch (kind) {
    case "key":
      return "M21 2l-2 2m-7.5 7.5L19 4M7 14a4 4 0 1 1 3.9-5M7 18h4l1.5-1.5L14 18h2l1.5-1.5L19 18h2v-2l-5.5-5.5";
    case "chat":
      return "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z";
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
    <div v-if="open" class="fixed inset-0 z-50">
      <!-- Backdrop -->
      <button
        type="button"
        class="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
        aria-label="Close"
        @click="closeModal"
      />

      <!-- Dialog -->
      <div class="relative flex min-h-screen items-center justify-center p-4">
        <div
          class="w-full max-w-4xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
          role="dialog"
          aria-modal="true"
        >
          <!-- Header -->
          <div class="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-5">
            <div class="flex items-start gap-3">
              <div class="mt-0.5 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gray-900 text-white">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>

              <div class="min-w-0">
                <h2 class="text-lg font-semibold text-gray-900">Settings</h2>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <span
                v-if="ui.saved"
                class="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700"
              >
                gespeichert
              </span>

              <button
                type="button"
                class="inline-flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition"
                @click="closeModal"
                title="Schließen (Esc)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6 6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Content -->
          <div class="grid grid-cols-1 md:grid-cols-12">
            <!-- Sidebar -->
            <aside class="md:col-span-4 lg:col-span-3 border-b md:border-b-0 md:border-r border-gray-100 bg-gray-200">
              <div class="p-4">
                <div class="text-xs font-semibold text-gray-500">Bereiche</div>

                <nav class="mt-3 space-y-1">
                  <button
                    v-for="t in tabs"
                    :key="t.id"
                    type="button"
                    class="w-full rounded-xl px-3 py-2.5 text-left transition border"
                    :class="ui.tab === t.id
                      ? 'bg-white border-gray-200 shadow-sm'
                      : 'bg-transparent border-transparent hover:bg-white/70 hover:border-gray-200'"
                    @click="selectTab(t.id)"
                  >
                    <div class="flex items-center gap-3">
                      <div
                        class="inline-flex h-9 w-9 items-center justify-center rounded-xl"
                        :class="ui.tab === t.id ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 border border-gray-200'"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path :d="iconPath(t.icon)" />
                        </svg>
                      </div>

                      <div class="min-w-0">
                        <div class="text-sm font-semibold text-gray-900">{{ t.title }}</div>
                        <div class="text-xs text-gray-500 truncate">{{ t.desc }}</div>
                      </div>
                    </div>
                  </button>
                </nav>
              </div>
            </aside>

            <!-- Main -->
            <section class="md:col-span-8 lg:col-span-9">
              <div class="px-6 py-5">
                <!-- API TAB -->
                <div v-if="ui.tab === 'api'" class="space-y-6">
                  <div>
                    <h3 class="text-base font-semibold text-gray-900">API Keys</h3>
                    <p class="mt-1 text-sm text-gray-600">
                      OpenRouter für Chat/LLM, ElevenLabs für Speech-to-Text und Text-to-Speech.
                    </p>
                  </div>

                  <!-- OpenRouter -->
                  <div class="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="text-sm font-semibold text-gray-900">OpenRouter</div>
                        <div class="text-xs text-gray-500">
                          Key: <span class="font-mono">{{ maskedOrKey || "—" }}</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        class="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                        @click="clearApiKey('openrouter')"
                      >
                        Key löschen
                      </button>
                    </div>

                    <label class="block text-sm font-medium text-gray-800">OpenRouter API Key</label>
                    <div class="relative">
                      <input
                        v-model="settings.openrouter_api_key"
                        type="text"
                        autocomplete="off"
                        placeholder="sk-or-..."
                        class="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 pr-12 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                      />
                      <div class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-gray-400">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M21 2l-2 2m-7.5 7.5L19 4" />
                          <path d="M7 14a4 4 0 1 1 3.9-5" />
                          <path d="M7 18h4l1.5-1.5L14 18h2l1.5-1.5L19 18h2v-2l-5.5-5.5" />
                        </svg>
                      </div>
                    </div>
                  </div>

                  <!-- ElevenLabs -->
                  <div class="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-4">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="text-sm font-semibold text-gray-900">ElevenLabs</div>
                        <div class="text-xs text-gray-500">
                          Key: <span class="font-mono">{{ maskedXiKey || "—" }}</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        class="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                        @click="clearApiKey('elevenlabs')"
                      >
                        ElevenLabs löschen
                      </button>
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-gray-800">ElevenLabs API Key</label>
                      <input
                        v-model="settings.elevenlabs_api_key"
                        type="text"
                        autocomplete="off"
                        placeholder="xi-..."
                        class="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                      />
                      <p class="mt-2 text-xs text-gray-500">
                        Benötigt für STT (scribe_v2) und TTS (voice_id).
                      </p>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label class="block text-sm font-medium text-gray-800">TTS Voice ID</label>
                        <input
                          v-model="settings.elevenlabs_voice_id"
                          type="text"
                          autocomplete="off"
                          placeholder="z.B. 21m00Tcm4TlvDq8ikWAM"
                          class="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                        />
                        <p class="mt-2 text-xs text-gray-500">
                          Voice IDs findest du in ElevenLabs „Voices“ oder per Voices API.
                        </p>
                      </div>

                      <div>
                        <label class="block text-sm font-medium text-gray-800">TTS Model</label>
                        <input
                          v-model="settings.elevenlabs_tts_model"
                          type="text"
                          autocomplete="off"
                          placeholder="eleven_multilingual_v2"
                          class="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                        />
                      </div>

                      <div>
                        <label class="block text-sm font-medium text-gray-800">TTS Output Format</label>
                        <input
                          v-model="settings.elevenlabs_tts_output_format"
                          type="text"
                          autocomplete="off"
                          placeholder="mp3_44100_128"
                          class="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                        />
                        <p class="mt-2 text-xs text-gray-500">
                          Beispiele: <span class="font-mono">mp3_44100_128</span>, <span class="font-mono">pcm_44100</span>.
                        </p>
                      </div>

                      <div>
                        <label class="block text-sm font-medium text-gray-800">TTS Speed</label>
                        <div class="mt-2 flex items-center gap-3">
                          <input
                            v-model.number="settings.elevenlabs_tts_speed"
                            type="range"
                            min="0.7"
                            max="1.3"
                            step="0.05"
                            class="w-full"
                          />
                          <span class="w-14 text-right text-sm font-mono text-gray-700">
                            {{ settings.elevenlabs_tts_speed.toFixed(2) }}
                          </span>
                        </div>
                        <p class="mt-2 text-xs text-gray-500">
                          1.00 = normal, 1.10–1.20 = schneller.
                        </p>
                      </div>

                      <div>
                        <label class="block text-sm font-medium text-gray-800">STT Model</label>
                        <input
                          v-model="settings.elevenlabs_stt_model"
                          type="text"
                          autocomplete="off"
                          placeholder="scribe_v2"
                          class="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                        />
                      </div>

                      <div>
                        <label class="block text-sm font-medium text-gray-800">STT Language Code</label>
                        <input
                          v-model="settings.elevenlabs_stt_language_code"
                          type="text"
                          autocomplete="off"
                          placeholder="deu"
                          class="mt-2 w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                        />
                        <p class="mt-2 text-xs text-gray-500">
                          ISO-639-3 (z.B. <span class="font-mono">deu</span>, <span class="font-mono">eng</span>).
                        </p>
                      </div>
                    </div>

                    <p v-if="ui.error" class="text-sm text-red-600">{{ ui.error }}</p>
                  </div>
                </div>

                <!-- CHAT TAB -->
                <div v-else-if="ui.tab === 'chat'" class="space-y-4">
                  <div>
                    <h3 class="text-base font-semibold text-gray-900">Chat</h3>
                    <p class="mt-1 text-sm text-gray-600">
                      Auto Speech steuert, ob neue Nachrichten automatisch vorgelesen werden.
                    </p>
                  </div>

                  <div class="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-4">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="text-sm font-semibold text-gray-900">Auto Speech</div>
                        <p class="mt-1 text-sm text-gray-600">
                          Wenn aktiv, wird bei neuen Messages automatisch <span class="font-mono text-xs">speak()</span> getriggert.
                        </p>
                      </div>

                      <button
                        type="button"
                        class="relative inline-flex h-7 w-12 items-center rounded-full transition border"
                        :class="settings.chat_auto_speech ? 'bg-gray-900 border-gray-900' : 'bg-white border-gray-200'"
                        @click="settings.chat_auto_speech = !settings.chat_auto_speech"
                        aria-label="Toggle Auto Speech"
                      >
                        <span
                          class="inline-block h-6 w-6 rounded-full bg-white shadow transition"
                          :class="settings.chat_auto_speech ? 'translate-x-5' : 'translate-x-0.5'"
                        />
                      </button>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label class="block text-sm font-medium text-gray-800">Auto Speech Modus</label>
                        <select
                          v-model="settings.chat_auto_speech_mode"
                          class="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:ring focus:ring-gray-200"
                        >
                          <option value="assistant_only">Nur Assistant</option>
                          <option value="all">User + Assistant</option>
                          <option value="off">Aus (erzwingt Off)</option>
                        </select>
                      </div>

                      <div class="space-y-3">
                        <div>
                          <label class="block text-sm font-medium text-gray-800">Rate</label>
                          <div class="mt-2 flex items-center gap-3">
                            <input
                              v-model.number="settings.chat_auto_speech_rate"
                              type="range"
                              min="0.5"
                              max="2"
                              step="0.1"
                              class="w-full"
                            />
                            <span class="w-12 text-right text-sm font-mono text-gray-700">
                              {{ settings.chat_auto_speech_rate.toFixed(1) }}
                            </span>
                          </div>
                        </div>

                        <div>
                          <label class="block text-sm font-medium text-gray-800">Volume</label>
                          <div class="mt-2 flex items-center gap-3">
                            <input
                              v-model.number="settings.chat_auto_speech_volume"
                              type="range"
                              min="0"
                              max="100"
                              step="1"
                              class="w-full"
                            />
                            <span class="w-12 text-right text-sm font-mono text-gray-700">
                              {{ settings.chat_auto_speech_volume }}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <button
                        type="button"
                        class="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                        @click="resetChatSettings"
                      >
                        Chat Settings reset
                      </button>

                      <div class="text-xs text-gray-500">
                        Keys: <span class="font-mono">chat_auto_speech*</span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- APPEARANCE TAB (placeholder) -->
                <div v-else-if="ui.tab === 'appearance'" class="space-y-4">
                  <div>
                    <h3 class="text-base font-semibold text-gray-900">Appearance</h3>
                    <p class="mt-1 text-sm text-gray-600">
                      Platzhalter für Theme/Fonts (kommt als nächstes).
                    </p>
                  </div>

                  <div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <div class="text-sm text-gray-700">
                      Hier könntest du z.B. Dark/Light, Accent, Density, Font Size speichern.
                    </div>
                  </div>
                </div>

                <!-- PRIVACY TAB (placeholder) -->
                <div v-else class="space-y-4">
                  <div>
                    <h3 class="text-base font-semibold text-gray-900">Privacy</h3>
                    <p class="mt-1 text-sm text-gray-600">
                      Platzhalter für Speicher-/Retention-Settings.
                    </p>
                  </div>

                  <div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <div class="text-sm text-gray-700">
                      Z.B. „Chat History lokal speichern“, „Auto-Cleanup“, „Export/Import“.
                    </div>
                  </div>
                </div>
              </div>

              <!-- Footer -->
              <div class="flex flex-col gap-3 border-t border-gray-100 px-6 py-4 sm:flex-row sm:items-center sm:justify-end">
                <div class="flex justify-end gap-2">
                  <button
                    type="button"
                    class="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                    @click="closeModal"
                  >
                    Schließen
                  </button>

                  <button
                    type="button"
                    class="inline-flex items-center justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    :disabled="!canSave"
                    @click="saveAll"
                  >
                    Speichern
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>
