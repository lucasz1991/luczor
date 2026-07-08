// src/services/sfx.ts
type SfxKey = "submit" | "loading";

type SfxConfig = {
  src: string;
  volume?: number; // 0..1
  loop?: boolean;
};

const SOURCES: Record<SfxKey, SfxConfig> = {
  submit: {
    src: new URL("../assets/sfx/submit.wav", import.meta.url).toString(),
    volume: 0.1,
    loop: false,
  },
  loading: {
    src: new URL("../assets/sfx/loading.wav", import.meta.url).toString(),
    volume: 0.01,
    loop: true,
  },
};

const cache = new Map<SfxKey, HTMLAudioElement>();

function getAudio(key: SfxKey) {
  const existing = cache.get(key);
  if (existing) return existing;

  const cfg = SOURCES[key];
  const a = new Audio(cfg.src);
  a.preload = "auto";
  a.loop = !!cfg.loop;
  a.volume = cfg.volume ?? 0.1;

  cache.set(key, a);
  return a;
}

export async function playSfx(key: SfxKey, opts?: { volume?: number }) {
  const a = getAudio(key);

  // bei One-Shots immer von vorne starten
  if (!a.loop) a.currentTime = 0;

  if (typeof opts?.volume === "number") a.volume = Math.max(0, Math.min(1, opts.volume));

  try {
    await a.play();
  } catch (e) {
    // Wichtig: Audio kann ohne User-Gesture blockiert sein -> bewusst loggen
    console.warn(`[SFX] play blocked/failed for "${key}"`, e);
  }
}

export function stopSfx(key: SfxKey) {
  const a = cache.get(key);
  if (!a) return;
  a.pause();
  a.currentTime = 0;
}

export function setSfxVolume(key: SfxKey, volume: number) {
  const a = getAudio(key);
  a.volume = Math.max(0, Math.min(1, volume));
}

export function preloadSfx(keys: SfxKey[] = ["submit", "loading"]) {
  keys.forEach((k) => void getAudio(k));
}
