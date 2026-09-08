<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ checks: readonly { label: string; value: string; verified: boolean }[] }>()
const summary = computed(() =>
  props.checks.filter(check =>
    [
      'Grafikkarte',
      'Modellschichten auf GPU',
      'GPU-Modellpuffer',
      'CPU-Aufteilung',
      'RAM beim Modellstart',
      'Modellspeicher',
    ].includes(check.label)
  )
)
const profile = computed(() => props.checks.find(check => check.label === 'Automatische Abstimmung'))
const gpuHint = computed(() => props.checks.find(check => check.label === 'GPU-Hinweis'))
</script>

<template>
  <div v-if="summary.length" class="local-resources">
    <p v-if="profile">{{ profile.value }}</p>
    <dl aria-label="Automatische Ressourcennutzung">
      <div v-for="resource in summary" :key="resource.label" :data-verified="resource.verified">
        <dt>{{ resource.label }}</dt>
        <dd>{{ resource.value }}</dd>
      </div>
    </dl>
    <p v-if="gpuHint" class="local-resources__hint" role="status">{{ gpuHint.value }}</p>
  </div>
</template>

<style scoped>
.local-resources {
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
}
.local-resources p {
  margin: 0 0 8px;
  color: var(--text-muted);
}
.local-resources dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 12px;
  margin: 0;
}
.local-resources dl > div {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
}
.local-resources dt {
  margin-bottom: 3px;
  color: var(--text-muted);
}
.local-resources dd {
  margin: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.local-resources p.local-resources__hint {
  margin: 10px 0 0;
}
</style>
