<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { hud, setKillSwitch } from '@/state/hud'
import { lastScreenshot } from '@/services/tools/registry'
import { syncNow } from '@/services/status'
import { appearance } from '@/services/appearance'
import { readSystemMetrics, type SystemMetrics } from '@/services/systemMetrics'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
})

/* -------------------------------------------------
 * Animation clock + smoothed telemetry
 * ------------------------------------------------- */
const frame = ref(0)
let raf = 0
let metricsTimer: number | undefined

// Smoothed scalars (ease toward live values so nothing jitters).
const sEnergy = ref(0)
const sMic = ref(0)
const sNet = ref(0)
const sFile = ref(0)
const sOs = ref(0)
const sysMetrics = ref<SystemMetrics | null>(null)
const sysMetricsError = ref(false)

// Circular spectrum + linear waveform smoothing buffers.
const SPECTRUM = 64
const BARS = 40
const spec = ref<number[]>(Array(SPECTRUM).fill(0))
const bars = ref<number[]>(Array(BARS).fill(0))

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

function loop() {
  const f = (frame.value + 1) % 1_000_000
  frame.value = f

  const a = hud.activity
  const thinking = hud.status === 'thinking' || hud.status === 'executing'
  const base = thinking ? 0.32 : hud.status === 'listening' ? 0.14 : 0.05
  const liveEnergy = Math.min(1, Math.max(hud.micLevel, a.audio, a.network, a.file, a.os, base))

  sEnergy.value = lerp(sEnergy.value, liveEnergy, 0.14)
  sMic.value = lerp(sMic.value, hud.micLevel, 0.25)
  sNet.value = lerp(sNet.value, a.network, 0.2)
  sFile.value = lerp(sFile.value, a.file, 0.2)
  sOs.value = lerp(sOs.value, a.os, 0.2)

  const level = Math.max(sMic.value, a.audio, hud.status !== 'idle' ? 0.1 : 0.02)

  // Circular spectrum: symmetric, gently animated envelope.
  const sp = spec.value
  for (let i = 0; i < SPECTRUM; i++) {
    const phase = f * 0.05
    const wobble = 0.5 + 0.5 * Math.sin(phase + i * 0.5) * Math.cos(phase * 0.6 + i * 0.27)
    const target = level * (0.35 + 0.65 * wobble)
    sp[i] = lerp(sp[i]!, target, 0.22)
  }

  // Linear waveform: tapered at edges, mirrored in template.
  const br = bars.value
  for (let i = 0; i < BARS; i++) {
    const env = Math.sin((i / (BARS - 1)) * Math.PI) // taper
    const wob = 0.5 + 0.5 * Math.sin(f * 0.12 + i * 0.55)
    const target = level * (0.3 + 0.7 * wob) * (0.35 + 0.65 * env)
    br[i] = lerp(br[i]!, target, 0.3)
  }

  raf = requestAnimationFrame(loop)
}
onMounted(() => {
  raf = requestAnimationFrame(loop)
  void refreshSystemMetrics()
  metricsTimer = window.setInterval(() => void refreshSystemMetrics(), 3500)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (metricsTimer) window.clearInterval(metricsTimer)
})

const collapsed = ref(false)

/* -------------------------------------------------
 * Status -> palette (CSS transitions smooth the change)
 * ------------------------------------------------- */
const palette = computed(() => {
  switch (hud.status) {
    case 'listening':
      return { main: '#22d3ee', accent: '#67e8f9', glow: 'rgba(34,211,238,.65)', label: 'Höre zu' }
    case 'thinking':
      return { main: '#38bdf8', accent: '#7dd3fc', glow: 'rgba(56,189,248,.6)', label: 'Denke nach' }
    case 'executing':
      return { main: '#f59e0b', accent: '#fcd34d', glow: 'rgba(245,158,11,.72)', label: 'Führe aus' }
    case 'speaking':
      return { main: '#34d399', accent: '#6ee7b7', glow: 'rgba(52,211,153,.62)', label: 'Spreche' }
    case 'error':
      return { main: '#f43f5e', accent: '#fda4af', glow: 'rgba(244,63,94,.72)', label: 'Fehler' }
    default:
      return { main: '#38bdf8', accent: '#7dd3fc', glow: 'rgba(56,189,248,.4)', label: 'Bereit' }
  }
})

/* Rotations */
const rotOuter = computed(() => (frame.value * 0.28) % 360)
const rotMid = computed(() => (-frame.value * 0.5) % 360)
const rotArcs = computed(() => (frame.value * 0.9) % 360)
const rotSweep = computed(() => (frame.value * 1.4) % 360)

const coreScale = computed(() => 1 + sEnergy.value * 0.16)
const pingR = computed(() => 22 + sEnergy.value * 26)
const pingOpacity = computed(() => 0.05 + sEnergy.value * 0.32)

/* Circular spectrum -> line segments radiating from r=40 */
const spectrumLines = computed(() => {
  void frame.value
  const cx = 100,
    cy = 100,
    r0 = 41
  const arr = spec.value
  return arr.map((v, i) => {
    const ang = (i / SPECTRUM) * Math.PI * 2 - Math.PI / 2
    const len = 4 + v * 26
    const cos = Math.cos(ang),
      sin = Math.sin(ang)
    return {
      x1: cx + r0 * cos,
      y1: cy + r0 * sin,
      x2: cx + (r0 + len) * cos,
      y2: cy + (r0 + len) * sin,
      o: 0.35 + v * 0.6,
    }
  })
})

/* Outer tick marks */
const ticks = computed(() => {
  void frame.value
  return Array.from({ length: 60 }, (_, i) => {
    const ang = (i * 6 * Math.PI) / 180
    const long = i % 5 === 0
    const rOut = 90,
      rIn = long ? 80 : 85
    return {
      x1: 100 + rOut * Math.cos(ang),
      y1: 100 + rOut * Math.sin(ang),
      x2: 100 + rIn * Math.cos(ang),
      y2: 100 + rIn * Math.sin(ang),
      o: long ? 0.8 : 0.4,
    }
  })
})

/* Segmented energy ring (r=70): number of lit segments follows energy */
const SEGMENTS = 44
const segments = computed(() => {
  const lit = Math.round(sEnergy.value * SEGMENTS)
  return Array.from({ length: SEGMENTS }, (_, i) => {
    const ang = (i / SEGMENTS) * Math.PI * 2 - Math.PI / 2
    const on = i < lit
    return {
      x1: 100 + 66 * Math.cos(ang),
      y1: 100 + 66 * Math.sin(ang),
      x2: 100 + 72 * Math.cos(ang),
      y2: 100 + 72 * Math.sin(ang),
      on,
    }
  })
})

function arc(v: number) {
  return { opacity: 0.2 + v * 0.8, width: 2 + v * 5 }
}

async function refreshSystemMetrics() {
  try {
    sysMetrics.value = await readSystemMetrics()
    sysMetricsError.value = false
  } catch (e) {
    sysMetricsError.value = true
    console.warn('[hud] system metrics failed:', e)
  }
}

function pct(v: number | null | undefined) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
}

function temp(v: number | null | undefined) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function loadColor(load: number | null, tempC?: number | null) {
  const hot = tempC != null && tempC >= 85
  const warm = tempC != null && tempC >= 75
  if (hot || (load != null && load >= 90)) return '#fb7185'
  if (warm || (load != null && load >= 72)) return '#f59e0b'
  if (load != null && load >= 45) return '#22d3ee'
  return '#34d399'
}

function fmtPct(v: number | null) {
  return v == null ? 'n/a' : `${Math.round(v)}%`
}

function fmtTemp(v: number | null) {
  return v == null ? 'n/a' : `${Math.round(v)}C`
}

const hardwareMeters = computed(() => {
  const m = sysMetrics.value
  const cpu = pct(m?.cpu_percent)
  const ram = pct(m?.ram_percent)
  const gpu = pct(m?.gpu_percent)
  const cpuTemp = temp(m?.cpu_temp_c)
  const gpuTemp = temp(m?.gpu_temp_c)

  return [
    { tag: 'CPU', value: cpu, temp: cpuTemp, color: loadColor(cpu, cpuTemp), detail: fmtTemp(cpuTemp) },
    {
      tag: 'RAM',
      value: ram,
      temp: null,
      color: loadColor(ram, null),
      detail: m ? `${Math.round(m.ram_used_mb / 1024)}/${Math.round(m.ram_total_mb / 1024)}G` : 'n/a',
    },
    { tag: 'GPU', value: gpu, temp: gpuTemp, color: loadColor(gpu, gpuTemp), detail: fmtTemp(gpuTemp) },
  ]
})

function toggleKill() {
  setKillSwitch(!hud.killSwitch)
}

const syncing = ref(false)
async function doSync() {
  if (syncing.value) return
  syncing.value = true
  try {
    await syncNow()
  } catch (e) {
    console.warn('[hud] sync failed:', e)
  } finally {
    syncing.value = false
  }
}

function connColor(state: string): string {
  switch (state) {
    case 'online':
      return '#34d399'
    case 'configured':
      return '#22d3ee'
    case 'offline':
      return '#f43f5e'
    default:
      return '#4f7488'
  }
}

/* HUD anchor from personalization (br/bl/tr/tl) */
const posStyle = computed(() => {
  if (props.embedded) return {}
  const p = appearance.hudPosition
  const bottom = p[0] === 'b'
  const right = p[1] === 'r'
  return {
    top: bottom ? 'auto' : '16px',
    bottom: bottom ? '16px' : 'auto',
    left: right ? 'auto' : '16px',
    right: right ? '16px' : 'auto',
  }
})
</script>

<template>
  <div class="jarvis" :class="{ collapsed, embedded: props.embedded }" :style="posStyle">
    <button
      v-if="!props.embedded"
      class="jarvis-toggle"
      :title="collapsed ? 'HUD zeigen' : 'HUD einklappen'"
      @click="collapsed = !collapsed"
    >
      <span class="dot" :style="{ background: palette.main, boxShadow: `0 0 12px ${palette.glow}` }" />
    </button>

    <transition name="hud-fade">
      <div v-if="!collapsed" class="jarvis-body">
        <div class="scanline" />

        <div v-if="hud.killSwitch" class="kill-banner">NOT-AUS AKTIV — Tools gesperrt</div>

        <!-- Arc reactor -->
        <div class="reactor" :style="{ filter: `drop-shadow(0 0 20px ${palette.glow})` }">
          <svg viewBox="0 0 200 200" width="190" height="190">
            <defs>
              <radialGradient id="coreGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" :stop-color="palette.accent" stop-opacity="1" />
                <stop offset="45%" :stop-color="palette.main" stop-opacity="0.55" />
                <stop offset="100%" :stop-color="palette.main" stop-opacity="0" />
              </radialGradient>
              <radialGradient id="sweepGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" :stop-color="palette.main" stop-opacity="0.5" />
                <stop offset="100%" :stop-color="palette.main" stop-opacity="0" />
              </radialGradient>
              <filter id="softGlow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="2.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <!-- faint base rings -->
            <circle cx="100" cy="100" r="92" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="1" />
            <circle cx="100" cy="100" r="55" fill="none" stroke="rgba(255,255,255,.05)" stroke-width="1" />

            <!-- radar sweep -->
            <g :transform="`rotate(${rotSweep} 100 100)`">
              <path d="M100 100 L100 12 A88 88 0 0 1 156 34 Z" fill="url(#sweepGrad)" opacity="0.55" />
            </g>

            <!-- outer ticks -->
            <g :transform="`rotate(${rotOuter} 100 100)`" :stroke="palette.main" stroke-width="1.5" class="tint">
              <line
                v-for="(tk, i) in ticks"
                :key="'t' + i"
                :x1="tk.x1"
                :y1="tk.y1"
                :x2="tk.x2"
                :y2="tk.y2"
                :opacity="tk.o"
              />
            </g>

            <!-- mid dashed counter-rotating ring -->
            <circle
              :transform="`rotate(${rotMid} 100 100)`"
              cx="100"
              cy="100"
              r="60"
              fill="none"
              :stroke="palette.main"
              stroke-width="2.5"
              stroke-dasharray="5 13"
              opacity="0.75"
              class="tint"
            />

            <!-- segmented energy ring -->
            <g stroke-linecap="round" filter="url(#softGlow)">
              <line
                v-for="(s, i) in segments"
                :key="'s' + i"
                :x1="s.x1"
                :y1="s.y1"
                :x2="s.x2"
                :y2="s.y2"
                :stroke="s.on ? palette.accent : 'rgba(255,255,255,.10)'"
                :stroke-width="s.on ? 3 : 2"
                :opacity="s.on ? 0.95 : 1"
                class="tint seg"
              />
            </g>

            <!-- activity arcs (net / file / os) -->
            <g filter="url(#softGlow)">
              <circle
                :transform="`rotate(${rotArcs} 100 100)`"
                cx="100"
                cy="100"
                r="50"
                fill="none"
                stroke="#22d3ee"
                :stroke-width="arc(sNet).width"
                :opacity="arc(sNet).opacity"
                stroke-dasharray="46 210"
                stroke-linecap="round"
              />
              <circle
                :transform="`rotate(${rotArcs + 120} 100 100)`"
                cx="100"
                cy="100"
                r="50"
                fill="none"
                stroke="#a78bfa"
                :stroke-width="arc(sFile).width"
                :opacity="arc(sFile).opacity"
                stroke-dasharray="46 210"
                stroke-linecap="round"
              />
              <circle
                :transform="`rotate(${rotArcs + 240} 100 100)`"
                cx="100"
                cy="100"
                r="50"
                fill="none"
                stroke="#f59e0b"
                :stroke-width="arc(sOs).width"
                :opacity="arc(sOs).opacity"
                stroke-dasharray="46 210"
                stroke-linecap="round"
              />
            </g>

            <!-- circular audio spectrum -->
            <g :stroke="palette.main" stroke-width="1.6" stroke-linecap="round" filter="url(#softGlow)" class="tint">
              <line
                v-for="(l, i) in spectrumLines"
                :key="'sp' + i"
                :x1="l.x1"
                :y1="l.y1"
                :x2="l.x2"
                :y2="l.y2"
                :opacity="l.o"
              />
            </g>

            <!-- expanding ping -->
            <circle
              cx="100"
              cy="100"
              :r="pingR"
              fill="none"
              :stroke="palette.accent"
              stroke-width="1.5"
              :opacity="pingOpacity"
              class="tint"
            />

            <!-- pulsing core -->
            <g :transform="`translate(100 100) scale(${coreScale})`">
              <circle r="36" fill="url(#coreGrad)" />
              <circle r="21" fill="none" :stroke="palette.main" stroke-width="2" opacity="0.9" class="tint" />
              <circle r="14" fill="none" :stroke="palette.accent" stroke-width="1" opacity="0.7" class="tint" />
              <circle r="8" :fill="palette.accent" opacity="0.95" class="tint" filter="url(#softGlow)" />
            </g>
          </svg>
          <div class="status-label" :style="{ color: palette.main, textShadow: `0 0 12px ${palette.glow}` }">
            {{ palette.label }}
          </div>
        </div>

        <!-- mirrored waveform -->
        <div class="wave">
          <span
            v-for="(h, i) in bars"
            :key="i"
            class="bar"
            :style="{
              height: 6 + h * 54 + 'px',
              background: `linear-gradient(${palette.accent}, ${palette.main})`,
              boxShadow: `0 0 7px ${palette.glow}`,
            }"
          />
        </div>

        <!-- channel meters -->
        <div class="meters">
          <div class="meter">
            <span class="tag">NET</span>
            <span class="track"
              ><i :style="{ width: sNet * 100 + '%', background: 'linear-gradient(90deg,#0891b2,#22d3ee)' }"
            /></span>
          </div>
          <div class="meter">
            <span class="tag">FILE</span>
            <span class="track"
              ><i :style="{ width: sFile * 100 + '%', background: 'linear-gradient(90deg,#7c3aed,#a78bfa)' }"
            /></span>
          </div>
          <div class="meter">
            <span class="tag">OS</span>
            <span class="track"
              ><i :style="{ width: sOs * 100 + '%', background: 'linear-gradient(90deg,#d97706,#f59e0b)' }"
            /></span>
          </div>
          <div class="meter">
            <span class="tag">MIC</span>
            <span class="track"
              ><i :style="{ width: sMic * 100 + '%', background: 'linear-gradient(90deg,#059669,#34d399)' }"
            /></span>
          </div>
        </div>

        <div class="hardware" :class="{ 'is-stale': sysMetricsError }">
          <div v-for="m in hardwareMeters" :key="m.tag" class="hw">
            <div class="hw__head">
              <span class="tag">{{ m.tag }}</span>
              <span class="hw__value">{{ fmtPct(m.value) }}</span>
              <span class="hw__temp">{{ m.detail }}</span>
            </div>
            <span class="track">
              <i
                :style="{
                  width: (m.value ?? 0) + '%',
                  background: `linear-gradient(90deg, ${m.color}88, ${m.color})`,
                  boxShadow: `0 0 9px ${m.color}77`,
                }"
              />
            </span>
          </div>
        </div>

        <!-- sync / memory status -->
        <div class="syncrow">
          <button
            type="button"
            class="syncrow__item syncrow__btn"
            :class="{ 'is-busy': syncing }"
            :disabled="syncing || hud.sync.server !== 'online'"
            :title="hud.sync.server === 'online' ? 'Jetzt synchronisieren' : 'Server nicht verbunden'"
            @click="doSync"
          >
            <span class="syncrow__ico">⇅</span>{{ hud.sync.pending }}
          </button>
          <span class="syncrow__item" :title="`Server: ${hud.sync.server}`">
            <span class="syncrow__dot" :style="{ background: connColor(hud.sync.server) }" />SRV
          </span>
          <span class="syncrow__item" :title="`Cognee: ${hud.sync.cognee}`">
            <span class="syncrow__dot" :style="{ background: connColor(hud.sync.cognee) }" />MEM
          </span>
        </div>

        <div class="footer">
          <div class="ticker" :title="hud.lastTool"><span class="muted">tool</span> {{ hud.lastTool || '—' }}</div>
          <button class="kill" :class="{ on: hud.killSwitch }" @click="toggleKill">
            {{ hud.killSwitch ? 'Not-Aus AN' : 'Not-Aus' }}
          </button>
        </div>

        <transition name="shot-fade">
          <div v-if="lastScreenshot" class="shot"><img :src="lastScreenshot" alt="screen" /></div>
        </transition>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.jarvis {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 50;
  width: 244px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  color: #cbe8f5;
  user-select: none;
}
.jarvis.collapsed {
  width: auto;
}
.jarvis.embedded {
  position: relative;
  inset: auto;
  z-index: auto;
  width: 100%;
  margin: var(--s3) 0;
}
.jarvis.embedded.collapsed {
  width: 100%;
}
.jarvis.embedded .jarvis-toggle {
  top: 8px;
  right: 8px;
}
.jarvis.embedded .jarvis-body {
  border-radius: var(--r-lg);
  padding: 12px 11px 10px;
}
.jarvis.embedded .reactor svg {
  width: 156px;
  height: 156px;
}
.jarvis.embedded .wave {
  height: 44px;
  margin: 5px 2px 9px;
}

/* Smooth colour morphing on every tinted SVG element + labels */
.tint {
  transition:
    stroke 0.55s ease,
    fill 0.55s ease;
}
.status-label,
.dot {
  transition:
    color 0.55s ease,
    background 0.55s ease,
    box-shadow 0.55s ease,
    text-shadow 0.55s ease;
}

.jarvis-toggle {
  position: absolute;
  top: -14px;
  right: 0;
  z-index: 2;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px;
}
.jarvis-toggle .dot {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  animation: breathe 2.6s ease-in-out infinite;
}

.jarvis-body {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 0%, rgba(34, 211, 238, 0.08), transparent 60%),
    linear-gradient(160deg, rgba(6, 18, 28, 0.9), rgba(2, 8, 14, 0.94));
  border: 1px solid rgba(56, 189, 248, 0.28);
  border-radius: 20px;
  padding: 14px 13px 11px;
  backdrop-filter: blur(14px);
  box-shadow:
    0 16px 48px rgba(0, 0, 0, 0.55),
    inset 0 0 34px rgba(34, 211, 238, 0.06);
}

/* faint travelling scanline */
.scanline {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 40%;
  background: linear-gradient(180deg, rgba(56, 189, 248, 0.1), transparent);
  pointer-events: none;
  animation: scan 5.5s linear infinite;
}

.kill-banner {
  position: relative;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #fecaca;
  background: rgba(244, 63, 94, 0.16);
  border: 1px solid rgba(244, 63, 94, 0.5);
  border-radius: 9px;
  padding: 3px 6px;
  margin-bottom: 8px;
  animation: blink 1.1s steps(2) infinite;
}

.reactor {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 4px;
}
.seg {
  transition:
    stroke 0.25s ease,
    stroke-width 0.25s ease;
}
.status-label {
  margin-top: -8px;
  font-size: 12px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-weight: 600;
}

.wave {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 60px;
  margin: 8px 2px 12px;
}
.wave .bar {
  width: 3px;
  border-radius: 3px;
  transition: height 0.05s linear;
  align-self: center;
}

.meters {
  display: grid;
  gap: 6px;
  margin-bottom: 9px;
}
.meter {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
}
.meter .tag {
  width: 32px;
  color: #86bfd6;
  letter-spacing: 0.12em;
}
.meter .track {
  flex: 1;
  height: 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
  box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.4);
}
.meter .track i {
  display: block;
  height: 100%;
  border-radius: 5px;
  transition: width 0.18s ease-out;
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.15);
}

.hardware {
  display: grid;
  gap: 7px;
  margin: 0 0 10px;
  padding: 8px;
  border: 1px solid rgba(56, 189, 248, 0.12);
  border-radius: 10px;
  background: rgba(2, 8, 14, 0.38);
}
.hardware.is-stale {
  opacity: 0.72;
}
.hw {
  display: grid;
  gap: 4px;
}
.hw__head {
  display: grid;
  grid-template-columns: 34px 1fr auto;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}
.hw__value {
  color: #d8f7ff;
  text-align: right;
}
.hw__temp {
  color: #86bfd6;
  min-width: 34px;
  text-align: right;
}
.hw .track {
  height: 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
  box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.45);
}
.hw .track i {
  display: block;
  height: 100%;
  border-radius: 5px;
  transition:
    width 0.25s ease-out,
    background 0.25s ease-out;
}

.syncrow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 2px 0 8px;
  font-size: 10px;
  color: #7fb7cd;
  letter-spacing: 0.06em;
}
.syncrow__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.syncrow__btn {
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  border-radius: var(--r-sm);
  padding: 2px 6px;
  cursor: pointer;
  font: inherit;
  transition: all 0.2s ease;
}
.syncrow__btn:hover:not(:disabled) {
  border-color: var(--border-soft);
  background: var(--cy-08);
  color: var(--cy-soft);
}
.syncrow__btn:disabled {
  cursor: default;
  opacity: 0.8;
}
.syncrow__btn.is-busy {
  animation: pulse-soft 1s infinite;
}
.syncrow__ico {
  color: #67e8f9;
  font-size: 11px;
}
.syncrow__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  box-shadow: 0 0 6px currentColor;
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ticker {
  flex: 1;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #9fd3e6;
}
.ticker .muted {
  color: #4f7d91;
}
.kill {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 5px 9px;
  border-radius: 9px;
  cursor: pointer;
  color: #a7f3d0;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.4);
  transition: all 0.25s ease;
}
.kill:hover {
  background: rgba(16, 185, 129, 0.2);
}
.kill.on {
  color: #fff;
  background: #e11d48;
  border-color: #e11d48;
  box-shadow: 0 0 16px rgba(225, 29, 72, 0.65);
}

.shot {
  margin-top: 9px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(56, 189, 248, 0.28);
}
.shot img {
  display: block;
  width: 100%;
}

.hud-fade-enter-active,
.hud-fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}
.hud-fade-enter-from,
.hud-fade-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.97);
}
.shot-fade-enter-active {
  transition:
    opacity 0.4s ease,
    max-height 0.4s ease;
}
.shot-fade-enter-from {
  opacity: 0;
}

@keyframes breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.85;
  }
  50% {
    transform: scale(1.25);
    opacity: 1;
  }
}
@keyframes blink {
  50% {
    opacity: 0.35;
  }
}
@keyframes scan {
  0% {
    transform: translateY(-100%);
  }
  100% {
    transform: translateY(320%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .scanline,
  .jarvis-toggle .dot,
  .kill-banner {
    animation: none;
  }
}
</style>
