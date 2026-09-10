<script setup lang="ts">
import AiIcon from './AiIcon.vue'
import { statusLabels, type ActivityStep } from './types'
defineProps<{ tools: ActivityStep[] }>()
</script>
<template>
  <div v-if="tools.length" class="ai-tool-chips" aria-label="Tool-Aufrufe">
    <details v-for="tool in tools" :key="tool.id" class="ai-tool" :data-status="tool.status">
      <summary>
        <AiIcon
          :name="tool.status === 'done' ? 'check' : 'tool'"
          :size="13"
          :class="{ 'ai-spin': tool.status === 'running' }"
        /><span>{{ tool.label }}</span
        ><span v-if="tool.capability" class="ai-tool__capability">{{ tool.capability }}</span
        ><span v-if="tool.provider" class="ai-tool__retention">{{ tool.provider }}</span
        ><span v-if="tool.model" class="ai-tool__retention">{{ tool.model }}</span
        ><span v-if="tool.dataHandling === 'ephemeral'" class="ai-tool__retention">temporär</span
        ><span class="ai-tool__status">{{ statusLabels[tool.status] }}</span>
      </summary>
      <pre>{{ tool.detail || statusLabels[tool.status] }}</pre>
    </details>
  </div>
</template>
