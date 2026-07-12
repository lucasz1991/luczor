<!-- App.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import Settings from "./components/Settings.vue";
import JarvisHud from "./components/JarvisHud.vue";
import { type LuczorMode, type WireMessage } from "./services/openrouter.service";
import { runAgent, buildSystemPreamble, shouldRequireToolCall } from "@/services/agent";
import { parseEnvelope } from "@/services/envelope";
import { resolveApproval, rejectAllApprovals } from "@/services/approvals";
import { usePushToTalk } from "@/services/pushToTalk";
import { Store } from "@tauri-apps/plugin-store";
import { listen } from "@tauri-apps/api/event";
import { VoiceEngine } from "@/services/voice/voiceEngine";
import { getVoiceConfig, localStt } from "@/services/voice/localVoice";
import { streamSpeak } from "@/services/voice/speak";
import { luczorMemory, getMemoryPrefs } from "@/services/memory/luczorMemory";
import { buildPromptContextDetails, inferTaskType, type PromptContextDetails } from "@/services/contextController";
import { LuczorApi } from "@/services/api/luczorApi";
import { refreshStatus } from "@/services/status";
import { appearance, loadAppearance } from "@/services/appearance";
import { startDeviceJobChannel } from "@/services/deviceJobs";
import { installDebugCapture, startDebugCollector, recordDebugEvent } from "@/services/debug";
import { buildRecentToolOutcomeContext, toolOutcomePreview } from "@/services/toolOutcomeContext";

import { startHud, setStatus } from "@/state/hud";
import { state, mutations } from "@/state/store";
import { loadAppState, scheduleSave } from "@/services/persistence";
import { playSfx, stopSfx, preloadSfx } from "@/services/sfx";
import { useAutoScroll } from "@/composables/useAutoScroll";

/* -------------------------------------------------
 * Helpers
 * ------------------------------------------------- */
function safeString(x: unknown) {
  return typeof x === "string" ? x : "";
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function safeTrim(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim();
}

function compactHistory(messages: WireMessage[], maxTokens: number): WireMessage[] {
  let used = 0;
  const selected: WireMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const content = "content" in message ? String(message.content ?? "") : "";
    const estimated = Math.max(1, Math.ceil(content.length / 4));
    if (selected.length && used + estimated > maxTokens) break;
    selected.unshift(message);
    used += estimated;
  }
  return selected;
}

function fmtTime(ts: number, seconds = false): string {
  return new Date(ts).toLocaleTimeString(
    [],
    seconds
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" }
  );
}

/* -------------------------------------------------
 * Local UI state
 * ------------------------------------------------- */
const showSettings = ref(false);
const input = ref("");
const sending = ref(false);
// How the pending composer content was produced; consumed + reset by send().
const pendingInputSource = ref<"keyboard" | "push_to_talk" | "hands_free">("keyboard");
const mode = ref<LuczorMode>("observe");
const allowUnrestricted = ref(false);
const ACTIVE_MODE_KEY = "active_mode";

const abortController = ref<AbortController | null>(null);
let cancelCurrent: null | (() => Promise<void>) = null;

/* -------------------------------------------------
 * Init
 * ------------------------------------------------- */
onMounted(async () => {
  installDebugCapture();
  void startDebugCollector();
  preloadSfx();
  startHud();
  void loadAppearance();

  const loaded = await loadAppState();
  if (loaded) mutations.hydrate(loaded);

  mutations.ensureDefaults();
  openProject(activeProjectId.value);

  // Restore the local mode immediately. A slow/offline bootstrap must not
  // leave the UI temporarily lying about being in observe mode.
  try {
    const st = await Store.load("luczor.settings.json");
    const dm = await st.get<string>("default_mode");
    const persisted = await st.get<string>(ACTIVE_MODE_KEY);
    allowUnrestricted.value = (await st.get<unknown>("allow_unrestricted")) === true;
    const candidate =
      persisted === "observe" || persisted === "act" || persisted === "unrestricted"
        ? persisted
        : dm;
    if (candidate === "observe" || candidate === "act" || candidate === "unrestricted") {
      mode.value = candidate === "unrestricted" && !allowUnrestricted.value ? "observe" : candidate;
    }

    // Refresh only the admin-managed unrestricted policy when online. Pulling
    // every server default here would overwrite unrelated local preferences.
    void (async () => {
      try {
        const boot = await LuczorApi.bootstrap();
        const remoteAllow = (boot.runtime_settings?.settings as Record<string, unknown> | undefined)
          ?.allow_unrestricted;
        if (remoteAllow === true || remoteAllow === false) {
          allowUnrestricted.value = remoteAllow;
          await st.set("allow_unrestricted", remoteAllow);
          if (!remoteAllow && mode.value === "unrestricted") {
            mode.value = "observe";
            await st.set(ACTIVE_MODE_KEY, "observe");
          }
          await st.save();
        }
      } catch {
        /* offline: keep the last locally cached policy */
      }
    })();
  } catch {
    /* ignore */
  }

  // Global hotkey (Ctrl+Alt+Space) -> toggle push-to-talk.
  try {
    await listen("luczor://hotkey", () => {
      void togglePushToTalk();
    });
  } catch (e) {
    console.warn("[hotkey] listen failed:", e);
  }

  // Sync/memory status heartbeat.
  void refreshStatus();
  window.setInterval(() => void refreshStatus(), 30000);

  void startDeviceJobChannel().catch((error) => console.warn("[device-jobs] unavailable", error));
});

/* -------------------------------------------------
 * Auto-Speech (Settings -> speak())
 * ------------------------------------------------- */
type ChatAutoSpeechMode = "off" | "assistant_only" | "all";

async function getAutoSpeechSettings(): Promise<{
  enabled: boolean;
  mode: ChatAutoSpeechMode;
  rate: number;
  volume: number;
}> {
  const store = await Store.load("luczor.settings.json");

  const enabled = (await store.get<boolean>("chat_auto_speech")) ?? false;
  const mode = (await store.get<ChatAutoSpeechMode>("chat_auto_speech_mode")) ?? "assistant_only";
  const rate = (await store.get<number>("chat_auto_speech_rate")) ?? 1.0;
  const volume = (await store.get<number>("chat_auto_speech_volume")) ?? 90;

  const safeMode: ChatAutoSpeechMode =
    mode === "off" || mode === "assistant_only" || mode === "all" ? mode : "assistant_only";

  return {
    enabled: !!enabled,
    mode: safeMode,
    rate: clamp(Number(rate) || 1.0, 0.5, 2.0),
    volume: clamp(Number(volume) || 90, 0, 100),
  };
}

function shouldSpeakAssistant(m: ChatAutoSpeechMode) {
  return m === "assistant_only" || m === "all";
}

let _lastSpokenAssistantId: string | null = null;

function speakMessage(m: any) {
  try {
    const q = ((m?.meta as any)?.question ?? "").toString().trim();
    const content = (m?.content ?? "").toString().trim();
    const text = (content + (q ? " " + q : "")).trim();
    if (!text) return;
    void speakWithVoiceMuted(text).catch((error) => {
      void recordDebugEvent("error", "manual_tts_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  } catch (e) {
    console.error("[speakMessage] error:", e);
  }
}

async function rateAssistantMessage(m: any, rating: 1 | -1) {
  const requestId = String(m?.meta?.llmRequestId ?? "");
  if (!requestId) return;
  const current = mutations.getProjectMessages(m.projectId ?? activeProjectId.value).find((x) => x.id === m.id);
  mutations.patchMessage(m.projectId ?? activeProjectId.value, m.id, {
    meta: { ...(current?.meta ?? {}), userFeedback: rating } as any,
  });
  try {
    await LuczorApi.evaluateLlmRun(requestId, {
      evaluator_id: "luczor.user.feedback.v1",
      status: rating > 0 ? "passed" : "failed",
      success_score: rating > 0 ? 1 : 0,
      quality_score: rating > 0 ? 1 : 0,
      user_feedback: rating,
    });
  } catch (e) {
    console.warn("[evaluation] feedback sync failed:", e);
  }
}

async function autoSpeakAssistantIfEnabled(pid: string, assistantId: string) {
  if (_lastSpokenAssistantId === assistantId) return;

  const msg = mutations.getProjectMessages(pid).find((m) => m.id === assistantId);
  const parts = [
    safeTrim(msg?.content),
    safeTrim(((msg?.meta as any)?.question ?? (msg?.meta as any)?.content ?? "")),
  ].filter(Boolean);
  const text = parts.join(" ");

  if (!text) return;
  if (text.startsWith("[Fehler]")) return;

  const s = await getAutoSpeechSettings();
  if (!s.enabled) return;
  if (!shouldSpeakAssistant(s.mode)) return;

  _lastSpokenAssistantId = assistantId;

  try {
    await speakWithVoiceMuted(text);
  } catch (e) {
    console.error("[AutoSpeech] speak() failed:", e);
    void recordDebugEvent("error", "auto_tts_failed", { message: e instanceof Error ? e.message : String(e) });
  }
}

/* -------------------------------------------------
 * Loading indicator (Assistant bubble)
 * ------------------------------------------------- */
const assistantLoadingTimer = ref<number | null>(null);
const assistantLoadingId = ref<string | null>(null);

function startAssistantLoading(pid: string, msgId: string) {
  stopAssistantLoading();
  assistantLoadingId.value = msgId;

  // No placeholder text: the UI shows animated typing dots while
  // meta.isLoading is true and there is no content yet.
  const current = mutations.getProjectMessages(pid).find((m) => m.id === msgId);
  mutations.patchMessage(pid, msgId, {
    content: "",
    meta: { ...(current?.meta ?? {}), isLoading: true } as any,
  });
}

function stopAssistantLoading() {
  if (assistantLoadingTimer.value) {
    window.clearInterval(assistantLoadingTimer.value);
    assistantLoadingTimer.value = null;
  }
  assistantLoadingId.value = null;
}

/* -------------------------------------------------
 * Derived state from store
 * ------------------------------------------------- */
const projects = computed(() => state.projects);

const activeProjectId = computed<string>({
  get() {
    state.global.ui ??= {};
    return state.global.ui.lastProjectId ?? state.projects[0]?.id ?? "default";
  },
  set(id) {
    mutations.setActiveProject(id);
  },
});

const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value));
const messages = computed(() => mutations.getProjectMessages(activeProjectId.value));

const { forceScroll } = useAutoScroll(messages, {
  selector: "#messages",
  thresholdPx: 140,
  behavior: "smooth",
});

/* -------------------------------------------------
 * Project Info Panel (Goals + Summaries)
 * ------------------------------------------------- */
const projectGoals = computed<any[]>(() => {
  const p: any = activeProject.value as any;
  return Array.isArray(p?.goals) ? p.goals : [];
});

const goalStats = computed(() => {
  const goals = projectGoals.value;
  const total = goals.length;
  const done = goals.filter((g) => g?.status === "done").length;
  const inProgress = goals.filter((g) => g?.status === "in_progress").length;
  const open = goals.filter((g) => g?.status === "open").length;
  return { total, open, inProgress, done };
});

function goalStatusLabel(status: string) {
  switch (status) {
    case "done":
      return "Done";
    case "in_progress":
      return "In Arbeit";
    case "blocked":
      return "Blockiert";
    default:
      return "Offen";
  }
}

const projectSummaries = computed<any[]>(() => {
  const pid = activeProjectId.value;
  const p: any = activeProject.value as any;

  const items: any[] = [];

  const rolling = safeTrim(p?.summary);
  if (rolling) {
    items.push({
      id: `rolling_${pid}`,
      createdAt: p?.updatedAt ?? Date.now(),
      text: rolling,
    });
  }

  const history: any[] = Array.isArray((state as any).summaries) ? (state as any).summaries : [];
  const last = history
    .filter((s) => s?.projectId === pid)
    .sort((a, b) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0))
    .slice(-3);

  for (const s of last) {
    items.push({
      id: s.id ?? `sum_${s.createdAt ?? s.ts ?? Math.random()}`,
      createdAt: s.createdAt ?? s.ts ?? Date.now(),
      text: s.text ?? s.summary ?? s.content ?? "",
    });
  }

  return items
    .filter((x) => safeTrim(x.text).length)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 3);
});

/* -------------------------------------------------
 * Core actions
 * ------------------------------------------------- */
async function stopGenerating() {
  stopAssistantLoading();
  _lastSpokenAssistantId = null;

  // Unblock any tool call awaiting user approval (rejects them).
  rejectAllApprovals();

  try {
    stopSfx("loading");
  } catch {}

  if (cancelCurrent) {
    try {
      await cancelCurrent();
    } catch {}
    cancelCurrent = null;
  }

  abortController.value?.abort();
  abortController.value = null;
  sending.value = false;
}

function openProject(id: string) {
  void stopGenerating();
  activeProjectId.value = id;
}

function newChat() {
  void stopGenerating();
  mutations.resetProjectChat(activeProjectId.value);
}

function addProject() {
  void stopGenerating();
  const id = `p_${Math.random().toString(16).slice(2)}`;
  const name = `Projekt ${projects.value.length + 1}`;
  mutations.addProject({ id, name });
  activeProjectId.value = id;
}

/* -------------------------------------------------
 * Push-to-talk (local whisper.cpp STT)
 * ------------------------------------------------- */
const { isRecording, start: startPtt, stop: stopPtt, cancel: cancelPtt } = usePushToTalk();

async function togglePushToTalk() {
  const pid = activeProjectId.value;

  if (!isRecording.value) {
    try {
      await startPtt();
      setStatus("listening");
    } catch (e: any) {
      setStatus("error");
      mutations.addMessage(
        mutations.makeMsg("assistant", `Mikrofon-Fehler: ${e?.message ?? String(e)}`, pid)
      );
    }
    return;
  }

  const audio = await stopPtt();
  setStatus("idle");
  if (!audio) return;

  try {
    input.value = await transcribeLocal(audio.base64);
    pendingInputSource.value = "push_to_talk";
  } catch (e: any) {
    void recordDebugEvent("error", "assistant_request_failed", { message: e?.message ?? String(e), status: e?.status ?? null });
    mutations.addMessage(mutations.makeMsg("assistant", `STT Fehler: ${e?.message ?? String(e)}`, pid));
  }
}

/* -------------------------------------------------
 * Continuous listening (VAD + wake word)
 * ------------------------------------------------- */
const voiceEngine = new VoiceEngine();
const listening = ref(false);
const lastHeard = ref("");
let voiceMuteDepth = 0;

/** Keep continuous STT from hearing Luczor's own local TTS output. */
async function speakWithVoiceMuted(text: string): Promise<void> {
  voiceMuteDepth += 1;
  voiceEngine.setMuted(true);
  try {
    await streamSpeak(text);
  } finally {
    voiceMuteDepth = Math.max(0, voiceMuteDepth - 1);
    voiceEngine.setMuted(voiceMuteDepth > 0);
  }
}
const listenLabel = ref("Zuhören");

async function transcribeLocal(wavBase64: string): Promise<string> {
  const cfg = await getVoiceConfig();
  return localStt(wavBase64, cfg.localSttLanguage);
}

async function transcribeUtterance(wavBase64: string): Promise<string> {
  return transcribeLocal(wavBase64);
}

async function toggleListening() {
  if (listening.value) {
    await voiceEngine.stop();
    listening.value = false;
    lastHeard.value = "";
    return;
  }
  const cfg = await getVoiceConfig();
  const wakeword = cfg.mode === "wakeword";
  listenLabel.value = wakeword ? `Wake-Word „${cfg.wakeWord}"` : "Dauer-Zuhören";
  lastHeard.value = "";
  try {
    await voiceEngine.start({
      mode: wakeword ? "wakeword" : "continuous",
      wakeWord: cfg.wakeWord,
      transcribe: (wav) => transcribeUtterance(wav),
      onUtterance: (text) => {
        lastHeard.value = text;
      },
      onError: (error) => {
        void recordDebugEvent("error", "continuous_stt_failed", { message: error.message });
      },
      onCommand: (text) => {
        const t = text.trim();
        if (!t || sending.value) return;
        input.value = t;
        pendingInputSource.value = "hands_free";
        void send();
      },
    });
    listening.value = true;
  } catch (e: any) {
    listening.value = false;
    setStatus("error");
    mutations.addMessage(
      mutations.makeMsg("assistant", `Zuhören fehlgeschlagen: ${e?.message ?? String(e)}`, activeProjectId.value)
    );
  }
}

/* -------------------------------------------------
 * Tool-call approvals (human-in-the-loop)
 * ------------------------------------------------- */
const pendingApprovals = computed(() => {
  const pid = activeProjectId.value;
  const bucket = state.pending?.toolCallsByProject?.[pid] ?? [];
  return bucket.filter((c) => c.status === "proposed" && c.requiresApproval);
});

function approveTool(id: string) {
  mutations.updateToolCallStatus(activeProjectId.value, id, "approved");
  resolveApproval(id, true);
}

function rejectTool(id: string) {
  mutations.updateToolCallStatus(activeProjectId.value, id, "rejected");
  resolveApproval(id, false);
}

function toolArgsPreview(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args, null, 1);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch {
    return "";
  }
}

/**
 * Cycle: Beobachten -> Handeln -> Vollzugriff -> Beobachten.
 * Entering "unrestricted" requires an explicit confirmation, because it
 * bypasses the approval gate entirely (only the Not-Aus still stops tools).
 */
async function persistActiveMode(value: LuczorMode) {
  try {
    const st = await Store.load("luczor.settings.json");
    await st.set(ACTIVE_MODE_KEY, value);
    await st.save();
  } catch {
    /* the in-memory selection still applies for this session */
  }
}

function toggleMode() {
  const next: LuczorMode =
    mode.value === "observe"
      ? "act"
      : mode.value === "act" && allowUnrestricted.value
        ? "unrestricted"
        : "observe";

  if (next === "unrestricted") {
    const ok = window.confirm(
      "VOLLZUGRIFF aktivieren?\n\n" +
        "Luczor führt dann ALLE Tools (Maus, Tastatur, Programme, Dateien) OHNE Rückfrage aus. " +
        "Nur der Not-Aus im HUD stoppt ihn noch.\n\nWirklich aktivieren?"
    );
    if (!ok) {
      return;
    }
  }
  mode.value = next;
  void persistActiveMode(next);
}

const modeLabel = computed(() =>
  mode.value === "unrestricted" ? "Vollzugriff" : mode.value === "act" ? "Handeln" : "Beobachten"
);
const modeTitle = computed(() => {
  switch (mode.value) {
    case "act":
      return allowUnrestricted.value
        ? "Handeln: Tools mit Bestätigung. Klicken für Vollzugriff."
        : "Handeln: Tools mit Bestätigung. Vollzugriff ist administrativ deaktiviert; klicken für Beobachten.";
    case "unrestricted":
      return "Vollzugriff: alle Tools OHNE Rückfrage. Klicken für Beobachten.";
    default:
      return "Beobachten: nur lesen. Klicken für Handeln.";
  }
});

/* -------------------------------------------------
 * Tool audit log (from hidden tool messages)
 * ------------------------------------------------- */
const showAudit = ref(false);
// Context panel (goals + summaries) is collapsed by default for a chat-first UI.
const showContext = ref(false);

const toolAudit = computed(() => {
  const pid = activeProjectId.value;
  return mutations
    .getProjectMessages(pid, { includeHidden: true })
    .filter((m) => m.role === "tool")
    .slice(-12)
    .reverse()
    .map((m) => ({
      id: m.id,
      name: (m.meta as any)?.toolName ?? "tool",
      ok: !!(m.parsed as any)?.ok,
      error: safeTrim((m.parsed as any)?.error),
      result: toolOutcomePreview(m),
      ts: m.ts,
    }));
});

/* -------------------------------------------------
 * Streamed envelope -> message rendering
 * ------------------------------------------------- */
function applyStreamedContent(pid: string, msgId: string, raw: string, done: boolean) {
  const env = parseEnvelope(raw);
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
    });
    return;
  }

  // Plain (non-envelope) text. Reset any question/bullets/summary that a
  // transient partial-envelope parse may have left behind, so stale suggestion
  // chips don't linger when the final text is not a valid envelope.
  const text = safeTrim(raw);
  mutations.patchMessage(pid, msgId, {
    raw,
    content: text || (done ? "Fertig." : ""),
    meta: { isLoading: !done, question: "", bullets: [], summary: "" } as any,
  });
}

/** Auto-grow the composer textarea up to a max height. */
const composerRef = ref<HTMLTextAreaElement | null>(null);
function autoGrow() {
  const el = composerRef.value;
  if (!el) return;
  // Real typing (this fires on @input) means the turn is keyboard again.
  pendingInputSource.value = "keyboard";
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

/** Click a suggestion chip -> send it as the next user message. */
function sendSuggestion(text: string) {
  const t = safeTrim(text);
  if (!t || sending.value) return;
  input.value = t;
  void send();
}

/** Persist the exchange to long-term memory (project scope). */
async function rememberExchange(pid: string, userText: string, assistantId: string) {
  try {
    const prefs = await getMemoryPrefs();
    if (!prefs.autoRemember) return;
    const msg = mutations.getProjectMessages(pid).find((m) => m.id === assistantId);
    const summary = safeTrim(msg?.content);
    if (userText) {
      await luczorMemory.remember({ content: userText, scope: "project", projectId: pid, source: "user" });
    }
    if (summary && !summary.startsWith("[Fehler]") && summary !== "Fertig.") {
      await luczorMemory.remember({ content: summary, scope: "project", projectId: pid, source: "chat" });
    }
    void refreshStatus();
  } catch (e) {
    console.warn("[memory] remember skipped:", e);
  }
}

/* -------------------------------------------------
 * Send
 * ------------------------------------------------- */
async function send() {
  const pid = activeProjectId.value;
  const text = input.value.trim();
  if (!text || sending.value) return;
  const taskType = inferTaskType(text);
  // Capture + reset how this turn was produced (spoken vs typed).
  const inputSource = pendingInputSource.value;
  pendingInputSource.value = "keyboard";

  void playSfx("submit");
  await stopGenerating();

  // user message (tag spoken input for the "Gesprochen" badge)
  const userMsg = mutations.makeMsg("user", text, pid);
  userMsg.meta = { ...(userMsg.meta ?? {}), inputSource };
  mutations.addMessage(userMsg);
  await forceScroll("auto");
  input.value = "";
  void nextTick(() => autoGrow());
  sending.value = true;

  // assistant placeholder
  const assistant = mutations.makeMsg("assistant", "", pid);
  assistant.raw = "";
  assistant.parsed = null;
  mutations.addMessage(assistant);
  await forceScroll("auto");

  await nextTick();
  startAssistantLoading(pid, assistant.id);

  const abort = new AbortController();
  abortController.value = abort;
  cancelCurrent = async () => abort.abort();

  // Build the wire history: system preamble + visible user/assistant text.
  const prj = activeProject.value;
  const fullHistory: WireMessage[] = mutations
    .getProjectMessages(pid)
    .filter((m) => m.id !== assistant.id)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => safeTrim(m.content).length > 0)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const settingsStore = await Store.load("luczor.settings.json");
  const historyBudget = clamp((await settingsStore.get<number>("client_history_token_budget")) ?? 2400, 400, 12000);
  const history = compactHistory(fullHistory, historyBudget);

  const baseMessages: WireMessage[] = [
    { role: "system", content: buildSystemPreamble(mode.value, prj?.name ?? pid, appearance.assistantName) },
    ...(safeTrim((prj as any)?.summary) ? [{ role: "system" as const, content: `Projektzusammenfassung: ${safeTrim((prj as any).summary)}` }] : []),
    ...history,
  ];
  const recentToolContext = buildRecentToolOutcomeContext(
    mutations.getProjectMessages(pid, { includeHidden: true })
  );
  if (recentToolContext) baseMessages.splice(1, 0, { role: "system", content: recentToolContext });

  // Inject relevant long-term memory (project scope) as an extra system note.
  let promptContext: PromptContextDetails = { text: "", taskType };
  try {
    const prefs = await getMemoryPrefs();
    if (prefs.inject) {
      // Context Controller (server) ranks + budgets memory; local fallback.
      promptContext = await buildPromptContextDetails(pid, text, prefs.injectCount, taskType);
      if (promptContext.text) baseMessages.splice(1, 0, { role: "system", content: promptContext.text });
    }
  } catch (e) {
    console.warn("[memory] context injection skipped:", e);
  }

  let streamStarted = false;

  try {
    void playSfx("loading");
    const { finalText, requestId, model, provider, useCase, toolFailures, toolSuccesses } = await runAgent({
      projectId: pid,
      baseMessages,
      mode: mode.value,
      getMode: () => mode.value,
      toolChoice: shouldRequireToolCall(text) ? "required" : "auto",
      taskType: promptContext.taskType,
      contextId: promptContext.contextId,
      repoId: promptContext.repoId,
      branch: promptContext.branch,
      commitSha: promptContext.commitSha,
      inputSource,
      signal: abort.signal,

      // Live streaming: parse the envelope progressively and render it.
      onToken: (raw) => {
        if (!streamStarted) {
          streamStarted = true;
          stopAssistantLoading();
          try {
            stopSfx("loading");
          } catch {}
        }
        applyStreamedContent(pid, assistant.id, raw, false);
      },
    });

    try {
      stopSfx("loading");
    } catch {}
    stopAssistantLoading();

    applyStreamedContent(pid, assistant.id, finalText, true);
    // Attach the server-reported routing metadata to the assistant message.
    {
      const current = mutations.getProjectMessages(pid).find((m) => m.id === assistant.id);
      mutations.patchMessage(pid, assistant.id, {
        meta: { ...(current?.meta ?? {}), model, provider, useCase },
      });
    }
    if (requestId) {
      const current = mutations.getProjectMessages(pid).find((m) => m.id === assistant.id);
      mutations.patchMessage(pid, assistant.id, {
        meta: { ...(current?.meta ?? {}), llmRequestId: requestId, userFeedback: null } as any,
      });
      void LuczorApi.evaluateLlmRun(requestId, {
        evaluator_id: "luczor.client.outcome.v1",
        status: toolFailures > 0 ? "needs_review" : "unverified",
        success_score: toolFailures > 0 ? 0.25 : (toolSuccesses > 0 ? 0.75 : 0.5),
        payload: { tool_failures: toolFailures, tool_successes: toolSuccesses, finish: "assistant_response" },
      }).catch((e) => console.warn("[evaluation] deferred:", e));
    }

    setStatus("idle");
    void autoSpeakAssistantIfEnabled(pid, assistant.id);
    void rememberExchange(pid, text, assistant.id);
  } catch (e: any) {
    try {
      stopSfx("loading");
    } catch {}
    stopAssistantLoading();

    const current = mutations.getProjectMessages(pid).find((m) => m.id === assistant.id);
    const currentContent = safeTrim(current?.content);

    if (e?.name === "AbortError") {
      setStatus("idle");
      mutations.patchMessage(pid, assistant.id, {
        content: currentContent || "Abgebrochen.",
        meta: { ...(current?.meta ?? {}), isLoading: false } as any,
      });
      return;
    }

    setStatus("error");
    mutations.patchMessage(pid, assistant.id, {
      content: `[Fehler] ${e?.message ?? String(e)}`,
      meta: { ...(current?.meta ?? {}), isLoading: false } as any,
    });
  } finally {
    try {
      stopSfx("loading");
    } catch {}

    if (abortController.value === abort) abortController.value = null;
    sending.value = false;
    cancelCurrent = null;
  }
}

/* -------------------------------------------------
 * Persistence (autosave)
 * ------------------------------------------------- */
watch(
  () => state,
  () => scheduleSave(state),
  { deep: true }
);
</script>

<template>
  <Settings :open="showSettings" @update:open="showSettings = $event" />

  <div class="app-shell">
    <!-- ============ SIDEBAR ============ -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand__dot" />
        <span>{{ appearance.assistantName.toUpperCase() }}</span>
      </div>
      <div class="brand__project">Aktiv · {{ activeProject?.name }}</div>

      <div class="side-actions">
        <button class="btn-ghost" type="button" @click="newChat" title="Neuer Chat">+ Chat</button>
        <button class="btn-ghost" type="button" @click="addProject" title="Neues Projekt">+ Projekt</button>
      </div>

      <JarvisHud embedded />

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
          @click="openProject(p.id)"
        >
          <span class="project-item__name">{{ p.name }}</span>
          <span class="project-item__id">{{ p.id }}</span>
        </button>
      </div>

      <div class="side-settings">
        <button class="settings-btn" type="button" @click="showSettings = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="M10 12a2 2 0 1 1 4 0v1" />
            <path d="M9 13h6v4H9z" />
          </svg>
          Settings
        </button>
      </div>
    </aside>

    <!-- ============ MAIN ============ -->
    <main class="main-col">
      <!-- Header -->
      <div class="header">
        <div class="header__title">{{ activeProject?.name }}</div>

        <button
          type="button"
          class="mode-toggle"
          :class="`is-${mode}`"
          @click="toggleMode"
          :title="modeTitle"
        >
          <span class="mode-toggle__dot" />
          {{ modeLabel }}
        </button>

        <button
          type="button"
          class="icon-btn"
          :class="{ 'is-on': showContext }"
          @click="showContext = !showContext"
          title="Projektziele & Zusammenfassungen"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </button>

        <button
          type="button"
          class="icon-btn"
          :class="{ 'is-on': showAudit }"
          @click="showAudit = !showAudit"
          title="Tool-Protokoll"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="8" y1="18" x2="20" y2="18" />
            <circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" />
          </svg>
        </button>

        <button type="button" class="icon-btn icon-btn--danger" @click="newChat" title="Neuer Chat / Reset">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
              {{ goalStats.done }}/{{ goalStats.total }} erledigt · {{ goalStats.inProgress }} aktiv · {{ goalStats.open }} offen
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
            <div v-for="s in projectSummaries" :key="s.id ?? (s.createdAt ?? s.ts)" class="summary-row">
              {{ s.text ?? s.summary ?? s.content ?? "" }}
              <time>{{ fmtTime(s.createdAt ?? s.ts ?? Date.now()) }}</time>
            </div>
          </div>
          <div v-else class="empty">Noch keine Summaries.</div>
        </div>
      </div>

      <!-- Messages -->
      <div id="messages" class="messages">
       <div class="thread">
        <div v-if="!messages.length" class="chat-empty">
          <div class="chat-empty__orb"></div>
          <div class="chat-empty__kicker">{{ appearance.assistantName }}</div>
          <div class="chat-empty__title">Bereit für die nächste Aufgabe.</div>
          <div class="chat-empty__text">Schreibe direkt los oder nutze Push-to-Talk. Kontext und Memory werden automatisch schlank in den Prompt gelegt.</div>
        </div>

        <div
          v-for="m in messages"
          :key="m.id"
          class="msg"
          :class="m.role === 'user' ? 'msg--user' : 'msg--assistant'"
        >
          <div class="msg__meta">
            <span class="msg__role">{{ m.role === 'user' ? 'Du' : appearance.assistantName }}</span>
            <span class="msg__time">{{ fmtTime(m.ts) }}</span>
            <span
              v-if="m.role === 'user' && (m as any)?.meta?.inputSource && (m as any).meta.inputSource !== 'keyboard'"
              class="msg__badge"
              :title="(m as any).meta.inputSource === 'hands_free' ? 'Freihändig diktiert' : 'Per Push-to-Talk gesprochen'"
            >🎤 Gesprochen</span>
            <span
              v-if="m.role === 'assistant' && ((m as any)?.meta?.model || (m as any)?.meta?.provider)"
              class="msg__model"
              :title="'Use-Case: ' + ((m as any)?.meta?.useCase || '—')"
            >{{ (m as any).meta.provider }}<template v-if="(m as any).meta.model"> · {{ (m as any).meta.model }}</template></span>
            <button
              v-if="m.role === 'assistant' && m.content && m.content.trim()"
              type="button"
              class="speak-btn"
              @click.stop="speakMessage(m)"
              title="Vorlesen"
            >🔊</button>
            <button v-if="m.role === 'assistant' && (m as any)?.meta?.llmRequestId" type="button" class="feedback-btn" :class="{ 'is-on': (m as any)?.meta?.userFeedback === 1 }" @click.stop="rateAssistantMessage(m, 1)" title="Hilfreich">↑</button>
            <button v-if="m.role === 'assistant' && (m as any)?.meta?.llmRequestId" type="button" class="feedback-btn" :class="{ 'is-on is-negative': (m as any)?.meta?.userFeedback === -1 }" @click.stop="rateAssistantMessage(m, -1)" title="Nicht hilfreich">↓</button>
          </div>

          <div class="bubble">
            <template v-if="m.role === 'assistant'">
              <div v-if="(m as any)?.meta?.isLoading && !(m.content && m.content.trim())" class="typing">
                <i></i><i></i><i></i>
              </div>
              <p v-else class="answer__summary">{{ m.content
                }}<span v-if="(m as any)?.meta?.isLoading" class="stream-caret"></span></p>

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
                >{{ b }}</button>
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
          <div
            v-for="a in toolAudit"
            :key="a.id"
            class="audit-row"
            :class="a.ok ? 'is-ok' : 'is-fail'"
          >
            <span class="audit-row__status" />
            <span class="audit-row__tool">{{ a.name }}<template v-if="a.error"> — {{ a.error }}</template><template v-else-if="a.result"> — {{ a.result }}</template></span>
            <span class="audit-row__verdict">{{ a.ok ? 'OK' : 'FAIL' }}</span>
            <span class="audit-row__time">{{ fmtTime(a.ts, true) }}</span>
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
          <pre class="approval__args">{{ toolArgsPreview(call.args) }}</pre>
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
        <span class="listen-bar__text">{{ lastHeard || "…" }}</span>
      </div>

      <!-- Composer -->
      <div class="composer">
        <textarea
          ref="composerRef"
          class="composer__input"
          v-model="input"
          rows="1"
          placeholder="Nachricht an Luczor…"
          @input="autoGrow"
          @keydown.enter.exact.prevent="send"
        />
        <button
          type="button"
          class="mic-btn listen-btn"
          :class="{ 'is-listening': listening }"
          @click="toggleListening"
          :title="listening ? 'Dauer-Zuhören stoppen' : 'Dauer-Zuhören / Wake-Word starten'"
        >
          <svg v-if="!listening" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 0 1 18 0" /><path d="M7 12a5 5 0 0 1 10 0" /><circle cx="12" cy="12" r="1.6" />
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
          @click="togglePushToTalk"
          :title="isRecording ? 'Aufnahme stoppen' : 'Push-to-talk'"
        >
          <svg v-if="!isRecording" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
        <button
          type="button"
          class="send-btn"
          :disabled="sending || !input.trim()"
          @click="send"
          title="Senden"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="6 11 12 5 18 11" />
          </svg>
        </button>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* ============ SIDEBAR ============ */
.sidebar {
  position: relative;
  display: flex; flex-direction: column;
  padding: var(--s4);
  background: var(--surface-1);
  backdrop-filter: blur(var(--blur)) saturate(130%);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}
.sidebar::before {
  content: ""; position: absolute; top: 0; left: 12%; right: 12%; height: 1px;
  background: linear-gradient(90deg, transparent, var(--cy), transparent);
  opacity: 0.6;
}
.brand {
  display: flex; align-items: center; gap: var(--s2);
  font-family: var(--font-mono);
  font-size: 18px; letter-spacing: 0.22em;
  color: var(--text-primary); text-shadow: var(--glow-text);
}
.brand__dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: radial-gradient(circle at 45% 40%, var(--cy-soft), var(--cy) 55%, transparent 72%);
  box-shadow: var(--glow-md);
  animation: pulse-core 3.2s var(--ease-soft) infinite;
}
.brand__project {
  margin-top: var(--s1);
  font-family: var(--font-mono);
  font-size: var(--fs-label); letter-spacing: var(--track-label);
  text-transform: uppercase; color: var(--text-muted);
}

.side-actions { display: flex; gap: var(--s2); margin: var(--s4) 0; }
.btn-ghost {
  flex: 1;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 38px; padding: 0 var(--s3);
  font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; letter-spacing: 0.04em;
  color: var(--text-secondary);
  background: var(--cy-08);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur),
              box-shadow var(--dur), background var(--dur), transform var(--dur-fast);
}
.btn-ghost:hover {
  color: var(--text-primary); background: var(--cy-12);
  border-color: var(--border-strong); box-shadow: var(--glow-xs);
  transform: translateY(-1px);
}
.btn-ghost:active { transform: translateY(0); background: var(--cy-16); }

.side-listhead {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: var(--s2);
}
.side-count { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-faint); }

.project-list {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
  margin: 0 calc(-1 * var(--s2)); padding: 0 var(--s2);
}
.project-item {
  position: relative;
  display: flex; flex-direction: column; gap: 2px;
  padding: 10px 12px 10px 16px;
  border-radius: var(--r-md);
  border: 1px solid transparent;
  background: transparent;
  text-align: left; cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur), transform var(--dur-fast);
}
.project-item__name { font-size: 13.5px; font-weight: 600; color: var(--text-secondary); }
.project-item__id   { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-faint); }
.project-item:hover {
  background: var(--surface-2); border-color: var(--border-soft);
  transform: translateX(2px);
}
.project-item:hover .project-item__name { color: var(--text-primary); }
.project-item::before {
  content: ""; position: absolute; left: 5px; top: 50%;
  width: 3px; height: 0; transform: translateY(-50%);
  border-radius: var(--r-pill);
  background: linear-gradient(180deg, var(--cy-soft), var(--cy));
  box-shadow: var(--glow-xs);
  transition: height var(--dur) var(--ease);
}
.project-item.is-active {
  background: linear-gradient(90deg, var(--cy-16), var(--cy-04) 65%);
  border-color: var(--border);
  box-shadow: var(--glow-sm), inset 0 0 20px rgba(34,211,238,0.06);
}
.project-item.is-active::before { height: 60%; }
.project-item.is-active .project-item__name { color: var(--cy-soft); text-shadow: var(--glow-text); }

.side-settings { margin-top: var(--s3); padding-top: var(--s3); border-top: 1px solid var(--border-hair); }
.settings-btn {
  width: 100%;
  display: flex; align-items: center; gap: var(--s2);
  padding: 10px 12px;
  font-family: var(--font-mono); font-size: var(--fs-sm); letter-spacing: 0.04em;
  color: var(--text-secondary);
  background: transparent; border: 1px solid var(--border-hair); border-radius: var(--r-md);
  cursor: pointer;
  transition: color var(--dur), background var(--dur), border-color var(--dur);
}
.settings-btn:hover { color: var(--cy-soft); background: var(--surface-2); border-color: var(--border-soft); }

/* ============ MAIN COLUMN ============ */
.main-col {
  display: flex; flex-direction: column; min-width: 0;
  background: var(--surface-1);
  backdrop-filter: blur(var(--blur)) saturate(130%);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}
.header {
  display: flex; align-items: center; gap: var(--s3);
  padding: var(--s4) var(--s5);
  border-bottom: 1px solid var(--border-hair);
  background: linear-gradient(180deg, var(--glass-wash), transparent);
}
.header__title {
  flex: 1; min-width: 0;
  font-size: var(--fs-title); font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 0 12px rgba(56,189,248,0.20);
}

.mode-toggle {
  display: inline-flex; align-items: center; gap: 8px;
  height: 36px; padding: 0 14px 0 12px;
  border-radius: var(--r-pill);
  font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  cursor: pointer; user-select: none;
  border: 1px solid var(--border-soft);
  transition: background var(--dur-morph) var(--ease), border-color var(--dur-morph),
              color var(--dur-morph), box-shadow var(--dur-morph);
}
.mode-toggle__dot { width: 9px; height: 9px; border-radius: 50%; transition: background var(--dur-morph), box-shadow var(--dur-morph); }
.mode-toggle.is-observe { background: rgba(120,150,168,0.10); border-color: rgba(150,180,196,0.26); color: var(--text-secondary); }
.mode-toggle.is-observe .mode-toggle__dot { background: var(--text-muted); box-shadow: 0 0 0 3px rgba(107,142,166,0.14); }
.mode-toggle.is-act {
  background: var(--success-wash); border-color: rgba(52,211,153,0.5); color: var(--success-soft);
  box-shadow: var(--glow-success), inset 0 0 14px rgba(52,211,153,0.08);
}
.mode-toggle.is-act .mode-toggle__dot { background: var(--success); box-shadow: 0 0 10px var(--success); animation: pulse-dot 1.8s var(--ease-soft) infinite; }
.mode-toggle.is-unrestricted {
  background: var(--danger-wash); border-color: rgba(244,63,94,0.6); color: var(--danger-soft);
  box-shadow: var(--glow-danger), inset 0 0 14px rgba(244,63,94,0.08);
}
.mode-toggle.is-unrestricted .mode-toggle__dot { background: var(--danger); box-shadow: 0 0 10px var(--danger); animation: pulse-dot 1.1s var(--ease-soft) infinite; }

.mode-warning {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 7px var(--s5);
  font-family: var(--font-mono); font-size: var(--fs-label); font-weight: 700; letter-spacing: 0.06em;
  color: var(--danger-soft);
  background: linear-gradient(90deg, transparent, var(--danger-wash), transparent);
  border-bottom: 1px solid rgba(244,63,94,0.4);
  animation: pulse-soft 1.6s var(--ease-soft) infinite;
}

.icon-btn {
  display: inline-grid; place-items: center;
  width: 36px; height: 36px;
  color: var(--text-secondary);
  background: var(--cy-08);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: color var(--dur), background var(--dur), border-color var(--dur), box-shadow var(--dur), transform var(--dur-fast);
}
.icon-btn:hover { color: var(--cy-soft); background: var(--cy-12); border-color: var(--border-strong); box-shadow: var(--glow-xs); transform: translateY(-1px); }
.icon-btn:active { transform: translateY(0); }
.icon-btn.is-on { color: var(--cy-bright); background: var(--cy-16); border-color: var(--border-strong); box-shadow: var(--glow-sm), inset 0 0 12px rgba(56,189,248,0.15); }
.icon-btn--danger:hover { color: var(--danger-soft); background: var(--danger-wash); border-color: rgba(244,63,94,0.5); box-shadow: var(--glow-danger); }

/* ============ INFO STRIP ============ */
.info-strip {
  display: grid; grid-template-columns: 1.4fr 1fr; gap: var(--s4);
  padding: var(--s4) var(--s5);
  border-bottom: 1px solid var(--border-hair);
}
.info-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); margin-bottom: var(--s3); }
.info-stat { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-muted); }
.goal-cards { display: flex; flex-wrap: wrap; gap: var(--s2); }
.goal-card {
  flex: 1 1 180px;
  display: flex; align-items: center; justify-content: space-between; gap: var(--s3);
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  transition: border-color var(--dur), box-shadow var(--dur), transform var(--dur);
}
.goal-card:hover { border-color: var(--border); box-shadow: var(--glow-xs); transform: translateY(-1px); }
.goal-card__text { font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.4; }

.summaries { display: flex; flex-direction: column; gap: 6px; }
.summary-row {
  padding: 8px 11px; font-size: var(--fs-sm); line-height: 1.45; color: var(--text-secondary);
  background: var(--bg-sunken);
  border-left: 2px solid var(--border);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
}
.summary-row time { display: block; margin-top: 2px; font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-faint); }

.empty {
  padding: 10px 12px; font-size: var(--fs-sm); color: var(--text-muted);
  border: 1px dashed var(--border-hair); border-radius: var(--r-md);
}

/* ---- badges ---- */
.badge {
  flex: none;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px;
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase;
  border-radius: var(--r-pill); border: 1px solid transparent;
}
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; }
.badge.open { color: var(--text-muted); background: rgba(150,180,196,0.08); border-color: rgba(150,180,196,0.22); }
.badge.open::before { background: var(--text-muted); }
.badge.in_progress { color: var(--energy-bright); background: var(--energy-wash); border-color: var(--energy-border); }
.badge.in_progress::before { background: var(--energy-bright); box-shadow: 0 0 8px var(--energy); animation: pulse-dot 1.6s var(--ease-soft) infinite; }
.badge.blocked { color: var(--danger-soft); background: var(--danger-wash); border-color: rgba(244,63,94,0.35); }
.badge.blocked::before { background: var(--danger-soft); }
.badge.done { color: var(--success-soft); background: var(--success-wash); border-color: rgba(52,211,153,0.4); }
.badge.done::before { background: var(--success-soft); box-shadow: 0 0 8px var(--success); }

/* ============ MESSAGES ============ */
.messages {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column;
  padding: var(--s5) clamp(16px, 4vw, 40px) var(--s4);
  scroll-behavior: smooth;
}
.messages::before { content: ""; margin-top: auto; } /* bottom-anchor short threads */

/* Centered reading column keeps long answers legible on wide panels. */
.thread {
  width: 100%; max-width: 780px; margin-inline: auto;
  display: flex; flex-direction: column; gap: var(--s6);
}

.chat-empty {
  width: 100%; max-width: 520px;
  align-self: center; margin: auto 0;
  padding: var(--s6) var(--s5);
  text-align: center;
}
.chat-empty__orb {
  width: 60px; height: 60px; margin: 0 auto var(--s4); border-radius: 50%;
  background: radial-gradient(circle at 42% 38%, var(--cy-soft), var(--cy) 52%, transparent 72%);
  box-shadow: var(--glow-md);
  animation: pulse-core 3.6s var(--ease-soft) infinite;
}
.chat-empty__kicker {
  font-family: var(--font-mono);
  font-size: var(--fs-label);
  letter-spacing: var(--track-label);
  text-transform: uppercase;
  color: var(--cy-soft);
}
.chat-empty__title {
  margin-top: 8px;
  font-size: 22px; font-weight: 700; letter-spacing: -0.01em;
  color: var(--text-primary);
}
.chat-empty__text {
  margin-top: 10px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-muted);
}

.msg { display: flex; flex-direction: column; max-width: 100%; animation: msg-enter var(--dur) var(--ease) both; }
.msg__meta { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-muted); }
.msg__role { text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
.msg__badge { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border-soft); background: var(--cy-08); color: var(--cy-soft); font-size: 0.72em; letter-spacing: 0.04em; }
.msg__model { color: var(--text-faint); font-size: 0.74em; text-transform: none; letter-spacing: 0; }
.msg__time { font-variant-numeric: tabular-nums; color: var(--text-faint); }

.msg--user { align-self: flex-end; align-items: flex-end; max-width: 82%; }
.msg--user .msg__meta { flex-direction: row-reverse; }
.msg--user .bubble {
  padding: 10px 15px;
  font-size: var(--fs-body); line-height: 1.55; color: #eaf7ff;
  white-space: pre-wrap; word-break: break-word;
  background: linear-gradient(160deg, rgba(56,189,248,0.16), rgba(56,189,248,0.07));
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg) var(--r-lg) var(--r-xs) var(--r-lg);
  box-shadow: var(--shadow-1);
}

/* Assistant answers read as open, calm text in a light card — no idle motion. */
.msg--assistant { align-self: stretch; align-items: flex-start; }
.msg--assistant .msg__role { color: var(--cy-soft); }
.msg--assistant .bubble {
  padding: 13px 18px;
  font-size: var(--fs-body); line-height: var(--lh-body); color: var(--text-primary);
  background: var(--surface-1);
  border: 1px solid var(--border-hair);
  border-radius: var(--r-xs) var(--r-lg) var(--r-lg) var(--r-lg);
  box-shadow: var(--shadow-1);
}

/* Per-message actions stay hidden until hover to keep the thread quiet. */
.speak-btn, .feedback-btn { opacity: 0; }
.msg:hover .speak-btn, .msg:hover .feedback-btn,
.feedback-btn.is-on, .feedback-btn.is-negative { opacity: 1; }
.speak-btn {
  display: inline-grid; place-items: center;
  width: 24px; height: 24px;
  font-size: 12px; line-height: 1;
  color: var(--text-muted);
  background: transparent; border: 1px solid transparent; border-radius: var(--r-sm);
  cursor: pointer; transition: opacity var(--dur), color var(--dur), border-color var(--dur), background var(--dur);
}
.speak-btn:hover { color: var(--cy-soft); border-color: var(--border-soft); background: var(--cy-08); }
.feedback-btn { width: 24px; height: 24px; border-radius: var(--r-xs); border: 1px solid var(--border-hair); color: var(--text-muted); font-family: var(--font-mono); transition: opacity var(--dur), color var(--dur-fast), border-color var(--dur-fast), background var(--dur-fast); }
.feedback-btn:hover, .feedback-btn.is-on { color: var(--success); border-color: rgba(52,211,153,.4); background: var(--success-wash); }
.feedback-btn.is-negative { color: var(--danger); border-color: rgba(244,63,94,.4); background: var(--danger-wash); }

/* ---- structured answer ---- */
.answer__summary { color: var(--text-primary); white-space: pre-wrap; word-break: break-word; margin: 0; }
.answer__question {
  margin-top: var(--s3);
  padding: 10px 14px 10px 16px;
  font-size: var(--fs-body); font-weight: 600; color: var(--cy-soft);
  background: linear-gradient(90deg, var(--glass-wash), transparent);
  border: 1px solid var(--border-soft);
  border-left: 2px solid var(--cy);
  border-radius: var(--r-sm);
  line-height: 1.5;
}
.answer__question::before {
  content: "?"; margin-right: 8px;
  font-family: var(--font-mono); color: var(--cy-bright); text-shadow: var(--glow-text);
}

.chips { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); }
.chip {
  position: relative; overflow: hidden;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 7px 13px 7px 11px;
  font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 500;
  color: var(--cy-soft); text-align: left;
  background: var(--cy-08);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  cursor: pointer;
  transition: color var(--dur), background var(--dur), border-color var(--dur), box-shadow var(--dur), transform var(--dur-fast) var(--ease);
}
.chip::before { content: "›"; font-family: var(--font-mono); color: var(--cy); font-weight: 700; transition: transform var(--dur) var(--ease), color var(--dur); }
.chip::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(120deg, transparent 30%, rgba(103,232,249,0.22) 50%, transparent 70%);
  transform: translateX(-120%); transition: transform var(--dur-slow) var(--ease);
}
.chip:hover { color: #eaf7ff; background: var(--cy-12); border-color: var(--border-strong); box-shadow: var(--glow-sm); transform: translateY(-2px); }
.chip:hover::before { transform: translateX(2px); color: var(--cy-soft); }
.chip:hover::after { transform: translateX(120%); }
.chip:active { transform: translateY(0) scale(0.97); background: var(--cy-16); border-color: var(--cy-bright); box-shadow: inset 0 0 10px rgba(2,8,14,0.6), var(--glow-xs); }
.chip:focus-visible { outline: none; box-shadow: var(--focus-ring); }

.stream-caret {
  display: inline-block; width: 8px; height: 1.05em; margin-left: 2px; vertical-align: -2px;
  background: var(--cy-bright); border-radius: 1px; box-shadow: var(--glow-text);
  animation: caret-blink 1s steps(1) infinite;
}
.typing { display: inline-flex; gap: 5px; padding: 4px 0; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--cy-soft); box-shadow: var(--glow-xs); animation: typing-bounce 1.2s var(--ease-soft) infinite; }
.typing i:nth-child(2) { animation-delay: 0.15s; }
.typing i:nth-child(3) { animation-delay: 0.30s; }

/* ============ AUDIT ============ */
.audit {
  margin: 0 var(--s5) var(--s3);
  padding: var(--s3);
  background: linear-gradient(160deg, var(--surface-1), rgba(4,10,16,0.72));
  border: 1px solid var(--border-hair);
  border-radius: var(--r-md);
}
.audit__title { display: block; margin-bottom: var(--s2); }
.audit-list { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow-y: auto; }
.audit-row {
  display: grid; grid-template-columns: 10px 1fr auto auto; align-items: center; gap: 10px;
  padding: 7px 10px;
  font-family: var(--font-mono); font-size: var(--fs-meta);
  border-radius: var(--r-sm); border-left: 2px solid transparent;
  transition: background var(--dur) var(--ease);
}
.audit-row:hover { background: var(--surface-2); }
.audit-row__status { width: 8px; height: 8px; border-radius: 50%; }
.audit-row__tool { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.audit-row__verdict { font-size: 9.5px; letter-spacing: 0.1em; }
.audit-row__time { color: var(--text-faint); font-variant-numeric: tabular-nums; }
.audit-row.is-ok { border-left-color: rgba(52,211,153,0.55); }
.audit-row.is-ok .audit-row__status { background: var(--success); box-shadow: 0 0 8px var(--success); }
.audit-row.is-ok .audit-row__verdict { color: var(--success-soft); }
.audit-row.is-ok .audit-row__tool { color: var(--text-primary); }
.audit-row.is-fail { border-left-color: rgba(244,63,94,0.55); background: rgba(244,63,94,0.05); }
.audit-row.is-fail .audit-row__status { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
.audit-row.is-fail .audit-row__verdict { color: var(--danger-soft); }
.audit-row.is-fail .audit-row__tool { color: var(--danger-soft); }

/* ============ APPROVALS ============ */
.approvals { margin: 0 var(--s5) var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.approvals__title { display: block; color: var(--energy-bright); }
.approval {
  position: relative;
  padding: var(--s4);
  background:
    radial-gradient(120% 80% at 100% 0%, rgba(245,158,11,0.07), transparent 55%),
    var(--surface-glass);
  border: 1px solid var(--energy-border);
  border-radius: var(--r-lg);
  box-shadow: var(--glow-energy), var(--shadow-2);
  backdrop-filter: blur(12px);
  animation: msg-enter var(--dur-slow) var(--ease) both;
  overflow: hidden;
}
.approval::before {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--cy-bright), var(--cy-soft), transparent);
  background-size: 200% 100%;
  animation: edge-sweep 2.6s linear infinite;
}
.approval__head { display: flex; align-items: center; gap: 10px; margin-bottom: var(--s3); }
.approval__tool { font-family: var(--font-mono); font-size: var(--fs-body); font-weight: 600; color: var(--energy-bright); text-shadow: 0 0 12px rgba(245,158,11,0.5); }
.approval__cat {
  padding: 2px 9px;
  font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--cy-soft); background: var(--cy-12);
  border: 1px solid var(--border-soft); border-radius: var(--r-pill);
}
.approval__args {
  padding: 12px 14px; margin: 0 0 var(--s4);
  max-height: 200px; overflow: auto;
  font-family: var(--font-mono); font-size: var(--fs-meta); line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-sunken);
  border: 1px solid var(--border-hair); border-radius: var(--r-md);
  white-space: pre-wrap; word-break: break-word;
  box-shadow: inset 0 0 16px rgba(0,0,0,0.4);
}
.approval__actions { display: flex; gap: var(--s2); justify-content: flex-end; }
.btn-reject, .btn-exec {
  height: 38px; padding: 0 18px;
  font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 700; letter-spacing: 0.04em;
  border-radius: var(--r-sm); cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.btn-reject { color: var(--danger-soft); background: var(--danger-wash); border: 1px solid rgba(244,63,94,0.4); }
.btn-reject:hover { border-color: var(--danger); box-shadow: var(--glow-danger); transform: translateY(-1px); }
.btn-reject:active { transform: translateY(0); }
.btn-exec { color: var(--text-on-accent); background: linear-gradient(160deg, var(--success-soft), #1fae7f 75%); border: 1px solid rgba(52,211,153,0.6); box-shadow: var(--glow-success); }
.btn-exec:hover { transform: translateY(-1px); filter: brightness(1.06); box-shadow: var(--glow-success), var(--glow-md); }
.btn-exec:active { transform: translateY(0) scale(0.97); }

/* ============ LISTEN BAR ============ */
.listen-bar {
  display: flex; align-items: center; gap: 10px;
  margin: 0 auto;
  width: min(812px, calc(100% - 2 * var(--s5)));
  padding: 8px 14px;
  font-family: var(--font-mono); font-size: var(--fs-sm);
  color: var(--cy-soft);
  background: linear-gradient(90deg, var(--glass-wash), transparent);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md) var(--r-md) 0 0;
  border-bottom: none;
}
.listen-bar__dot {
  width: 9px; height: 9px; border-radius: 50%; flex: none;
  background: var(--cy-bright); box-shadow: 0 0 10px var(--cy-bright);
  animation: pulse-dot 1.1s var(--ease-soft) infinite;
}
.listen-bar__label { color: var(--text-label); letter-spacing: 0.08em; text-transform: uppercase; font-size: var(--fs-label); flex: none; }
.listen-bar__text { color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ============ COMPOSER ============ */
.composer {
  display: flex; align-items: flex-end; gap: var(--s2);
  padding: var(--s2) var(--s2) var(--s2) var(--s4);
  margin: var(--s3) auto var(--s5);
  width: min(812px, calc(100% - 2 * var(--s5)));
  background: var(--surface-2);
  backdrop-filter: blur(12px);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-2);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.composer:focus-within { border-color: var(--border); box-shadow: var(--focus-ring), var(--shadow-2); }
.composer__input {
  flex: 1; min-height: 24px; max-height: 160px;
  padding: 8px 6px; resize: none; border: none; outline: none; background: transparent;
  color: var(--text-primary); font-family: var(--font-ui); font-size: var(--fs-body); line-height: 1.5;
}
.composer__input::placeholder { color: var(--text-faint); }

.mic-btn {
  position: relative; flex: none;
  display: inline-grid; place-items: center;
  width: 40px; height: 40px; border-radius: var(--r-pill);
  color: var(--text-secondary);
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.mic-btn:hover { color: var(--cy-soft); border-color: var(--border); box-shadow: var(--glow-sm); }
.mic-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.mic-btn.is-recording {
  color: #fff;
  background: radial-gradient(circle, var(--danger) 0%, #c8455c 100%);
  border-color: rgba(244,63,94,0.7);
  box-shadow: var(--glow-danger);
  animation: mic-pulse 1.4s var(--ease-soft) infinite;
}
.mic-btn.is-recording::after {
  content: ""; position: absolute; inset: -4px; border-radius: var(--r-pill);
  border: 2px solid var(--danger); animation: mic-ping 1.4s var(--ease) infinite;
}
.listen-btn.is-listening {
  color: var(--text-on-accent);
  background: radial-gradient(circle, var(--cy-bright) 0%, var(--cy-deep) 100%);
  border-color: var(--border-strong);
  box-shadow: var(--glow-md);
  animation: pulse-soft 1.4s var(--ease-soft) infinite;
}
.listen-btn.is-listening::after {
  content: ""; position: absolute; inset: -4px; border-radius: var(--r-pill);
  border: 2px solid var(--cy); animation: mic-ping 1.6s var(--ease) infinite;
}

.send-btn {
  flex: none;
  display: inline-grid; place-items: center;
  width: 40px; height: 40px; border-radius: var(--r-pill);
  color: var(--text-on-accent);
  background: radial-gradient(circle at 40% 35%, var(--cy-soft), var(--cy) 55%, var(--cy-deep));
  border: 1px solid rgba(103,232,249,0.5);
  box-shadow: var(--glow-md);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease), box-shadow var(--dur), filter var(--dur);
}
.send-btn:hover { transform: translateY(-1px) scale(1.04); box-shadow: var(--glow-md), var(--glow-lg); }
.send-btn:active { transform: scale(0.96); }
.send-btn:disabled { cursor: not-allowed; filter: grayscale(0.6) brightness(0.6); box-shadow: none; color: var(--text-faint); background: var(--surface-3); border-color: var(--border-hair); }

@media (max-width: 900px) {
  .info-strip { grid-template-columns: 1fr; }
  .msg { max-width: 92%; }
}
</style>
