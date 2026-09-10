<script setup lang="ts">
import type { CompactModelMetric } from '../resourceModel'

defineProps<{
  metrics: CompactModelMetric[]
  modelStatus: string
  running: boolean
}>()
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
  </section>
</template>

<style scoped>
.compact-model-usage {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--ai-line);
}
.compact-model-usage__heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  color: var(--ai-muted);
  font-size: 9px;
}
.compact-model-usage__heading > span {
  color: var(--ai-ink);
  font-weight: 600;
}
.compact-model-usage__heading strong {
  max-width: 92px;
  overflow: hidden;
  color: var(--ai-muted);
  font-size: 8px;
  font-weight: 500;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compact-model-usage__heading strong[data-running='true'] {
  color: var(--ai-green);
}
.compact-model-usage dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px 10px;
  margin: 9px 0 0;
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
  font-size: 8px;
  font-variant-numeric: tabular-nums;
}
.compact-model-usage dt {
  color: var(--ai-muted);
}
.compact-model-usage dd {
  overflow: hidden;
  color: var(--ai-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
