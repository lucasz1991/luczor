// src/state/hud.ts
//
// Ephemeral (non-persisted) UI/telemetry state that drives the JARVIS HUD:
//  - overall assistant status,
//  - live microphone level,
//  - decaying activity pulses for audio / network / file / os channels,
//  - the global kill switch that hard-stops all tool execution.
//
// This is deliberately separate from the persisted AppState so the HUD can
// animate every frame without triggering autosave.

import { reactive } from "vue";

export type HudStatus =
  | "idle"
  | "listening"
  | "thinking"
  | "executing"
  | "speaking"
  | "error";

export type ActivityChannel = "audio" | "network" | "file" | "os";

export const hud = reactive({
  status: "idle" as HudStatus,
  /** 0..1 microphone RMS level while recording. */
  micLevel: 0,
  /** When true, no tool executes — a hard, user-controlled stop. */
  killSwitch: false,
  /** Last executed/attempted tool name (for the HUD ticker). */
  lastTool: "",
  /** Decaying 0..1 pulses per channel. */
  activity: {
    audio: 0,
    network: 0,
    file: 0,
    os: 0,
  } as Record<ActivityChannel, number>,
});

let rafId = 0;
let running = false;

function frame() {
  const a = hud.activity;
  a.audio *= 0.9;
  a.network *= 0.9;
  a.file *= 0.9;
  a.os *= 0.9;
  if (a.audio < 0.001) a.audio = 0;
  if (a.network < 0.001) a.network = 0;
  if (a.file < 0.001) a.file = 0;
  if (a.os < 0.001) a.os = 0;
  rafId = requestAnimationFrame(frame);
}

/** Start the decay animation loop (idempotent). */
export function startHud() {
  if (running) return;
  running = true;
  rafId = requestAnimationFrame(frame);
}

export function stopHud() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  running = false;
}

export function setStatus(s: HudStatus) {
  hud.status = s;
}

export function setMicLevel(v: number) {
  hud.micLevel = Math.max(0, Math.min(1, v));
}

/** Fire a pulse on a channel (0..1). Used to light up the HUD rings. */
export function pulse(channel: ActivityChannel, value = 1) {
  hud.activity[channel] = Math.max(hud.activity[channel], Math.min(1, value));
}

export function setKillSwitch(on: boolean) {
  hud.killSwitch = on;
}

export function setLastTool(name: string) {
  hud.lastTool = name;
}
