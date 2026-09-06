<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
const props = withDefaults(
  defineProps<{ label?: string; active?: boolean; startedAt?: number; variant?: 'drive' | 'dots' | 'orbit' }>(),
  { label: 'Luczor arbeitet', active: true, variant: 'drive', startedAt: undefined }
)
const now = ref(Date.now())
const start = ref(props.startedAt ?? now.value)
let timer: ReturnType<typeof setInterval> | undefined
watch(
  () => props.active,
  active => {
    clearInterval(timer)
    if (active) {
      start.value = props.startedAt ?? Date.now()
      now.value = Date.now()
      timer = setInterval(() => {
        now.value = Date.now()
      }, 100)
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => clearInterval(timer))
const elapsed = computed(() => `${Math.max(0, (now.value - start.value) / 1000).toFixed(1)} s`)
</script>
<template>
  <div class="ai-loading" :class="{ 'is-active': active }" role="status">
    <span class="ai-pixels" :class="`ai-pixels--${variant}`" aria-hidden="true"
      ><i
        v-for="n in 9"
        :key="n"
        :style="{ animationDelay: `${((n - 1) % 3) * 100 + Math.floor((n - 1) / 3) * 70}ms` }"
    /></span>
    <span :class="{ 'ai-shimmer': active }">{{ label }}</span
    ><span class="ai-time" aria-hidden="true">{{ elapsed }}</span>
  </div>
</template>
