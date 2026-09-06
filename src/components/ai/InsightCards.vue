<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Insight } from './types'
const props = defineProps<{ insights: Insight[] }>()
const index = ref(0)
watch(
  () => props.insights.length,
  length => {
    index.value = Math.max(0, Math.min(index.value, length - 1))
  }
)
const current = computed(() => props.insights[index.value])
const points = computed(() => {
  const values = current.value?.points ?? []
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  return values
    .map(
      (value, index) =>
        `${(index * 300) / Math.max(1, values.length - 1)},${90 - ((value - min) / (max - min || 1)) * 80}`
    )
    .join(' ')
})
</script>
<template>
  <section v-if="current" class="ai-card ai-insight">
    <header>
      <span class="ai-eyebrow">Einblicke · {{ index + 1 }}/{{ insights.length }}</span>
      <div>
        <button
          type="button"
          class="ai-icon-button"
          aria-label="Vorheriger Einblick"
          :disabled="index === 0"
          @click="index--"
        >
          ←</button
        ><button
          type="button"
          class="ai-icon-button"
          aria-label="Nächster Einblick"
          :disabled="index >= insights.length - 1"
          @click="index++"
        >
          →
        </button>
      </div>
    </header>
    <h3>{{ current.title }}</h3>
    <strong class="ai-insight__value">{{ current.value }}</strong>
    <p>{{ current.description }}</p>
    <svg
      v-if="current.points.length"
      viewBox="0 0 300 100"
      role="img"
      :aria-label="`Verlauf: ${current.points.join(', ')}`"
    >
      <path d="M0 95H300M0 50H300M0 5H300" stroke="var(--ai-line)" fill="none" />
      <polyline :points="points" fill="none" stroke="var(--ai-accent)" stroke-width="2" stroke-linejoin="round" />
    </svg>
  </section>
</template>
