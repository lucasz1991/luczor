<script setup lang="ts">
import { computed } from 'vue'
import {
  dialDisplay,
  dialScope,
  diskScopes,
  gibibytes,
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
const usage = computed(() => {
  const series = props.meter.series.slice(0, 3)
  const total = series[0]?.value
  const app = series[1]?.value
  const model = series[2]?.value
  const modelInactive = series[2]?.detail.includes('nicht aktiv') ?? false
  const disk = !!props.meter.disk
  const raw = disk
    ? [total, app, model]
    : [
        total === null || total === undefined || app === null || (model === null && !modelInactive)
          ? null
          : Math.max(0, total - (app ?? 0) - (model ?? 0)),
        app,
        model,
      ]
  const sum = raw.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  return series.map((series, index) => ({
    ...series,
    value: raw.at(index) ?? null,
    label:
      (disk ? ['Aktiv', 'Lesen', 'Schreiben'].at(index) : ['System', 'App', 'Lokales Modell'].at(index)) ??
      series.label,
    width: ((raw.at(index) ?? 0) / Math.max(100, sum)) * 100,
  }))
})
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
  <article class="resource" :class="{ 'is-compact': compact, 'is-stale': stale }">
    <h5 :class="{ 'ai-sr-only': view === 'circles' || compact }">{{ meter.label }}</h5>
    <div v-if="view === 'circles' || compact" class="resource-dial-wrap">
      <div class="resource-bars">
        <svg
          class="resource-dial"
          viewBox="0 0 120 120"
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
          <text x="60" y="58" text-anchor="middle">{{ meter.label }}</text>
          <text v-if="innerSeries[0]" class="dial-reading" x="60" y="73" text-anchor="middle">
            {{ dialDisplay(innerSeries[0]) }}
          </text>
        </svg>
        <div class="usage-legend">
          <span v-for="series in usage" :key="series.key" :data-scope="series.key">
            {{ series.label }} {{ dialDisplay(series) }}
          </span>
        </div>
        <div
          v-for="series in innerSeries"
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
  min-height: 0;
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
.is-compact .resource-dial-wrap {
  width: 100%;
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
    stroke 0.25s ease,
    stroke-dasharray 0.25s ease,
    stroke-dashoffset 0.25s ease;
}
.dial-track {
  stroke: var(--ai-line);
}
.dial-value {
  stroke: var(--scope-color);
}
.resource-dial text {
  fill: var(--ai-ink);
  font: 600 12px var(--ai-font);
}
.resource-dial .dial-reading {
  fill: var(--ai-muted);
  font-size: 10px;
  font-weight: 400;
}
.is-compact .resource-bars {
  gap: 3px;
  padding: 0;
}
.is-compact .usage-legend {
  font-size: 8px;
  gap: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .resource-dial circle {
    transition: none;
  }
}
</style>
