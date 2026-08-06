import Pusher from "pusher-js";
import { invoke } from "@tauri-apps/api/core";
import { LuczorApi, getApiConfig, type DeviceJob } from "@/services/api/luczorApi";
import { runAgentCli } from "@/services/agents";
import {
  catchUpPushNotifications,
  handleRealtimeNotification,
  REALTIME_NOTIFICATION_EVENT,
} from "@/services/notifications";
import { isWorkflowTaskBundle, runWorkflowTask, type WorkflowTaskPrimitives } from "@/services/workflowTaskRunner";

let stop: (() => void) | null = null;
const inFlight = new Set<string>();

export async function startDeviceJobChannel(): Promise<() => void> {
  stop?.();
  const config = await getApiConfig();
  if (!config.deviceKey) throw new Error("Ein Device-Key ist für den Gerätekanal erforderlich.");
  const registration = await LuczorApi.registerDevice(config.clientId, deviceName());
  const realtime = (await LuczorApi.realtimeConfig()).data;
  if (!realtime?.key) throw new Error("Der Reverb-Gerätekanal ist auf dem Server nicht konfiguriert.");

  const endpoint = new URL(config.baseUrl);
  const host = realtime.host || endpoint.hostname;
  const secure = (realtime.scheme ?? endpoint.protocol.replace(":", "")) === "https";
  const port = realtime.port || Number(endpoint.port || (secure ? 443 : 80));
  const channelName = `private-device.${config.clientId}`;
  const pusher = new Pusher(realtime.key, {
    cluster: "mt1",
    wsHost: host,
    wsPort: port,
    wssPort: port,
    forceTLS: secure,
    enabledTransports: secure ? ["wss"] : ["ws"],
    channelAuthorization: {
      customHandler: async ({ socketId, channelName: requestedChannel }, callback) => {
        try {
          const auth = await LuczorApi.reverbAuth(socketId, requestedChannel, config.clientId, registration.session.token);
          callback(null, auth);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)), null);
        }
      },
    },
  });
  const channel = pusher.subscribe(channelName);

  const syncNotifications = () => {
    void catchUpPushNotifications().catch(error =>
      console.warn("[notifications] catch-up failed", error)
    );
  };
  const syncWhenVisible = () => {
    if (document.visibilityState === "visible") syncNotifications();
  };
  channel.bind("device.job.created", (job: DeviceJob) => void processJob(config.clientId, job));
  channel.bind(REALTIME_NOTIFICATION_EVENT, (payload: unknown) => {
    void handleRealtimeNotification(payload).finally(syncNotifications);
  });
  pusher.connection.bind("connected", syncNotifications);
  window.addEventListener("online", syncNotifications);
  document.addEventListener("visibilitychange", syncWhenVisible);

  syncNotifications();
  void pullPending(config.clientId);
  const timer = window.setInterval(() => void pullPending(config.clientId), 20_000);
  stop = () => {
    window.clearInterval(timer);
    pusher.connection.unbind("connected", syncNotifications);
    window.removeEventListener("online", syncNotifications);
    document.removeEventListener("visibilitychange", syncWhenVisible);
    pusher.unsubscribe(channelName);
    pusher.disconnect();
    stop = null;
  };
  return stop;
}

async function pullPending(clientId: string): Promise<void> {
  try {
    const response = await LuczorApi.nextDeviceJob(clientId);
    if (response.data) await processJob(clientId, response.data);
  } catch (error) {
    console.warn("[device-jobs] poll failed", error);
  }
}

async function processJob(clientId: string, job: DeviceJob): Promise<void> {
  // A null/absent expiry means "no expiry" — treat it as far in the future,
  // not epoch 0 (which would silently drop every job without an expires_at).
  const expiresAt = job.expires_at ? new Date(job.expires_at).getTime() : Number.POSITIVE_INFINITY;
  if (inFlight.has(job.id) || expiresAt < Date.now()) return;
  inFlight.add(job.id);
  try {
    await invoke("verify_device_job", { payload: job });
    if (job.status === "approval_required") {
      const approved = window.confirm(approvalPrompt(job));
      await LuczorApi.approveDeviceJob(job.id, clientId, approved, approved ? undefined : "Rejected on local device");
      if (!approved) return;
    }
    await LuczorApi.startDeviceJob(job.id, clientId);
    try {
      const result = await executeProfile(job);
      await LuczorApi.completeDeviceJob(job.id, clientId, true, result);
    } catch (error) {
      await LuczorApi.completeDeviceJob(job.id, clientId, false, undefined, error instanceof Error ? error.message : String(error));
    }
  } finally {
    inFlight.delete(job.id);
  }
}

async function executeProfile(job: DeviceJob): Promise<Record<string, unknown>> {
  const payload = job.payload;
  switch (job.tool_profile) {
    case "desktop.capture_screen": {
      const shot = await invoke<{ width: number; height: number }>("capture_screen");
      return { captured: true, width: shot.width, height: shot.height };
    }
    case "desktop.clipboard.read": {
      const text = await invoke<string>("read_clipboard");
      return { length: text.length };
    }
    case "desktop.windows.list": {
      const windows = await invoke<unknown[]>("list_windows");
      return { count: windows.length };
    }
    case "desktop.input.move_mouse":
      await invoke("move_mouse", { payload: { x: Number(payload.x), y: Number(payload.y) } });
      return { ok: true };
    case "desktop.input.click":
      await invoke("mouse_click", { payload });
      return { ok: true };
    case "desktop.input.type_text":
      await invoke("type_text", { payload: { text: String(payload.text ?? "") } });
      return { ok: true };
    case "desktop.input.press_key":
      await invoke("press_key", { payload: { key: String(payload.key ?? "") } });
      return { ok: true };
    case "desktop.open_url":
      await invoke("open_url", { payload: { url: String(payload.url ?? "") } });
      return { ok: true };
    // SOLL §14 P15b — a workflow client task compiled into a bundle.
    case "workflow.task": {
      if (!isWorkflowTaskBundle(payload)) throw new Error("Malformed workflow.task bundle.");
      return runWorkflowTask(payload, WORKFLOW_TASK_PRIMITIVES);
    }
    default:
      throw new Error(`Unsupported signed tool profile: ${job.tool_profile}`);
  }
}

/** Real, Tauri-backed effects for workflow client tasks (see workflowTaskRunner). */
const WORKFLOW_TASK_PRIMITIVES: WorkflowTaskPrimitives = {
  openUrl: (url) => invoke("open_url", { payload: { url } }),
  httpFetch: async (method, url, headers, body) => {
    // The Tauri webview's fetch reaches the network directly; the request was
    // vetted server-side (catalogued task) and re-checked for http(s) here.
    const response = await fetch(url, { method, headers, body: body ?? undefined });
    const text = await response.text();
    return { status: response.status, ok: response.ok, body: text };
  },
  runAgent: (agent, prompt, projectDir) => runAgentCli(agent as "claude" | "codex", prompt, projectDir),
  fileRead: (path) => invoke("wf_file_read", { payload: { path } }),
  fileWrite: (path, content) => invoke("wf_file_write", { payload: { path, content } }),
  runScript: (runtime, code, timeoutSeconds) =>
    invoke("wf_run_script", { payload: { runtime, code, timeout_seconds: timeoutSeconds ?? null } }),
  browserOpen: (url) => invoke("browser_open", { payload: { url: url ?? null } }),
  browserClick: (selector) => invoke("browser_click", { payload: { selector } }),
  browserRead: (selector) => invoke("browser_read", { payload: { selector: selector ?? null } }),
};

/** A human-readable approval line; workflow bundles name the concrete task. */
function approvalPrompt(job: DeviceJob): string {
  if (job.tool_profile === "workflow.task" && isWorkflowTaskBundle(job.payload)) {
    const wf = job.payload.workflow;
    return `Workflow-Aktion: ${job.payload.task_key}\nSchritt „${wf?.step_key ?? "?"}" · Lauf ${wf?.run ?? "?"}\n\nAusführen?`;
  }
  return `Remote action: ${job.tool_profile}`;
}

function deviceName(): string {
  return `Luczor ${navigator.platform || "desktop"}`.slice(0, 120);
}
