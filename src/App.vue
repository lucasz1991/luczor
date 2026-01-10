<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import Settings from "./components/Settings.vue";
import {
  OpenRouterService,
  type LuczorEnvelope,
  type LuczorMode,
  buildStructuredInstruction,
} from "./services/openrouter.service";
import { usePushToTalk } from "@/services/pushToTalk";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import { speak } from "@/services/tts";


/* -------------------------------------------------
 * Types
 * ------------------------------------------------- */
type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  raw?: string;
  parsed?: LuczorEnvelope | null;
  ts: number;
};

type Project = { id: string; name: string };
type ChatsMap = Record<string, ChatMessage[]>;

/* -------------------------------------------------
 * Utils
 * ------------------------------------------------- */
const uid = () =>
  crypto.randomUUID?.() ?? `m_${Math.random().toString(16).slice(2)}_${Date.now()}`;

const now = () => Date.now();

const makeMsg = (role: ChatRole, content: string): ChatMessage => ({
  id: uid(),
  role,
  content,
  raw: undefined,
  parsed: null,
  ts: now(),
});



/* -------------------------------------------------
 * Render helper
 * ------------------------------------------------- */
function renderLuczorEnvelopeToChat(env: LuczorEnvelope): string {
  const lines: string[] = [];

  /* if (env.summary?.trim()) lines.push(env.summary.trim());

  if (env.bullets.length) {
    lines.push("");
    for (const b of env.bullets.slice(0, 5)) lines.push(`- ${b}`);
  }

  if (env.plan?.steps?.length) {
    lines.push("");
    lines.push("Plan:");
    for (const s of env.plan.steps.slice(0, 6)) lines.push(`- ${s}`);
  }

  if (env.actions.length) {
    lines.push("");
    lines.push("Vorgeschlagene Actions (nur zur Prüfung, nicht ausgeführt):");
    for (const a of env.actions.slice(0, 8)) {
      lines.push(`- [${a.risk}] ${a.type}${a.requires_approval ? " (approval required)" : ""}`);
    }
  }*/

  if (env.question.trim()) {
    lines.push("");
    lines.push(`${env.question.trim()}`);
  }

  return lines.join("\n").trim();
}

/* -------------------------------------------------
 * State
 * ------------------------------------------------- */
const showSettings = ref(false);

const projects = ref<Project[]>([
  { id: "default", name: "Dev Test" },
]);

const activeProjectId = ref(projects.value[0]?.id ?? "default");

const activeProject = computed(() =>
  projects.value.find((p) => p.id === activeProjectId.value)
);

const chats = ref<ChatsMap>({
  default: [makeMsg("assistant", "Willkommen. Wie kann ich dir helfen?")],
});

function ensureChat(projectId: string): ChatMessage[] {
  const existing = chats.value[projectId];
  if (existing) return existing;

  const created = [makeMsg("assistant", "Willkommen. Wie kann ich dir helfen?")];
  chats.value[projectId] = created;
  return created;
}

ensureChat(activeProjectId.value);

const messages = computed<ChatMessage[]>({
  get: (): ChatMessage[] => ensureChat(activeProjectId.value),
  set: (v: ChatMessage[]) => {
    chats.value[activeProjectId.value] = v;
  },
});

const input = ref("");
const sending = ref(false);
const mode = ref<LuczorMode>("observe");

const abortController = ref<AbortController | null>(null);
let cancelCurrent: null | (() => Promise<void>) = null;

/* -------------------------------------------------
 * Actions
 * ------------------------------------------------- */
async function stopGenerating() {
  if (cancelCurrent) {
    try {
      await cancelCurrent();
    } catch {
      /* ignore */
    }
    cancelCurrent = null;
  }

  abortController.value?.abort();
  abortController.value = null;

  sending.value = false;
}

function openProject(id: string) {
  stopGenerating();
  activeProjectId.value = id;
  ensureChat(id);
}

// DEBUG helper (oben im <script setup> platzieren)
function debugMsg(m: ChatMessage) {
  // Achtung: alert kann bei sehr langen Texten nerven. Für kurze Dumps ok.
  alert(JSON.stringify(m, null, 2));
}

function newChat() {
  stopGenerating();
  messages.value = [makeMsg("assistant", "Neuer Chat. Was soll ich bauen?")];
}

function addProject() {
  stopGenerating();

  const id = `p_${Math.random().toString(16).slice(2)}`;
  const name = `Projekt ${projects.value.length + 1}`;

  projects.value.unshift({ id, name });
  ensureChat(id);
  activeProjectId.value = id;
}

watch(activeProjectId, (id) => {
  stopGenerating();
  ensureChat(id);
});



const { isRecording, error: pttError, start: startPtt, stop: stopPtt, cancel: cancelPtt } = usePushToTalk();

async function togglePushToTalk() {
  // Aufnahme starten
  if (!isRecording.value) {
    try {
      await startPtt();
    } catch (e: any) {
      // optional: in Chat ausgeben
      messages.value.push(makeMsg("assistant", `Mikrofon-Fehler: ${e?.message ?? String(e)}`));
    }
    return;
  } 

  const settingsStore = await Store.load("luczor.settings.json");
  const openaiKey = await settingsStore.get<string>("openrouter_api_key");

  const audio = await stopPtt();
  if (!audio) return;

const result = await invoke<{ text: string }>("speech_transcribe", {
  payload: {
    base64: audio.base64,
    mime: audio.mime,
    api_key: openaiKey,
    model: "openai/gpt-4o-audio-preview",
  },
});


input.value = result.text;

}

async function stopAll() {
  await stopGenerating();
  if (isRecording.value) cancelPtt();
}







/* -------------------------------------------------
 * Send
 * ------------------------------------------------- */
async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;

  await stopGenerating();

  messages.value.push(makeMsg("user", text));
  input.value = "";
  sending.value = true;

  const assistantMsg: ChatMessage = {
    ...makeMsg("assistant", ""),
    raw: "", 
    parsed: null,
  };
  messages.value.push(assistantMsg);

  await nextTick();

  const abort = new AbortController();
  abortController.value = abort;

  const baseMessages = messages.value
    .filter((m) => m.id !== assistantMsg.id)
    .map((m) => ({ role: m.role as any, content: m.content }));

  // optional; schema already enforces it, but helps model behave
  const requestMessages = [
    ...baseMessages,
    { role: "user" as const, content: buildStructuredInstruction(mode.value) },
  ];

  try {
    const { cancel } = await OpenRouterService.streamChat({
      model: "@preset/luczor",
      messages: requestMessages as any,
      mode: mode.value,

      onToken: (tok) => {
        assistantMsg.raw = tok;
        assistantMsg.content = tok;
      },

      onStructured: (env) => {
        assistantMsg.parsed = env;
        assistantMsg.content = renderLuczorEnvelopeToChat(env);
      },

      onDone: (rawText) => {
        if (!assistantMsg.parsed) {
          assistantMsg.raw = rawText;
          assistantMsg.content = rawText || assistantMsg.content;
        }
      },

      onError: (msg) => {
        assistantMsg.content = `[Fehler] ${msg}`;
      },

      signal: abort.signal,
    });

    cancelCurrent = cancel;
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    assistantMsg.content =
      assistantMsg.content || `Fehler: ${e?.message ?? String(e)}`;
  } finally {
    if (abortController.value === abort) abortController.value = null;
    sending.value = false;
    cancelCurrent = null;
  }
}
</script>
<template>
  <Settings :open="showSettings" @update:open="showSettings = $event" />
  <div class="min-h-screen max-h-screen w-full bg-gray-300 text-gray-900  overflow-hidden border-t border-gray-300">
    <div class="w-full h-screen ">
      <div class="grid grid-cols-12 h-full items-stretch min-h-0">
        <!-- SIDEBAR -->
        <aside class="col-span-12 md:col-span-4 lg:col-span-3 xl:col-span-2 h-full min-h-0">
          <div class="sticky h-full ">
            <div
              class=" bg-white shadow-sm overflow-hidden flex items-stretch flex-col h-full pb-4 border-r border-gray-300"
            >
              <!-- Brand / Actions -->
              <div class="px-4 py-4 border-b border-gray-100">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-xs text-gray-500">Luczor</div>
                    <div class="mt-1 text-[11px] text-gray-500">
                      Aktiv:
                      <span class="text-gray-800 font-medium">
                        {{ activeProject?.name }}
                      </span>
                    </div>
                  </div>
                  <div class="flex flex-col gap-2">
                    <button
                      type="button"
                      class="inline-flex items-center justify-center rounded-xl bg-blue-800 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-900 transition"
                      @click="newChat"
                      title="Neuer Chat"
                    >
                      + New
                    </button>
                    <button
                      type="button"
                      class="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition"
                      @click="addProject"
                      title="Neues Projekt"
                    >
                      + Projekt
                    </button>
                  </div>
                </div>
              </div>
              <!-- Projects list -->
              <div class="px-4 py-3">
                <div class="flex items-center justify-between">
                  <div class="text-xs font-semibold text-gray-600">Projekte</div>
                  <div class="text-[11px] text-gray-500">{{ projects.length }}</div>
                </div>

                <div class="mt-3 max-h-[52vh] overflow-y-auto pr-1 space-y-2">
                  <button
                    v-for="p in projects"
                    :key="p.id"
                    type="button"
                    class="w-full rounded-xl border px-3 py-2 text-left transition"
                    :class="p.id === activeProjectId
                      ? 'border-blue-900 bg-blue-800 text-white'
                      : 'border-gray-200 bg-white hover:bg-blue-100 text-gray-800'"
                    @click="openProject(p.id)"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="min-w-0">
                        <div class="truncate text-sm font-semibold">
                          {{ p.name }}
                        </div>
                        <div
                          class="mt-0.5 text-[11px]"
                          :class="p.id === activeProjectId ? 'text-white/70' : 'text-gray-500'"
                        >
                          {{ p.id }}
                        </div>
                      </div>
                      <span
                        v-if="p.id === activeProjectId"
                        class="shrink-0 inline-flex items-center rounded-full bg-white/15 px-2 py-1 text-[10px] font-semibold"
                      >
                        aktiv
                      </span>
                    </div>
                  </button>
                </div>
              </div>
              <!-- Bottom settings button -->
              <div class="px-4 bg-white flex items-end h-full">
                <button
                  type="button"
                  class="w-full inline-flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 transition"
                  @click="showSettings = true"
                >
                  <span class="inline-flex items-center gap-2">
                    <span class="inline-flex h-6 w-6 items-center justify-center rounded-xl bg-gray-900 text-white">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        class="h-4 w-4"
                        viewBox="0 0 24 24"
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
                    </span>
                    Settings
                  </span>
                </button>
              </div>
            </div>
          </div>
        </aside>
        <!-- MAIN CHAT -->
        <main  class="col-span-12 md:col-span-8 lg:col-span-9 xl:col-span-10 h-full min-h-0">
          <div class=" bg-white shadow-sm overflow-hidden flex flex-col h-full min-h-0 justify-stretch">
            <!-- Header -->
            <div class="shrink-0 flex items-center justify-between border-b border-gray-300 px-4 py-3">
              <div class="min-w-0">
                <div class="truncate text-sm font-semibold text-gray-900">
                  {{ activeProject?.name }}
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition"
                  @click="showSettings = true"
                >
                  Settings
                </button>
                <button
                  v-if="sending"
                  type="button"
                  class="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition"
                  @click="stopGenerating"
                >
                  Stop
                </button>

                <button
                  type="button"
                  class="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition"
                  @click="newChat"
                >
                  Reset
                </button>
              </div>
            </div>
            <!-- Messages -->
            <div class="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden px-4 py-4 bg-gray-300 relative">
              <div class="flex min-h-full flex-col gap-3 px-4 mx-auto container">
                <div class="mt-auto flex flex-col gap-4">
                  <div
                    v-for="m in messages"
                    :key="m.id"
                    class="flex w-full"
                    :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
                  >
                    <div
                      class="group relative isolate max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm border backdrop-blur cursor-pointer"
                      :class="m.role === 'user'
                        ? 'bg-white border-gray-200 text-gray-900'
                        : 'bg-blue-700 border-blue-800/60 text-white'"
                      @click="debugMsg(m)"
                      title="Klicken zum Debug-Dump"
                    >
                      <div
                        class="pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition z-10"
                        :class="m.role === 'user'
                          ? 'bg-gradient-to-br from-white/0 via-white/0 to-gray-100/60'
                          : 'bg-gradient-to-br from-white/0 via-white/0 to-white/10'"
                      />
                      <div
                        class="pointer-events-none absolute bottom-3 h-3 w-3 rotate-45 z-20"
                        :class="m.role === 'user'
                          ? '-right-[6px] bg-white  border-gray-300  border-r'
                          : '-left-[6px] bg-blue-700  border-blue-800/60  border-l'"
                      />
                      <div class="relative z-20">
                        <div class="mb-1 flex items-center gap-2">
                          <div
                            class="text-[11px] font-semibold tracking-wide"
                            :class="m.role === 'user' ? 'text-gray-500' : 'text-white'"
                          >
                            {{ m.role === "user" ? "Du" : "Luczor" }}
                          </div>
                          <span
                            class="h-1 w-1 rounded-full"
                            :class="m.role === 'user' ? 'bg-gray-300' : 'bg-white/60'"
                          />
                          <div
                            class="text-[11px]"
                            :class="m.role === 'user' ? 'text-gray-400' : 'text-white/80'"
                            :title="new Date(m.ts).toLocaleString()"
                          >
                            {{ new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                          </div>
                        </div>
                        <div class="whitespace-pre-wrap text-base" :class="m.role === 'user' ? 'text-gray-900' : 'text-white'">
                          {{ m.content }}
                        </div>
                      </div>
                    </div>
                    <div class="flex items-center">
                      <button
                        v-if="m.role === 'assistant' && m.content?.trim()"
                        type="button"
                        class="ml-2 inline-flex items-center rounded-lg px-2 py-2 text-[11px] font-semibold text-white hover:bg-white/20"
                        @click.stop="speak(m.content)"
                        title="Vorlesen"
                      >
                        🔊
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- Composer -->
            <div class="flex-0 shrink-0  bg-gray-300 px-4 pt-4 pb-6">
              <div class="flex items-end gap-2  mx-auto container">
                <textarea
                  v-model="input"
                  rows="1"
                  placeholder="Schreibe eine Nachricht…"
                  class="flex-1 resize-none rounded-2xl border border-gray-200 bg-white px-4 py-3 text-base text-gray-900 outline-none focus:ring focus:ring-gray-200"
                  @keydown.enter.exact.prevent="send"
                />
                <button
                  type="button"
                  class="py-3 rounded-2xl border border-gray-200 bg-white px-4 text-base font-semibold text-gray-700 hover:bg-gray-50 transition"
                  :class="isRecording ? 'ring-2 ring-red-400 border-red-300 text-red-700' : ''"
                  :disabled="sending"
                  @click="togglePushToTalk"
                >
                  <span v-if="!isRecording">🎙️</span>
                  <span v-else>⏹</span>
                </button>
                <button
                  type="button"
                  class="py-3 rounded-2xl bg-blue-900 px-4 text-base font-semibold text-white hover:bg-gray-800 disabled:opacity-60 transition"
                  :disabled="sending || !input.trim()"
                  @click="send"
                >
                  {{ sending ? "…" : "Senden" }}
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  </div>
</template>