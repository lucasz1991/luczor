<script setup lang="ts">
defineOptions({ name: 'AiFlowchart' })
import { ref } from 'vue'
import AiIcon from './AiIcon.vue'
import { statusLabels, type ActivityStep } from './types'
defineProps<{ steps: ActivityStep[] }>()
const selected = ref('')
</script>
<template>
  <div class="ai-flow" aria-label="Ablauf">
    <template v-for="(step, index) in steps" :key="step.id"
      ><div v-if="index" class="ai-flow__connector" aria-hidden="true" />
      <button
        type="button"
        class="ai-flow__node ai-card"
        :data-status="step.status"
        :aria-expanded="selected === step.id"
        @click="selected = selected === step.id ? '' : step.id"
      >
        <span class="ai-eyebrow"
          ><AiIcon :name="index === 0 ? 'spark' : 'tool'" />{{ index === 0 ? 'Start' : `Schritt ${index + 1}` }}</span
        ><strong>{{ step.label }}</strong
        ><small>{{ statusLabels[step.status] }}</small>
        <p v-if="selected === step.id && step.detail">{{ step.detail }}</p>
      </button></template
    >
    <p v-if="!steps.length" class="ai-empty">Noch kein Ablauf vorhanden.</p>
  </div>
</template>
