<script setup lang="ts">
import { dialDisplay, dialScope, diskScopes, gibibytes, type ResourceMeter, type ResourceView } from '../resourceModel'

defineProps<{
  meter: ResourceMeter
  view: ResourceView
  compact: boolean
  stale: boolean
}>()
</script>

<template>
  <article class="resource" :class="{ 'is-compact': compact, 'is-stale': stale }">
    <h5 :class="{ 'ai-sr-only': view === 'circles' || compact }">{{ meter.label }}</h5>
    <div v-if="view === 'circles' || compact" class="resource-dial-wrap">
      <svg class="resource-dial" viewBox="0 0 120 120" aria-hidden="true">
        <g
          v-for="(series, index) in meter.series"
          :key="series.key"
          :data-scope="dialScope(series)"
          transform="rotate(135 60 60)"
        >
          <circle class="dial-track" cx="60" cy="60" :r="49 - index * 10" pathLength="100" stroke-dasharray="75 100" />
          <circle
            v-if="series.value !== null"
            class="dial-value"
            cx="60"
            cy="60"
            :r="49 - index * 10"
            pathLength="100"
            :stroke-dasharray="`${series.value * 0.75} 100`"
          />
        </g>
        <text x="60" y="63" text-anchor="middle">{{ meter.label }}</text>
      </svg>
      <div class="dial-badges" :class="{ 'is-compact': compact }">
        <span
          v-for="(series, index) in meter.series"
          :key="series.key"
          class="dial-badge"
          :data-scope="dialScope(series)"
          :style="compact ? undefined : { top: `${15 + index * 21}%` }"
          tabindex="0"
          :aria-label="`${meter.label} · ${series.detail}: ${series.value === null ? 'nicht verfügbar oder nicht aktiv' : dialDisplay(series)}`"
          :data-tip="series.detail"
          >{{ dialDisplay(series) }}</span
        >
      </div>
    </div>
    <div v-else class="resource-history">
      <div class="history-values">
        <span v-for="series in meter.series" :key="series.key" :data-scope="dialScope(series)" :title="series.detail">{{
          dialDisplay(series)
        }}</span>
      </div>
      <svg class="resource__chart" viewBox="0 0 180 74" preserveAspectRatio="none" aria-hidden="true">
        <path class="chart-baseline" d="M4 8H176M4 68H176" />
        <g
          v-for="series in meter.series.filter(series => series.chart)"
          :key="series.key"
          :data-scope="dialScope(series)"
        >
          <path class="chart-line" :d="series.chart?.path" />
          <circle
            v-if="series.chart?.last"
            :cx="series.chart.last.horizontal"
            :cy="series.chart.last.vertical"
            r="2.3"
          />
        </g>
      </svg>
    </div>
    <div v-if="meter.disk" class="resource-storage-note">
      <span>{{ meter.disk.mount }} · {{ diskScopes(meter.disk) }}</span>
      <span>{{ gibibytes(meter.disk.used_bytes) }} / {{ gibibytes(meter.disk.total_bytes) }} GiB</span>
    </div>
  </article>
</template>

<style scoped>
.resource {
  min-width: 0;
  padding: 0;
}
.resource h5 {
  margin: 0 0 13px;
  font-size: 12px;
  font-weight: 600;
}
.resource-dial-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 180 / 152;
  margin: auto;
}
.resource-dial {
  display: block;
  width: 82%;
  margin: 0;
  overflow: visible;
}
.resource-dial circle {
  fill: none;
  stroke-width: 5;
  stroke-linecap: round;
}
.dial-track {
  stroke: var(--ai-line);
}
.dial-value {
  stroke: var(--scope-color);
}
.resource-dial text {
  fill: var(--ai-ink);
  font: 500 12px var(--ai-font);
  letter-spacing: 0.06em;
}
.dial-badges {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.dial-badge {
  position: absolute;
  right: 0;
  min-width: 40px;
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb, var(--scope-color) 35%, transparent);
  border-radius: 5px;
  background: var(--ai-surface);
  color: var(--scope-color);
  font: 500 11px/1.4 var(--ai-font);
  font-variant-numeric: tabular-nums;
  text-align: center;
  cursor: default;
  pointer-events: auto;
}
.dial-badge:focus-visible {
  outline: 2px solid var(--scope-color);
  outline-offset: 3px;
}
.dial-badge::after {
  content: attr(data-tip);
  display: none;
  position: absolute;
  bottom: calc(100% + 7px);
  right: 0;
  width: max-content;
  max-width: 165px;
  padding: 7px 9px;
  border-radius: 5px;
  background: var(--ai-hover);
  color: var(--ai-ink);
  font-weight: 400;
  z-index: 2;
  text-align: left;
}
.dial-badge:is(:hover, :focus-visible)::after {
  display: block;
}
.history-values {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.history-values span {
  color: var(--scope-color);
}
.resource-history {
  min-height: 152px;
}
.resource__chart {
  display: block;
  width: 100%;
  height: 74px;
  margin-top: 4px;
  overflow: visible;
}
.resource__chart g {
  fill: var(--scope-color);
}
.chart-baseline {
  stroke: var(--ai-line);
  fill: none;
  stroke-dasharray: 2 4;
}
.chart-line {
  fill: none;
  stroke: var(--scope-color);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
}
.resource__chart [data-scope='app'] .chart-line {
  stroke-dasharray: 3 2;
}
.resource__chart [data-scope='model'] .chart-line {
  stroke-dasharray: 7 2;
}
[data-scope='system'] {
  --scope-color: var(--ai-green);
}
[data-scope='app'] {
  --scope-color: #b3a0f7;
}
[data-scope='model'] {
  --scope-color: var(--ai-orange);
}
[data-scope='capacity'] {
  --scope-color: #8ba4ca;
}
[data-scope='temperature-safe'] {
  --scope-color: var(--ai-green);
}
[data-scope='temperature-warning'] {
  --scope-color: var(--ai-orange);
}
[data-scope='temperature-danger'] {
  --scope-color: var(--ai-red);
}
[data-scope='temperature-unknown'] {
  --scope-color: var(--ai-muted);
}
.resource-storage-note {
  display: grid;
  gap: 3px;
  margin-top: 8px;
  font-size: 10px;
  color: var(--ai-muted);
  font-variant-numeric: tabular-nums;
}
.resource.is-stale .resource__chart {
  opacity: 0.55;
}
.resource.is-compact .resource-dial-wrap {
  width: min(100%, 112px);
  aspect-ratio: 1;
}
.resource.is-compact .resource-dial {
  width: 100%;
}
.resource.is-compact .dial-badges {
  inset: auto auto 5px 50%;
  display: grid;
  grid-template-columns: repeat(2, max-content);
  gap: 2px 3px;
  align-content: end;
}
.resource.is-compact .dial-badge {
  position: static;
  min-width: 0;
  padding: 1px 3px;
  border-radius: 3px;
  font-size: 7px;
  line-height: 1.25;
}
.resource.is-compact .dial-badge::after,
.resource.is-compact .resource-storage-note {
  display: none;
}
@media (max-width: 480px) {
  .resource-dial-wrap {
    max-width: 230px;
  }
}
</style>
