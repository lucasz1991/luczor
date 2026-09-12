<script setup lang="ts">
import TokenCounter from './TokenCounter.vue'
import ThinkingBudgetControl from './ThinkingBudgetControl.vue'
import type { TokenUsage } from '@/services/tokenUsage'
import type { ThinkingBudgetProgress, ThinkingControlAction } from '@/services/inference/thinking'

defineProps<{
  messageId: string
  activeMessageId?: string
  active?: boolean
  usage?: TokenUsage
  budget?: ThinkingBudgetProgress | null
  control?: (
    requestId: string,
    action: ThinkingControlAction,
    sequence: number
  ) => Promise<ThinkingBudgetProgress | void>
}>()
const emit = defineEmits<{ stop: [] }>()
</script>

<template>
  <footer class="ai-response-footer" aria-label="Antwortstatus">
    <TokenCounter :usage="usage" :active="active" />
    <ThinkingBudgetControl
      v-if="active && budget && activeMessageId === messageId"
      :progress="budget"
      :control="control"
      @stop="emit('stop')"
    />
  </footer>
</template>

<style scoped>
.ai-response-footer {
  min-width: 0;
}
</style>
