// src/services/appearance.ts
//
// Client-side personalization: accent theme, HUD position,
// reduced motion, background grid and the assistant's display name.
// Applied by writing CSS custom properties / data-attributes on <html>.

import { reactive } from "vue";
import { Store } from "@tauri-apps/plugin-store";

const FILE = "luczor.settings.json";

export type AccentName = "cyan" | "emerald" | "violet" | "amber" | "rose";
export type HudPosition = "br" | "bl" | "tr" | "tl";

type Accent = { base: [number, number, number]; bright: string; soft: string; deep: string };

const ACCENTS: Record<AccentName, Accent> = {
  cyan: { base: [56, 189, 248], bright: "#22d3ee", soft: "#67e8f9", deep: "#0e7fb8" },
  emerald: { base: [52, 211, 153], bright: "#34d399", soft: "#a7f3d0", deep: "#0f766e" },
  violet: { base: [139, 92, 246], bright: "#a78bfa", soft: "#c4b5fd", deep: "#5b21b6" },
  amber: { base: [245, 158, 11], bright: "#fbbf24", soft: "#fde68a", deep: "#b45309" },
  rose: { base: [244, 63, 94], bright: "#fb7185", soft: "#fda4af", deep: "#9f1239" },
};

export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

export const appearance = reactive({
  accent: "violet" as AccentName,
  hudVisible: true,
  hudPosition: "br" as HudPosition,
  reduceMotion: false,
  showGrid: true,
  uiScale: 1.0,
  assistantName: "Luczor",
});

function rgba(rgb: [number, number, number], a: number) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}
function rgbHex(rgb: [number, number, number]) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function applyAccent(name: AccentName) {
  const a = ACCENTS[name] ?? ACCENTS.cyan;
  const r = document.documentElement.style;
  r.setProperty("--cy", rgbHex(a.base));
  r.setProperty("--cy-bright", a.bright);
  r.setProperty("--cy-soft", a.soft);
  r.setProperty("--cy-deep", a.deep);
  r.setProperty("--cy-04", rgba(a.base, 0.04));
  r.setProperty("--cy-08", rgba(a.base, 0.08));
  r.setProperty("--cy-12", rgba(a.base, 0.12));
  r.setProperty("--cy-16", rgba(a.base, 0.16));
  r.setProperty("--cy-22", rgba(a.base, 0.22));
  r.setProperty("--border-soft", rgba(a.base, 0.14));
  r.setProperty("--border", rgba(a.base, 0.26));
  r.setProperty("--border-strong", rgba(a.base, 0.46));
  r.setProperty("--glass-wash", rgba(a.base, 0.06));
  r.setProperty("--glow-xs", `0 0 6px ${rgba(a.base, 0.35)}`);
  r.setProperty("--glow-sm", `0 0 12px ${rgba(a.base, 0.32)}`);
  r.setProperty("--glow-md", `0 0 22px ${rgba(a.base, 0.3)}, 0 0 4px ${rgba(a.base, 0.45)}`);
  r.setProperty("--glow-lg", `0 0 44px ${rgba(a.base, 0.34)}`);
  r.setProperty("--glow-text", `0 0 10px ${rgba(a.base, 0.55)}`);
  r.setProperty(
    "--focus-ring",
    `0 0 0 1px ${rgba(a.base, 0.55)}, 0 0 0 4px ${rgba(a.base, 0.14)}, 0 0 20px ${rgba(a.base, 0.35)}`
  );
}

export function applyAppearance() {
  applyAccent(appearance.accent);
  const root = document.documentElement;
  root.dataset.reduceMotion = appearance.reduceMotion ? "1" : "0";
  root.dataset.grid = appearance.showGrid ? "1" : "0";
  // Chromium (WebView2) supports `zoom` to scale the whole UI.
  (root.style as any).zoom = String(appearance.uiScale || 1);
}

export async function loadAppearance(): Promise<void> {
  try {
    const s = await Store.load(FILE);
    const acc = await s.get<string>("ui_accent");
    if (acc && (ACCENT_NAMES as string[]).includes(acc)) appearance.accent = acc as AccentName;
    appearance.hudVisible = true;
    const hp = await s.get<string>("ui_hud_position");
    if (hp === "br" || hp === "bl" || hp === "tr" || hp === "tl") appearance.hudPosition = hp;
    const rm = await s.get<boolean>("ui_reduce_motion");
    if (typeof rm === "boolean") appearance.reduceMotion = rm;
    const sg = await s.get<boolean>("ui_show_grid");
    if (typeof sg === "boolean") appearance.showGrid = sg;
    const sc = await s.get<number>("ui_scale");
    if (typeof sc === "number" && !Number.isNaN(sc)) appearance.uiScale = Math.max(0.8, Math.min(1.4, sc));
    const an = await s.get<string>("assistant_name");
    if (an && an.trim()) appearance.assistantName = an.trim();
  } catch {
    /* ignore */
  }
  applyAppearance();
}
