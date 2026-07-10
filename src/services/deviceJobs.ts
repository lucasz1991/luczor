import Pusher from "pusher-js";
import { invoke } from "@tauri-apps/api/core";
import { LuczorApi, getApiConfig, type DeviceJob } from "@/services/api/luczorApi";

let stop: (() => void) | null = null;
const inFlight = new Set<string>();

export async function startDeviceJobChannel(): Promise<() => void> {
  stop?.();
  const config = await getApiConfig();
  if (!config.deviceKey) throw new Error("Ein Device-Key ist für den Gerätekanal erforderlich.");
  const registration = await LuczorApi.registerDevice(config.clientId, deviceName());
  const bootstrap = await LuczorApi.bootstrap();
  const realtime = bootstrap.realtime;
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
  channel.bind("device.job.created", (job: DeviceJob) => void processJob(config.clientId, job));
  void pullPending(config.clientId);
  const timer = window.setInterval(() => void pullPending(config.clientId), 20_000);
  stop = () => {
    window.clearInterval(timer);
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
  if (inFlight.has(job.id) || new Date(job.expires_at ?? 0).getTime() < Date.now()) return;
  inFlight.add(job.id);
  try {
    await invoke("verify_device_job", { payload: job });
    if (job.status === "approval_required") {
      const approved = window.confirm(`Remote action: ${job.tool_profile}`);
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
    default:
      throw new Error(`Unsupported signed tool profile: ${job.tool_profile}`);
  }
}

function deviceName(): string {
  return `Luczor ${navigator.platform || "desktop"}`.slice(0, 120);
}
