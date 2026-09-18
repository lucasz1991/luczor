<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { projectMemoryGraph, type MemoryGraph } from './graph'
import type { MemoryGraphDisplay } from './graphDisplay'
import { DEFAULT_MEMORY_GRAPH_DISPLAY } from './graphDisplay'
import { DREAM_STAGE_LABELS, type DreamRun } from '@/services/memory/dreamTrace'

export type DreamView = {
  active: boolean
  run: DreamRun | null
  reading: Set<string>
  removing: Set<string>
  conflicts: Set<string>
  touched: Set<string>
}

const props = withDefaults(
  defineProps<{
    graph: MemoryGraph
    selected: string
    dream?: DreamView | null
    display?: MemoryGraphDisplay
    /** Emergency offload is active: the pass runs slowly on the page file. */
    offloading?: boolean
  }>(),
  { dream: null, display: () => ({ ...DEFAULT_MEMORY_GRAPH_DISPLAY }) }
)
const emit = defineEmits<{ select: [id: string] }>()
const yaw = ref(0.12)
const pitch = ref(-0.12)
const zoom = ref(1)
const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const points = computed(() =>
  projectMemoryGraph(props.graph.nodes, yaw.value, pitch.value, zoom.value).map(point => ({
    ...point,
    radius: point.radius * props.display.nodeScale,
    // Depth fade: far nodes recede; the range mirrors the projection's ±250 depth.
    opacity: props.display.depthFade ? Math.max(0.35, Math.min(1, 1 - (point.depth + 250) / 700)) : 1,
  }))
)
const byId = computed(() => new Map(points.value.map(point => [point.id, point])))
const lines = computed(() =>
  props.graph.edges.flatMap(edge => {
    const from = byId.value.get(edge.from),
      to = byId.value.get(edge.to)
    if (!from || !to) return []
    const selectedEdge = edge.from === props.selected || edge.to === props.selected
    if (!selectedEdge && props.display.edges === 'none') return []
    if (!selectedEdge && props.display.edges === 'stored' && edge.grouping) return []
    return [{ ...edge, start: from, end: to, selected: selectedEdge }]
  })
)
const dreaming = computed(() => !!props.dream?.active && props.display.dreamAnimation && !reducedMotion)
const dreamStage = computed(() => {
  const run = props.dream?.run
  const step = run?.steps[run.steps.length - 1]
  return step ? DREAM_STAGE_LABELS[step.stage] : ''
})
/** The dream orb hovers over what is being read, or over the memory hub while scanning. */
const orb = computed(() => {
  if (!dreaming.value) return null
  const focused = [...(props.dream?.reading ?? [])].map(id => byId.value.get(id)).filter(Boolean)
  const anchor = focused.length ? focused : [byId.value.get('system:0')].filter(Boolean)
  if (!anchor.length) return { left: 400, top: 250, threads: [] as Array<{ left: number; top: number }> }
  const left = anchor.reduce((sum, point) => sum + point!.left, 0) / anchor.length
  const top = anchor.reduce((sum, point) => sum + point!.top, 0) / anchor.length - 26
  return { left, top, threads: focused.map(point => ({ left: point!.left, top: point!.top })) }
})
function showLabel(point: { kind: string; id: string }): boolean {
  if (point.id === props.selected) return true
  if (props.display.labels === 'all') return true
  if (props.display.labels === 'hubs') return point.kind === 'System'
  return false
}
function nodeClass(point: { id: string; kind: string; state?: 'born' | 'removed' }) {
  const dream = props.dream
  return {
    selected: point.id === props.selected,
    hub: point.kind === 'System',
    'is-reading': !!dream?.reading.has(point.id),
    'is-removing': !!dream?.removing.has(point.id) || point.state === 'removed',
    'is-conflict': !!dream?.conflicts.has(point.id),
    'is-touched': !!dream?.touched.has(point.id),
    'is-born': point.state === 'born',
    'is-ghost': point.state === 'removed',
  }
}

let drag: { id: number; left: number; top: number; distance: number; nodeId: string | null } | undefined
let dragged = false
function down(event: PointerEvent) {
  if (event.button !== 0) return
  dragged = false
  drag = {
    id: event.pointerId,
    left: event.clientX,
    top: event.clientY,
    distance: 0,
    nodeId: (event.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? null,
  }
  ;(event.currentTarget as SVGElement).setPointerCapture(event.pointerId)
}
function move(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  const dx = event.clientX - drag.left,
    dy = event.clientY - drag.top
  drag.distance += Math.abs(dx) + Math.abs(dy)
  dragged = drag.distance > 5
  yaw.value += dx * 0.007
  pitch.value = Math.max(-1.2, Math.min(1.2, pitch.value + dy * 0.007))
  drag.left = event.clientX
  drag.top = event.clientY
}
function up(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  if (!dragged && drag.nodeId) emit('select', drag.nodeId)
  drag = undefined
}
function key(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', 'Home'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'ArrowLeft') yaw.value -= 0.15
  if (event.key === 'ArrowRight') yaw.value += 0.15
  if (event.key === 'ArrowUp') pitch.value = Math.max(-1.2, pitch.value - 0.1)
  if (event.key === 'ArrowDown') pitch.value = Math.min(1.2, pitch.value + 0.1)
  if (event.key === '+') setZoom(0.15)
  if (event.key === '-') setZoom(-0.15)
  if (event.key === 'Home') reset()
}
function reset() {
  yaw.value = 0.12
  pitch.value = -0.12
  zoom.value = 1
}
function setZoom(delta: number) {
  zoom.value = Math.min(2.4, Math.max(0.45, zoom.value + delta))
}

// Slow orbit while dreaming or when auto-rotation is on; user drags always win.
let frame: number | undefined
let lastFrame = 0
const spinning = computed(() => !reducedMotion && (props.display.autoRotate || dreaming.value))
function tick(now: number) {
  if (!spinning.value) {
    frame = undefined
    return
  }
  const delta = lastFrame ? Math.min(64, now - lastFrame) : 16
  lastFrame = now
  if (!drag) yaw.value += (dreaming.value ? 0.00012 : 0.00008) * delta
  frame = requestAnimationFrame(tick)
}
watch(
  spinning,
  active => {
    if (active && frame === undefined && typeof requestAnimationFrame === 'function') {
      lastFrame = 0
      frame = requestAnimationFrame(tick)
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (frame !== undefined) cancelAnimationFrame(frame)
})
</script>
<template>
  <div class="memory-graph" :class="{ 'is-dreaming': dreaming }">
    <div class="memory-graph__tools" role="group" aria-label="3D-Ansicht steuern">
      <button type="button" aria-label="Verkleinern" @click="setZoom(-0.15)">−</button>
      <button type="button" aria-label="Vergrößern" @click="setZoom(0.15)">+</button>
      <button type="button" @click="reset">Zentrieren</button>
    </div>
    <Transition name="dream-chip">
      <div v-if="dreaming" class="memory-graph__dream" role="status">
        <span class="memory-graph__dream-dot" aria-hidden="true" />
        Träumt · {{ dreamStage || 'Leerlauf-Pflege' }}<template v-if="offloading"> · langsam (Auslagerung)</template>
      </div>
    </Transition>
    <svg
      viewBox="0 0 800 500"
      tabindex="0"
      role="group"
      aria-label="Drehbare 3D-Gedächtniskarte. Pfeiltasten drehen, Plus und Minus zoomen. Einträge auch in der Liste auswählbar."
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="drag = undefined"
      @lostpointercapture="drag = undefined"
      @keydown="key"
    >
      <defs>
        <radialGradient id="memory-dream-orb">
          <stop offset="0%" stop-color="var(--ai-accent)" stop-opacity="0.95" />
          <stop offset="55%" stop-color="var(--ai-accent)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--ai-accent)" stop-opacity="0" />
        </radialGradient>
      </defs>
      <line
        v-for="(line, index) in lines"
        :key="index"
        :x1="line.start.left"
        :y1="line.start.top"
        :x2="line.end.left"
        :y2="line.end.top"
        :class="{ grouping: line.grouping, selected: line.selected }"
        :style="{ opacity: Math.min(line.start.opacity, line.end.opacity) }"
      >
        <title>{{ line.kind }}</title>
      </line>
      <g v-if="orb" class="dream-layer" aria-hidden="true">
        <line
          v-for="(thread, index) in orb.threads"
          :key="index"
          class="dream-thread"
          :x1="orb.left"
          :y1="orb.top"
          :x2="thread.left"
          :y2="thread.top"
        />
        <circle class="dream-orb-glow" :cx="orb.left" :cy="orb.top" r="34" fill="url(#memory-dream-orb)" />
        <circle class="dream-orb" :cx="orb.left" :cy="orb.top" r="5" />
      </g>
      <g
        v-for="point in points"
        :key="point.id"
        :data-node="point.id"
        :class="nodeClass(point)"
        :style="{ opacity: point.opacity }"
      >
        <circle :cx="point.left" :cy="point.top" :r="Math.max(point.radius, 12)" fill="transparent" stroke="none" />
        <circle
          v-if="dream?.reading.has(point.id) || point.state === 'born'"
          :cx="point.left"
          :cy="point.top"
          :r="point.radius + 6"
          class="halo"
        />
        <circle :cx="point.left" :cy="point.top" :r="point.radius" class="node" />
        <text
          v-if="showLabel(point)"
          :x="point.left + 15"
          :y="point.top - 12"
          :class="{ minor: point.kind !== 'System' }"
        >
          {{
            point.label.length > (point.kind === 'System' ? 48 : 30)
              ? point.label.slice(0, point.kind === 'System' ? 48 : 30) + '…'
              : point.label
          }}
        </text>
        <title>{{ point.label }} · {{ point.kind }}</title>
      </g>
    </svg>
    <p>
      Ziehen: drehen · +/−: zoomen · Knoten: Details<br /><span
        >Linie: gespeicherte Beziehung · gestrichelt: Zuordnung. Abstand ist keine Ähnlichkeitsbewertung. Beim Träumen:
        Ring = wird gelesen · Pulsen = neu · Ausblenden = ersetzt.</span
      >
    </p>
  </div>
</template>
<style scoped>
.memory-graph {
  position: relative;
  background: var(--ai-page);
  border: 1px solid var(--ai-line);
  border-radius: 12px;
  overflow: hidden;
  transition: box-shadow 900ms var(--ease, ease);
}
.memory-graph.is-dreaming {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ai-accent) 35%, transparent),
    inset 0 -80px 160px -80px color-mix(in srgb, var(--ai-accent) 22%, transparent);
}
.memory-graph.is-dreaming::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(60% 50% at 20% 10%, color-mix(in srgb, var(--ai-accent) 14%, transparent), transparent 70%),
    radial-gradient(50% 60% at 85% 90%, color-mix(in srgb, var(--ai-accent) 12%, transparent), transparent 70%);
  animation: dream-mist 9s ease-in-out infinite alternate;
}
@keyframes dream-mist {
  from {
    opacity: 0.55;
    transform: translate3d(-2%, 0, 0) scale(1);
  }
  to {
    opacity: 1;
    transform: translate3d(2%, -2%, 0) scale(1.04);
  }
}
svg {
  display: block;
  width: 100%;
  min-height: 280px;
  max-height: 65vh;
  touch-action: none;
  cursor: grab;
  position: relative;
}
svg:active {
  cursor: grabbing;
}
line {
  stroke: var(--ai-accent);
  stroke-opacity: 0.32;
  stroke-width: 1;
}
line.grouping {
  stroke: var(--ai-muted);
  stroke-dasharray: 3 6;
  stroke-opacity: 0.24;
}
line.selected {
  stroke-opacity: 1;
  stroke-width: 2;
}
.node {
  fill: var(--ai-accent);
  stroke: var(--ai-surface);
  stroke-width: 1.5;
  transition:
    fill 600ms var(--ease, ease),
    stroke 600ms var(--ease, ease);
}
.hub .node,
.selected .node {
  fill: var(--ai-ink);
  stroke: var(--ai-accent);
  stroke-width: 3;
}
g {
  cursor: pointer;
  transition: opacity 500ms var(--ease, ease);
}
text {
  fill: var(--ai-ink);
  font: 600 13px var(--ai-font);
  paint-order: stroke;
  stroke: var(--ai-page);
  stroke-width: 4px;
  stroke-linejoin: round;
}
text.minor {
  font-size: 10.5px;
  font-weight: 500;
  fill: var(--ai-muted);
}
/* Dream states */
.halo {
  fill: none;
  stroke: var(--ai-accent);
  stroke-width: 1.5;
  stroke-opacity: 0.8;
  transform-box: fill-box;
  transform-origin: center;
  animation: dream-halo 1.6s ease-out infinite;
}
@keyframes dream-halo {
  0% {
    transform: scale(0.6);
    stroke-opacity: 0.9;
  }
  100% {
    transform: scale(1.9);
    stroke-opacity: 0;
  }
}
.is-reading .node {
  fill: var(--ai-ink);
  stroke: var(--ai-accent);
  stroke-width: 2.5;
}
.is-touched:not(.is-reading) .node {
  stroke: color-mix(in srgb, var(--ai-accent) 60%, var(--ai-surface));
}
.is-conflict .node {
  fill: var(--ai-orange, #e6a23c);
}
.is-removing .node {
  fill: var(--ai-muted);
  stroke-dasharray: 2 2;
  animation: dream-dissolve 1.4s ease-in-out infinite alternate;
}
.is-ghost {
  pointer-events: none;
}
.is-ghost .node {
  fill: transparent;
  stroke: var(--ai-muted);
  stroke-width: 1;
  stroke-dasharray: 2 3;
  animation: dream-fade 7s linear forwards;
}
@keyframes dream-dissolve {
  from {
    opacity: 1;
  }
  to {
    opacity: 0.35;
  }
}
@keyframes dream-fade {
  0% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
  }
}
.is-born .node {
  fill: var(--ai-green, #34c38f);
  transform-box: fill-box;
  transform-origin: center;
  animation: dream-born 900ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes dream-born {
  0% {
    transform: scale(0);
  }
  100% {
    transform: scale(1);
  }
}
.dream-layer {
  pointer-events: none;
}
.dream-orb {
  fill: var(--ai-accent);
  transition:
    cx 900ms var(--ease, ease),
    cy 900ms var(--ease, ease);
  animation: dream-breathe 2.6s ease-in-out infinite;
  transform-box: fill-box;
  transform-origin: center;
}
.dream-orb-glow {
  transition:
    cx 900ms var(--ease, ease),
    cy 900ms var(--ease, ease);
  animation: dream-breathe 2.6s ease-in-out infinite reverse;
  transform-box: fill-box;
  transform-origin: center;
}
@keyframes dream-breathe {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.35);
  }
}
.dream-thread {
  stroke: var(--ai-accent);
  stroke-opacity: 0.7;
  stroke-width: 1.2;
  stroke-dasharray: 3 7;
  animation: dream-march 1.2s linear infinite;
  transition:
    x1 900ms var(--ease, ease),
    y1 900ms var(--ease, ease);
}
@keyframes dream-march {
  to {
    stroke-dashoffset: -20;
  }
}
.memory-graph__tools {
  position: absolute;
  right: 12px;
  top: 12px;
  display: flex;
  gap: 4px;
  z-index: 1;
}
.memory-graph__dream {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 9px;
  border: 1px solid color-mix(in srgb, var(--ai-accent) 45%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ai-surface) 85%, transparent);
  color: var(--ai-ink);
  font: 500 11px var(--ai-font);
  letter-spacing: 0.02em;
}
.memory-graph__dream-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ai-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--ai-accent) 60%, transparent);
  animation: dream-dot 1.8s ease-out infinite;
}
@keyframes dream-dot {
  to {
    box-shadow: 0 0 0 9px transparent;
  }
}
.dream-chip-enter-active,
.dream-chip-leave-active {
  transition:
    opacity 400ms var(--ease, ease),
    transform 400ms var(--ease, ease);
}
.dream-chip-enter-from,
.dream-chip-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
button {
  min-width: 40px;
  min-height: 40px;
  padding: 4px 12px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  cursor: pointer;
}
button:hover {
  border-color: var(--ai-accent);
}
p {
  padding: 0 16px 12px;
  margin: 0;
  color: var(--ai-muted);
  font-size: 12px;
}
p span {
  color: var(--ai-muted);
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .halo,
  .is-removing .node,
  .is-born .node,
  .dream-orb,
  .dream-orb-glow,
  .dream-thread,
  .memory-graph__dream-dot,
  .memory-graph.is-dreaming::before {
    animation: none;
  }
}
</style>
