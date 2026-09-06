<script setup lang="ts">
import { computed } from 'vue'
import type { OrbPhase } from '@/services/miniChat/presentation'
const props = withDefaults(defineProps<{ phase: OrbPhase; level?: number }>(), { level: 0 })
const active = computed(() => ['thinking', 'executing', 'speaking', 'listening'].includes(props.phase))
const ticks = Array.from({ length: 60 }, (_, i) => ({ angle: i * 6, long: i % 5 === 0 }))
const spectrum = computed(() =>
  Array.from({ length: 36 }, (_, i) => ({
    angle: i * 10,
    length:
      props.phase === 'listening'
        ? 3 + Math.max(0, Math.min(1, props.level)) * (8 + (i % 5) * 2)
        : active.value
          ? 5 + (i % 4) * 2
          : 3,
  }))
)
</script>
<template>
  <span class="status-orb" :class="[`is-${phase}`, { 'is-active': active }]" aria-hidden="true">
    <svg viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="94" class="orb-disc" />
      <g class="orb-ticks">
        <line
          v-for="(tick, i) in ticks"
          :key="i"
          x1="100"
          :y1="tick.long ? 13 : 17"
          x2="100"
          y2="21"
          :transform="`rotate(${tick.angle} 100 100)`"
        />
      </g>
      <circle cx="100" cy="100" r="74" class="orb-track" />
      <g class="orb-outer">
        <circle cx="100" cy="100" r="74" stroke-dasharray="76 40" />
        <circle cx="100" cy="26" r="3" class="orb-dot" />
      </g>
      <g class="orb-spectrum">
        <line
          v-for="(bar, i) in spectrum"
          :key="i"
          x1="100"
          y1="54"
          x2="100"
          :y2="54 - bar.length"
          :transform="`rotate(${bar.angle} 100 100)`"
        />
      </g>
      <circle cx="100" cy="100" r="33" class="orb-core-ring" />
      <circle cx="100" cy="100" r="24" class="orb-core" />
      <path v-if="phase === 'waiting'" d="M100 88v14m0 9v1" class="orb-symbol" />
      <path v-else-if="phase === 'error'" d="m92 92 16 16m0-16-16 16" class="orb-symbol" />
      <path v-else-if="phase === 'done'" d="m90 101 7 7 15-16" class="orb-symbol" />
      <path v-else-if="phase === 'stopped'" d="M93 92h14v16H93z" class="orb-symbol" />
      <path v-else d="M91 100h18m-9-9v18" class="orb-symbol orb-cross" />
    </svg>
  </span>
</template>
<style scoped>
.status-orb {
  --orb-color: #38bdf8;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  color: var(--orb-color);
}
.status-orb svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.orb-disc {
  fill: #0b111b;
  stroke: currentColor;
  stroke-opacity: 0.22;
}
.orb-ticks {
  stroke: currentColor;
  stroke-width: 1.4;
  opacity: 0.5;
}
.orb-track {
  stroke: currentColor;
  opacity: 0.15;
}
.orb-outer {
  stroke: currentColor;
  stroke-width: 1.8;
  transform-origin: 100px 100px;
}
.orb-dot {
  fill: currentColor;
}
.orb-spectrum {
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  opacity: 0.58;
}
.orb-core-ring {
  stroke: currentColor;
  stroke-opacity: 0.35;
}
.orb-core {
  fill: currentColor;
  fill-opacity: 0.1;
  stroke: currentColor;
  stroke-opacity: 0.5;
}
.orb-symbol {
  stroke: currentColor;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.orb-cross {
  opacity: 0.8;
  stroke-width: 1.8;
}
.is-active .orb-outer {
  animation: orb-rotate 7s linear infinite;
}
.is-thinking .orb-spectrum,
.is-speaking .orb-core {
  animation: orb-pulse 1.6s ease-in-out infinite alternate;
}
.is-executing {
  --orb-color: #f59e0b;
}
.is-waiting {
  --orb-color: #fbbf24;
}
.is-waiting .orb-core-ring {
  stroke-width: 3;
  stroke-dasharray: 5 6;
}
.is-speaking,
.is-done {
  --orb-color: #34d399;
}
.is-listening {
  --orb-color: #22d3ee;
}
.is-error {
  --orb-color: #f43f5e;
}
.is-stopped {
  --orb-color: #94a3b8;
}
.is-stopped .orb-outer {
  stroke-dasharray: 8 12;
}
@keyframes orb-rotate {
  to {
    transform: rotate(360deg);
  }
}
@keyframes orb-pulse {
  to {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .status-orb * {
    animation: none !important;
  }
}
:global(html[data-reduce-motion='1']) .status-orb * {
  animation: none !important;
}
</style>
