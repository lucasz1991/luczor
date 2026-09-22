<script setup lang="ts">
import { computed } from 'vue'
import {
  dialDisplay,
  dialScope,
  diskScopes,
  gibibytes,
  meterTile,
  meterUsage,
  type ResourceMeter,
  type ResourceDialSeries,
  type ResourceView,
} from '../resourceModel'

const props = defineProps<{
  meter: ResourceMeter
  view: ResourceView
  compact: boolean
  stale: boolean
}>()
const usage = computed(() => meterUsage(props.meter))
const innerSeries = computed<ResourceDialSeries[]>(() =>
  props.meter.key === 'ram'
    ? [
        {
          key: 'capacity' as const,
          label: 'Belegt',
          detail: 'Gesamter Arbeitsspeicher',
          value: props.meter.series[0]?.value ?? null,
        },
      ]
    : props.meter.series.slice(3)
)
/* Sidebar tile: headline value, secondary reading and severity. */
const tile = computed(() => meterTile(props.meter))
function continuousColor(value: number | null, maximum = 100) {
  if (value === null) return 'var(--ai-muted)'
  const bounded = Math.min(maximum, Math.max(0, value))
  if (maximum === 130) {
    const hue = Math.max(0, (85 - bounded) * 2)
    return `hsl(${hue} 78% ${52 - Math.max(0, bounded - 85) * 0.4}%)`
  }
  return `hsl(${120 * (1 - bounded / maximum)} 78% 52%)`
}
</script>

<template>
  <article
    class="resource"
    :class="{ 'is-compact': compact, 'is-stale': stale, 'is-tile': compact, 'is-card': !compact && view === 'circles' }"
    :data-lvl="compact ? tile.level : undefined"
  >
    <h5 :class="{ 'ai-sr-only': view === 'circles' || compact }">{{ meter.label }}</h5>
    <div v-if="view === 'circles' || compact" class="resource-dial-wrap">
      <div class="resource-bars">
        <svg
          class="resource-dial"
          :viewBox="compact ? '0 0 120 102' : '0 0 120 120'"
          role="img"
          :aria-label="`${meter.label} Auslastungsverteilung`"
        >
          <g transform="rotate(135 60 60)">
            <circle class="dial-track" cx="60" cy="60" r="49" pathLength="100" stroke-dasharray="75 100" />
            <circle
              v-for="(series, index) in usage"
              :key="series.key"
              :data-scope="series.key"
              class="dial-value"
              cx="60"
              cy="60"
              r="49"
              pathLength="100"
              :stroke-dasharray="`${series.width * 0.75} 100`"
              :stroke-dashoffset="-usage.slice(0, index).reduce((sum, item) => sum + item.width * 0.75, 0)"
            >
              <title>{{ series.label }}: {{ dialDisplay(series) }}</title>
            </circle>
            <g
              v-for="(series, index) in innerSeries"
              :key="series.key"
              :style="{
                '--scope-color': continuousColor(
                  series.colorValue ?? series.value,
                  series.key === 'temperature' ? 130 : 100
                ),
              }"
            >
              <circle
                class="dial-track"
                cx="60"
                cy="60"
                :r="35 - index * 10"
                pathLength="100"
                stroke-dasharray="75 100"
              />
              <circle
                v-if="series.value !== null"
                class="dial-value"
                cx="60"
                cy="60"
                :r="35 - index * 10"
                pathLength="100"
                :stroke-dasharray="`${series.value * 0.75} 100`"
              >
                <title>{{ series.detail }}: {{ dialDisplay(series) }}</title>
              </circle>
            </g>
          </g>
          <template v-if="compact">
            <text class="dial-total" x="60" y="60" text-anchor="middle">
              {{ tile.value }}
              <tspan v-if="tile.unit" class="dial-total__unit">{{ tile.unit }}</tspan>
            </text>
            <text v-if="tile.sub" class="dial-sub" :data-tone="tile.subTone" x="60" y="76" text-anchor="middle">
              {{ tile.sub }}
            </text>
          </template>
          <template v-else>
            <text x="60" y="58" text-anchor="middle">{{ meter.label }}</text>
            <text v-if="innerSeries[0]" class="dial-reading" x="60" y="73" text-anchor="middle">
              {{ dialDisplay(innerSeries[0]) }}
            </text>
          </template>
        </svg>
        <div v-if="compact" class="tile-text" :title="meter.detail">{{ meter.label }}</div>
        <div v-if="!compact" class="usage-legend">
          <span v-for="series in usage" :key="series.key" :data-scope="series.key">
            {{ series.label }} {{ dialDisplay(series) }}
          </span>
        </div>
        <div
          v-for="series in compact ? [] : innerSeries"
          :key="series.key"
          class="inner-meter"
          :style="{
            '--scope-color': continuousColor(
              series.colorValue ?? series.value,
              series.key === 'temperature' ? 130 : 100
            ),
          }"
        >
          <div class="inner-meter-label" :title="series.detail">
            {{ series.label }} <span>{{ dialDisplay(series) }}</span>
          </div>
        </div>
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
    <div v-if="meter.disk && !compact" class="resource-storage-note">
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
  min-height: 152px;
  margin: auto;
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
  --scope-color: var(--ai-accent);
}
[data-scope='model'] {
  --scope-color: var(--ai-orange);
}
[data-scope='capacity'] {
  --scope-color: var(--ai-info, #7aa7c7);
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
@media (max-width: 480px) {
  .resource-dial-wrap {
    max-width: 230px;
  }
}
</style>

<style scoped>
.resource-bars {
  display: grid;
  gap: 10px;
  padding: 8px 0;
}
.resource-bars strong {
  font-size: 12px;
  font-weight: 600;
}
.usage-bar {
  display: flex;
  width: 100%;
  height: 9px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--ai-line);
}
.usage-bar span {
  display: block;
  height: 100%;
  background: var(--scope-color);
  transition:
    width 0.25s ease,
    background-color 0.25s ease;
}
.usage-legend {
  display: grid;
  gap: 4px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.usage-legend span {
  color: var(--scope-color);
}
.inner-meter {
  display: grid;
  gap: 5px;
}
.inner-meter-label {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--scope-color);
}
.is-stale .resource-bars {
  opacity: 0.55;
}
@media (prefers-reduced-motion: reduce) {
  .usage-bar span {
    transition: none;
  }
}
</style>

<style scoped>
.resource-dial {
  display: block;
  width: min(100%, 180px);
  margin: auto;
  overflow: visible;
}
.resource-dial circle {
  fill: none;
  stroke-width: 7;
  stroke-linecap: butt;
  transition:
    stroke 0.4s var(--ease, ease),
    stroke-dasharray 0.7s var(--ease, ease),
    stroke-dashoffset 0.7s var(--ease, ease);
}
.dial-track {
  stroke: var(--ai-line-strong);
  opacity: 0.55;
}
.dial-value {
  stroke: var(--scope-color);
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--scope-color) 45%, transparent));
}
.resource-dial text {
  fill: var(--ai-ink);
  font: 600 12px var(--ai-font);
  letter-spacing: 0.08em;
}
.resource-dial .dial-reading {
  fill: var(--ai-muted);
  font: 500 11px var(--font-mono, monospace);
  letter-spacing: 0;
}
/* Tabs and full screen: every meter is a glass card around the layered dial. */
.resource.is-card {
  padding: 14px 14px 12px;
  border: 1px solid var(--ai-line);
  border-radius: 18px;
  background: color-mix(in srgb, var(--ai-surface) 55%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ai-ink) 6%, transparent);
  transition:
    border-color 220ms var(--ease, ease),
    transform 220ms var(--ease, ease),
    box-shadow 220ms var(--ease, ease);
}
.resource.is-card:hover {
  border-color: var(--ai-line-strong);
  transform: translateY(-1px);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ai-ink) 8%, transparent),
    0 18px 36px -28px rgba(0, 0, 0, 0.6);
}
.resource.is-card .usage-legend {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--ai-line);
}
.resource.is-card .usage-legend span,
.resource.is-card .inner-meter-label {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: baseline;
  gap: 0 8px;
  color: var(--ai-muted);
  font-variant-numeric: tabular-nums;
}
.resource.is-card .usage-legend span::before,
.resource.is-card .inner-meter-label::before {
  content: '';
  width: 6px;
  height: 6px;
  margin-right: 2px;
  border-radius: 50%;
  background: var(--scope-color);
}
.resource.is-card .inner-meter-label > span {
  color: var(--ai-ink);
  font: 500 10px var(--font-mono, monospace);
}
/* Sidebar tile: the same layered ring at 58px next to label, mono value and secondary reading. */
.resource.is-tile {
  position: relative;
  padding: 6px 8px 2px;
  border: 1px solid var(--ai-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ai-ink) 3.5%, transparent);
  transition:
    border-color 200ms var(--ease, ease),
    background 200ms var(--ease, ease);
}
.resource.is-tile:hover {
  border-color: var(--ai-line-strong);
  background: color-mix(in srgb, var(--ai-ink) 5.5%, transparent);
}
.resource.is-tile .resource-dial-wrap {
  width: 100%;
  min-height: 0;
}
.resource.is-tile .resource-bars {
  display: grid;
  gap: 0;
  padding: 0;
}
.resource.is-tile .resource-dial {
  width: min(100%, 132px);
  margin: 0 auto;
}
.resource.is-tile .resource-dial circle {
  stroke-width: 8;
}
.resource.is-tile .dial-total {
  fill: var(--ai-ink);
  font: 600 20px var(--font-mono, monospace);
  letter-spacing: -0.03em;
}
.resource.is-tile .dial-total__unit {
  fill: var(--ai-muted);
  font-size: 10px;
  font-weight: 400;
}
.is-tile[data-lvl='warn'] .dial-total {
  fill: var(--ai-orange);
}
.is-tile[data-lvl='bad'] .dial-total {
  fill: var(--ai-red);
}
.resource.is-tile .dial-sub {
  fill: var(--ai-accent);
  font: 400 8.5px var(--font-mono, monospace);
}
.resource.is-tile .dial-sub[data-tone='warning'] {
  fill: var(--ai-orange);
}
.resource.is-tile .dial-sub[data-tone='danger'] {
  fill: var(--ai-red);
}
.tile-text {
  position: absolute;
  top: 7px;
  left: 9px;
  color: var(--ai-faint);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.1em;
  line-height: 1;
  text-transform: uppercase;
  pointer-events: none;
}
.is-tile.is-stale {
  opacity: 0.6;
}
@media (prefers-reduced-motion: reduce) {
  .resource-dial circle {
    transition: none;
  }
}
</style>
