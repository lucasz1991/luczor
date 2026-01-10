<!-- src/components/Settings.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Store } from "@tauri-apps/plugin-store";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

const apiKey = ref("");
const saved = ref(false);
const error = ref<string | null>(null);
const loaded = ref(false);

let settingsStore: Store | null = null;

const maskedKey = computed(() => {
  const v = apiKey.value.trim();
  if (!v) return "";
  if (v.length <= 10) return "•".repeat(v.length);
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
});

function closeModal() {
  emit("update:open", false);
  saved.value = false;
  error.value = null;
}

async function ensureStoreLoaded() {
  if (loaded.value) return;

  settingsStore = await Store.load("luczor.settings.json");

  const existing = await settingsStore.get<string>("openrouter_api_key");
  if (existing) apiKey.value = existing;

  loaded.value = true;
}

async function saveKey() {
  if (!settingsStore) return;

  saved.value = false;
  error.value = null;

  const v = apiKey.value.trim();
  if (!v) {
    error.value = "Bitte OpenRouter API Key eingeben.";
    return;
  }

  await settingsStore.set("openrouter_api_key", v);
  await settingsStore.save();

  saved.value = true;
  window.setTimeout(() => closeModal(), 650);
}

async function clearKey() {
  if (!settingsStore) return;

  saved.value = false;
  error.value = null;

  await settingsStore.delete("openrouter_api_key");
  await settingsStore.save();

  apiKey.value = "";
  saved.value = true;

  window.setTimeout(() => (saved.value = false), 700);
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
      saved.value = false;
      error.value = null;
      await ensureStoreLoaded();
    } else {
      document.body.style.overflow = "";
      saved.value = false;
      error.value = null;
    }
  },
  { immediate: true }
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
});
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
          class="w-full max-w-xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
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
                  <path d="M10 12a2 2 0 1 1 4 0v1" />
                  <path d="M9 13h6v4H9z" />
                </svg>
              </div>

              <div class="min-w-0">
                <h2 class="text-lg font-semibold text-gray-900">Settings</h2>
                <p class="mt-1 text-sm text-gray-600">
                  OpenRouter API Key lokal speichern (AppData). Nicht committen.
                </p>
              </div>
            </div>

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

          <!-- Body -->
          <div class="px-6 py-5 space-y-4">
            <div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-gray-500">Status</div>
                  <div class="mt-1 text-sm text-gray-900">
                    <template v-if="apiKey.trim()">
                      Key gesetzt:
                      <span class="font-mono text-xs text-gray-700">{{ maskedKey }}</span>
                    </template>
                    <template v-else>
                      Kein Key gesetzt
                    </template>
                  </div>
                </div>

                <span
                  v-if="saved"
                  class="shrink-0 inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700"
                >
                  gespeichert
                </span>
              </div>
            </div>

            <div class="space-y-2">
              <label class="block text-sm font-medium text-gray-800">OpenRouter API Key</label>

              <div class="relative">
                <input
                  v-model="apiKey"
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

              <p v-if="error" class="text-sm text-red-600">{{ error }}</p>

              <p class="text-xs text-gray-500">
                Datei: <span class="font-mono">luczor.settings.json</span> im AppData/Roaming deiner Tauri-App.
              </p>
            </div>
          </div>

          <!-- Footer -->
          <div class="flex flex-col gap-3 border-t border-gray-100 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
              @click="clearKey"
            >
              Löschen
            </button>

            <div class="flex gap-2">
              <button
                type="button"
                class="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition"
                @click="closeModal"
              >
                Abbrechen
              </button>

              <button
                type="button"
                class="inline-flex items-center justify-center rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 transition"
                @click="saveKey"
              >
                Speichern
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>
