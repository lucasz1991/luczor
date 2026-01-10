import type { AppState } from "@/state/types";
import { DEFAULT_STATE } from "@/state/defaults";

// Für Desktop: implementierst du hier später File-IO (Electron/Tauri).
// Für jetzt: localStorage als “lokal, ohne SQL”.
const KEY = "luczor_app_state_v1";

export async function loadState(): Promise<AppState> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return structuredClone(DEFAULT_STATE);
  try {
    return JSON.parse(raw) as AppState;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export async function saveState(state: AppState): Promise<void> {
  localStorage.setItem(KEY, JSON.stringify(state));
}
