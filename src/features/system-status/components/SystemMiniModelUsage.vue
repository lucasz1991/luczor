<script setup lang="ts">
import type { CompactModelMetric } from '../resourceModel'

withDefaults(
  defineProps<{
    metrics: CompactModelMetric[]
    modelStatus: string
    running: boolean
    charts?: { label: string; path: string }[]
  }>(),
  { charts: () => [] }
)
</script>

<template>
  <section class="compact-model-usage" aria-label="Lokale Modellbenutzung">
    <div class="compact-model-usage__heading">
      <span>Lokales Modell</span><strong :data-running="running">{{ modelStatus }}</strong>
    </div>
    <dl>
      <div v-for="metric in metrics" :key="metric.label">
        <dt>{{ metric.label }}</dt>
        <dd>{{ metric.value }}</dd>
      </div>
    </dl>
    <svg
      v-if="charts.length"
      class="compact-model-usage__chart"
      viewBox="0 0 180 74"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path class="compact-model-usage__grid" d="M4 8H176M4 38H176M4 68H176" />
      <path
        v-for="(chart, index) in charts"
        :key="chart.label"
        class="compact-model-usage__line"
        :data-line="index"
        :d="chart.path"
      />
    </svg>
    <div v-if="charts.length" class="compact-model-usage__legend">
      <span v-for="(chart, index) in charts" :key="chart.label" :data-line="index"><i />{{ chart.label }}</span>
    </div>
  </section>
</template>

<style scoped>
.compact-model-usage {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding: 9px 10px 10px;
  border: 1px solid var(--ai-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ai-ink) 3.5%, transparent);
  transition:
    border-color 200ms var(--ease, ease),
    background 200ms var(--ease, ease);
}
.compact-model-usage:hover {
  border-color: var(--ai-line-strong);
  background: color-mix(in srgb, var(--ai-ink) 5.5%, transparent);
}
.compact-model-usage > * {
  min-width: 0;
}
.compact-model-usage__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.compact-model-usage__heading > span {
  flex-shrink: 0;
  color: var(--ai-muted);
  white-space: nowrap;
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.compact-model-usage__heading strong {
  min-width: 0;
  overflow: hidden;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--ai-hover);
  color: var(--ai-muted);
  font-size: 8.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compact-model-usage__heading strong[data-running='true'] {
  background: color-mix(in srgb, var(--ai-green) 14%, transparent);
  color: var(--ai-green);
}
.compact-model-usage dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 10px;
  margin: 0;
}
.compact-model-usage dl > div {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
}
.compact-model-usage dt,
.compact-model-usage dd {
  margin: 0;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
}
.compact-model-usage dt {
  color: var(--ai-muted);
}
.compact-model-usage dd {
  overflow: hidden;
  color: var(--ai-ink);
  font-family: var(--font-mono, monospace);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compact-model-usage__chart {
  display: block;
  width: 100%;
  height: 30px;
  margin-top: 4px;
  overflow: visible;
}
.compact-model-usage__grid {
  fill: none;
  stroke: var(--ai-line);
  stroke-dasharray: 2 4;
}
.compact-model-usage__line {
  fill: none;
  stroke: var(--line-color);
  stroke-width: 1.5;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.compact-model-usage__line[data-line='1'] {
  stroke-dasharray: 5 3;
}
.compact-model-usage__legend {
  display: flex;
  gap: 10px;
  color: var(--ai-muted);
  font-size: 9px;
}
.compact-model-usage__legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.compact-model-usage__legend i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--line-color);
}
[data-line='0'] {
  --line-color: var(--ai-orange);
}
[data-line='1'] {
  --line-color: var(--ai-accent);
}
</style>
