<script setup lang="ts">
import { computed, ref } from 'vue'
import { projectMemoryGraph, type MemoryGraph } from './graph'
const props = defineProps<{ graph: MemoryGraph; selected: string }>()
const emit = defineEmits<{ select: [id: string] }>()
const yaw = ref(0.12)
const pitch = ref(-0.12)
const zoom = ref(1)
const points = computed(() => projectMemoryGraph(props.graph.nodes, yaw.value, pitch.value, zoom.value))
const byId = computed(() => new Map(points.value.map(point => [point.id, point])))
const lines = computed(() =>
  props.graph.edges.flatMap(edge => {
    const from = byId.value.get(edge.from),
      to = byId.value.get(edge.to)
    return from && to ? [{ ...edge, start: from, end: to }] : []
  })
)
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
</script>
<template>
  <div class="memory-graph">
    <div class="memory-graph__tools" role="group" aria-label="3D-Ansicht steuern">
      <button type="button" aria-label="Verkleinern" @click="setZoom(-0.15)">−</button>
      <button type="button" aria-label="Vergrößern" @click="setZoom(0.15)">+</button>
      <button type="button" @click="reset">Zentrieren</button>
    </div>
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
      <line
        v-for="(line, index) in lines"
        :key="index"
        :x1="line.start.left"
        :y1="line.start.top"
        :x2="line.end.left"
        :y2="line.end.top"
        :class="{ grouping: line.grouping, selected: line.from === selected || line.to === selected }"
      >
        <title>{{ line.kind }}</title>
      </line>
      <g
        v-for="point in points"
        :key="point.id"
        :data-node="point.id"
        :class="{ selected: point.id === selected, hub: point.kind === 'System' }"
      >
        <circle :cx="point.left" :cy="point.top" :r="Math.max(point.radius, 12)" fill="transparent" stroke="none" />
        <circle :cx="point.left" :cy="point.top" :r="point.radius" class="node" />
        <text v-if="point.kind === 'System' || point.id === selected" :x="point.left + 15" :y="point.top - 12">
          {{ point.label.length > 48 ? point.label.slice(0, 48) + '…' : point.label }}
        </text>
        <title>{{ point.label }} · {{ point.kind }}</title>
      </g>
    </svg>
    <p>
      Ziehen: drehen · +/−: zoomen · Knoten: Details<br /><span
        >Linie: gespeicherte Beziehung · gestrichelt: Zuordnung. Abstand ist keine Ähnlichkeitsbewertung.</span
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
}
svg {
  display: block;
  width: 100%;
  min-height: 280px;
  max-height: 65vh;
  touch-action: none;
  cursor: grab;
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
}
.hub .node,
.selected .node {
  fill: var(--ai-ink);
  stroke: var(--ai-accent);
  stroke-width: 3;
}
g {
  cursor: pointer;
}
text {
  fill: var(--ai-ink);
  font: 600 13px var(--ai-font);
  paint-order: stroke;
  stroke: var(--ai-page);
  stroke-width: 4px;
  stroke-linejoin: round;
}
.memory-graph__tools {
  position: absolute;
  right: 12px;
  top: 12px;
  display: flex;
  gap: 4px;
  z-index: 1;
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
</style>
