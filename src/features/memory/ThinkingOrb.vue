<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { paintFrame } from '@/vendor/thinking-orbs/engine/core'
import { frameRibbon } from '@/vendor/thinking-orbs/engine/ribbon'
import { frameGlobe, frameWave } from '@/vendor/thinking-orbs/engine/lattice'
import { BASE_PROFILES, scaleCounts, scaleRadii, type ModeOpts } from '@/vendor/thinking-orbs/engine/profiles'
import type { ModeFrame } from '@/vendor/thinking-orbs/engine/types'

/**
 * The RailTime assistant orb: a dotted, honestly-3D particle cloud (Thinking Orbs, MIT,
 * Jakub Antalik – see src/vendor/thinking-orbs) drawn on a 2D canvas. States are public
 * runtime states, not invented reasoning stages; a change cross-fades over 650 ms.
 */
export type ThinkingOrbState = 'idle' | 'thinking' | 'listening' | 'speaking' | 'curious' | 'happy' | 'wave' | 'offline'

const props = withDefaults(
  defineProps<{ state?: ThinkingOrbState; size?: number; dark?: boolean; still?: boolean }>(),
  { state: 'idle', size: 96, dark: true, still: false }
)

const TRANSITION_MS = 650
type Mode = 'ribbon' | 'globe' | 'wave'
const STATES: Record<ThinkingOrbState, { mode: Mode; pace: number }> = {
  idle: { mode: 'ribbon', pace: 0.45 },
  thinking: { mode: 'ribbon', pace: 1 },
  listening: { mode: 'wave', pace: 1 },
  speaking: { mode: 'wave', pace: 0.85 },
  curious: { mode: 'globe', pace: 0.65 },
  happy: { mode: 'ribbon', pace: 1.15 },
  wave: { mode: 'ribbon', pace: 0.8 },
  offline: { mode: 'ribbon', pace: 0 },
}
// Upstream presets, tuned for the avatar (64) and launcher (32) sizes.
const PRESETS: Record<Mode, Record<32 | 64, { speed: number; count: number; size: number; extra?: ModeOpts }>> = {
  ribbon: {
    64: { speed: 2.34, count: 0.25, size: 0.85, extra: { spin: 0, bandMul: 3.9, wobMul: 1 } },
    32: { speed: 2.7776, count: 0.0969, size: 0.9766, extra: { spin: 0, bandMul: 4.49, wobMul: 1 } },
  },
  globe: {
    64: { speed: 2.015, count: 0.42, size: 1.15, extra: { scanMul: 4.08, dimBase: 0.45 } },
    32: { speed: 2.3803, count: 0.1839, size: 1.4769, extra: { scanMul: 4.2301, dimBase: 0.45 } },
  },
  wave: {
    64: { speed: 4.388, count: 0.341, size: 1 },
    32: { speed: 4.1512, count: 0.169, size: 1.3232 },
  },
}
const FRAMES: Record<Mode, ModeFrame> = { ribbon: frameRibbon, globe: frameGlobe, wave: frameWave }
const presets = new Map<string, { speed: number; opts: ModeOpts }>()
function resolve(state: ThinkingOrbState, size: number) {
  // `state` is a member of the closed ThinkingOrbState union; `mode` of the closed Mode union.
  // eslint-disable-next-line security/detect-object-injection
  const resolved = STATES[state] ?? STATES.idle
  const tuning: 32 | 64 = size < 60 ? 32 : 64
  const key = `${resolved.mode}-${tuning}`
  let preset = presets.get(key)
  if (!preset) {
    // eslint-disable-next-line security/detect-object-injection
    const shipped = PRESETS[resolved.mode][tuning]
    const base = BASE_PROFILES[resolved.mode]
    if (!base) throw new Error(`Unknown orb mode ${resolved.mode}`)
    const opts = scaleRadii(scaleCounts(base, shipped.count), shipped.size)
    preset = { speed: shipped.speed, opts: { ...opts, ...(shipped.extra ?? {}) } }
    presets.set(key, preset)
  }
  return { ...preset, frame: FRAMES[resolved.mode], pace: resolved.pace }
}
function blend(msSinceChange: number): number {
  const progress = Math.max(0, Math.min(1, msSinceChange / TRANSITION_MS))
  return progress * progress * (3 - 2 * progress)
}

const canvas = ref<HTMLCanvasElement | null>(null)
const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
const cssSize = computed(() => Math.max(24, Math.round(props.size)))
let context: CanvasRenderingContext2D | null = null
let frame: number | null = null
let lastAt: number | null = null
let clock = 0
let current: ThinkingOrbState = props.state
let previous: ThinkingOrbState = props.state
let changedAt = 0
let staticKey = ''

function drawState(ctx: CanvasRenderingContext2D, state: ThinkingOrbState, alpha: number, still: boolean) {
  const preset = resolve(state, cssSize.value)
  const time = still || preset.pace === 0 ? 0.6 : clock * preset.speed * preset.pace
  ctx.globalAlpha = alpha * (state === 'offline' ? 0.55 : 1)
  paintFrame(ctx, preset.frame(cssSize.value, time, preset.opts), props.dark)
  ctx.globalAlpha = 1
}
function draw() {
  const el = canvas.value
  if (!el || !context) return
  const size = cssSize.value
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pixels = Math.max(1, Math.round(size * dpr))
  const still = reducedMotion || props.still
  const resting = current === 'idle' && still
  const key = still || resting ? `${size}-${dpr}-${props.dark}-${current}` : ''
  if (key && key === staticKey) return
  staticKey = key
  if (el.width !== pixels || el.height !== pixels) {
    el.width = pixels
    el.height = pixels
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, size, size)
  const mix = still ? 1 : blend(clock * 1000 - changedAt)
  if (mix < 1 && previous !== current) drawState(context, previous, 1 - mix, still)
  drawState(context, current, mix < 1 && previous !== current ? mix : 1, still)
}
function canAnimate(): boolean {
  if (reducedMotion || props.still || !canvas.value?.isConnected || document.visibilityState === 'hidden') return false
  return current !== 'offline' || clock * 1000 - changedAt < TRANSITION_MS
}
function render(timestamp: number) {
  frame = null
  if (!canAnimate()) return
  // Ambient rendering is capped at 30 fps and never advances by time spent hidden.
  if (lastAt === null || timestamp - lastAt >= 1000 / 30) {
    if (lastAt !== null) clock += Math.min(timestamp - lastAt, 100) / 1000
    lastAt = timestamp
    draw()
  }
  queue()
}
function queue() {
  if (frame === null && canAnimate()) frame = requestAnimationFrame(render)
}
function onVisibility() {
  lastAt = null
  if (document.visibilityState === 'hidden') {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  } else queue()
}

watch(
  () => props.state,
  next => {
    if (next === current) return
    previous = current
    current = next
    changedAt = clock * 1000
    staticKey = ''
    draw()
    queue()
  }
)
watch([cssSize, () => props.dark, () => props.still], () => {
  staticKey = ''
  lastAt = null
  draw()
  queue()
})
onMounted(() => {
  try {
    context = canvas.value?.getContext('2d', { alpha: true }) ?? null
  } catch {
    context = null
  }
  document.addEventListener('visibilitychange', onVisibility)
  draw()
  queue()
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
})
</script>
<template>
  <span
    class="thinking-orb"
    :class="`is-${state}`"
    :style="{ width: `${cssSize}px`, height: `${cssSize}px` }"
    aria-hidden="true"
  >
    <span class="thinking-orb__halo" />
    <canvas ref="canvas" class="thinking-orb__canvas" />
  </span>
</template>
<style scoped>
.thinking-orb {
  position: relative;
  display: block;
  overflow: visible;
  transform-origin: 50% 50%;
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.thinking-orb__halo {
  position: absolute;
  inset: 8%;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--ai-accent) 22%, transparent) 0%, transparent 68%);
  opacity: 0.9;
  transition: opacity 400ms ease;
}
.is-offline .thinking-orb__halo {
  opacity: 0.3;
}
.thinking-orb__canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
@media (forced-colors: active) {
  .thinking-orb__canvas {
    display: none;
  }
}
</style>
