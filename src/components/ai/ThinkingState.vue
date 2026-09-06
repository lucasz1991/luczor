<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import AiIcon from './AiIcon.vue'
import LoadingState from './LoadingState.vue'
import { statusLabels, type ActivityStep } from './types'
const props = withDefaults(
  defineProps<{
    steps?: ActivityStep[]
    active?: boolean
    label?: string
    startedAt?: number
    durationMs?: number
    expanded?: boolean
  }>(),
  { steps: () => [], label: 'Arbeitsschritte', startedAt: undefined, durationMs: undefined, expanded: undefined }
)
const manuallyExpanded = ref<boolean | null>(null)
const open = computed(() => manuallyExpanded.value ?? props.expanded ?? props.active)
const id = useId()
</script>
<template>
  <section class="ai-thinking">
    <button
      class="ai-thinking__toggle"
      type="button"
      :aria-expanded="!!open"
      :aria-controls="id"
      @click="manuallyExpanded = !open"
    >
      <LoadingState v-if="active" :label="label" :started-at="startedAt" />
      <template v-else
        ><AiIcon /><span>{{ label }}</span
        ><span v-if="durationMs != null" class="ai-time">{{ (durationMs / 1000).toFixed(1) }} s</span></template
      >
      <AiIcon name="chevron" :size="13" :class="{ 'ai-rotate': open }" />
    </button>
    <div v-show="open" :id="id" class="ai-trace">
      <div v-for="step in steps" :key="step.id" class="ai-trace__row" :data-status="step.status">
        <span class="ai-status-mark" :class="{ 'ai-spinner': step.status === 'running' }" aria-hidden="true"
          ><AiIcon v-if="step.status === 'done'" name="check" :size="13" /><AiIcon
            v-else-if="step.status === 'failed' || step.status === 'canceled'"
            name="close"
            :size="13"
          /><span v-else-if="step.status !== 'running'">·</span></span
        >
        <span
          >{{ step.label }}<small v-if="step.detail">{{ step.detail }}</small></span
        ><span class="ai-sr-only">{{ statusLabels[step.status] }}</span>
      </div>
      <slot />
    </div>
  </section>
</template>
