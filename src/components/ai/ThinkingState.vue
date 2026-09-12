<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import AiIcon from './AiIcon.vue'
import { statusLabels, type ActivityStatus, type ActivityStep } from './types'
import { activityStatusIcon } from './toolPresentation'
import { publicActivityLabel } from '@/services/chatActivity'

const props = withDefaults(
  defineProps<{
    steps?: ActivityStep[]
    active?: boolean
    status?: ActivityStatus
    label?: string
    startedAt?: number
    durationMs?: number
    expanded?: boolean
  }>(),
  {
    steps: () => [],
    status: undefined,
    label: 'Arbeitsschritte',
    startedAt: undefined,
    durationMs: undefined,
    expanded: undefined,
  }
)
const manuallyExpanded = ref<boolean | null>(null)
// Live updates never override the reader's disclosure choice.
const open = computed(() => manuallyExpanded.value ?? props.expanded ?? false)
const id = useId()
const runStatus = computed<ActivityStatus>(() => {
  if (props.status) return props.status
  if (props.active) return props.steps.some(step => step.status === 'waiting') ? 'waiting' : 'running'
  if (props.steps.some(step => step.status === 'failed')) return 'failed'
  if (props.steps.some(step => step.status === 'canceled')) return 'canceled'
  if (props.steps.some(step => step.status === 'waiting')) return 'waiting'
  if (props.steps.some(step => step.status === 'running')) return 'running'
  return props.steps.length && props.steps.every(step => step.status === 'done') ? 'done' : 'pending'
})
const summaryLabel = computed(() => {
  if (runStatus.value === 'failed') return 'Verarbeitung fehlgeschlagen'
  if (runStatus.value === 'canceled') return 'Verarbeitung abgebrochen'
  if (props.label !== 'Arbeitsschritte') return publicActivityLabel(props.label)
  if (runStatus.value === 'waiting') return 'Wartet auf deine Freigabe'
  if (runStatus.value === 'done') return 'Arbeitsschritte abgeschlossen'
  const current = [...props.steps].reverse().find(step => step.status === 'running' || step.status === 'pending')
  return current ? publicActivityLabel(current.label) : props.label
})
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  watch(
    () => [runStatus.value, props.startedAt] as const,
    ([status, startedAt]) => {
      clearInterval(timer)
      now.value = Date.now()
      if ((status === 'running' || status === 'waiting') && startedAt !== undefined) {
        timer = setInterval(() => {
          now.value = Date.now()
        }, 1000)
      }
    },
    { immediate: true }
  )
})
onBeforeUnmount(() => clearInterval(timer))
const durationLabel = computed(() => {
  const duration =
    props.durationMs ??
    (props.startedAt !== undefined && (runStatus.value === 'running' || runStatus.value === 'waiting')
      ? now.value - props.startedAt
      : undefined)
  if (duration === undefined) return undefined
  const seconds = Math.max(0, Math.round(duration / 1000))
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
})
</script>

<template>
  <section class="ai-thinking" :data-status="runStatus" aria-label="Aktivität">
    <button
      class="ai-thinking__toggle"
      type="button"
      :aria-expanded="!!open"
      :aria-controls="id"
      @click="manuallyExpanded = !open"
    >
      <span class="ai-thinking__mark" aria-hidden="true">
        <span v-if="runStatus === 'running'" class="ai-thinking__pulse" />
        <AiIcon v-else :name="activityStatusIcon(runStatus)" :size="14" />
      </span>
      <span class="ai-thinking__summary">
        <span class="ai-thinking__label" role="status">{{ summaryLabel }}</span>
        <span v-if="steps.length" class="ai-thinking__count">
          {{ steps.length }} {{ steps.length === 1 ? 'Schritt' : 'Schritte' }}
        </span>
      </span>
      <span v-if="durationLabel" class="ai-thinking__time" aria-hidden="true">{{ durationLabel }}</span>
      <AiIcon name="chevron" :size="12" class="ai-thinking__chevron" :class="{ 'ai-rotate': open }" />
    </button>
    <div v-show="open" :id="id" class="ai-trace">
      <ol v-if="steps.length" class="ai-trace__list" aria-label="Arbeitsschritte">
        <li v-for="step in steps" :key="step.id" class="ai-trace__row" :data-status="step.status">
          <span class="ai-status-mark" aria-hidden="true">
            <span v-if="step.status === 'running'" class="ai-trace__live-dot" />
            <AiIcon v-else :name="activityStatusIcon(step.status)" :size="12" />
          </span>
          <span class="ai-trace__copy">
            <span>{{ publicActivityLabel(step.label) }}</span>
            <small v-if="step.detail">{{ step.detail }}</small>
          </span>
          <span class="ai-trace__status">{{ statusLabels[step.status] }}</span>
        </li>
      </ol>
      <slot />
    </div>
  </section>
</template>

<style scoped>
.ai-thinking {
  --activity-tone: var(--ai-faint);
  min-width: 0;
  margin: 0 0 12px;
  container-type: inline-size;
}
.ai-thinking[data-status='running'] {
  --activity-tone: var(--ai-accent);
}
.ai-thinking[data-status='waiting'] {
  --activity-tone: var(--ai-orange);
}
.ai-thinking[data-status='failed'] {
  --activity-tone: var(--ai-red);
}
.ai-thinking[data-status='done'] {
  --activity-tone: var(--ai-green);
}
.ai-thinking__toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  margin: 0;
  border-radius: 8px;
  color: var(--ai-muted);
  cursor: pointer;
}
.ai-thinking__toggle:hover {
  background: var(--ai-canvas);
}
.ai-thinking__toggle:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 2px;
}
.ai-thinking__mark {
  display: grid;
  place-items: center;
  flex: 0 0 18px;
  color: var(--activity-tone);
}
.ai-thinking__summary {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  flex: 1;
  min-width: 0;
}
.ai-thinking__label {
  overflow-wrap: anywhere;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.6;
}
.ai-thinking:is([data-status='running'], [data-status='waiting'], [data-status='failed']) .ai-thinking__label {
  color: var(--ai-ink);
}
.ai-thinking__count,
.ai-thinking__time {
  color: var(--ai-faint);
  font-size: 10px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ai-thinking__time {
  font-family: var(--font-mono, monospace);
}
.ai-thinking__toggle > .ai-thinking__chevron {
  flex: 0 0 12px;
  color: var(--ai-faint);
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ai-thinking__pulse,
.ai-trace__live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.ai-thinking__pulse {
  animation: activity-breathe 1800ms cubic-bezier(0.22, 1, 0.36, 1) infinite;
}
.ai-thinking .ai-trace {
  margin: 0;
  padding: 4px 10px 6px;
  border: 0;
}
.ai-trace__list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.ai-thinking .ai-trace__row {
  --step-tone: var(--ai-faint);
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  padding: 8px 0;
  position: relative;
  font-size: 12px;
  line-height: 1.6;
}
.ai-trace__row:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 8px;
  top: 28px;
  bottom: -4px;
  width: 1px;
  background: color-mix(in srgb, var(--ai-line) 65%, transparent);
}
.ai-thinking .ai-status-mark {
  display: grid;
  place-items: center;
  width: 18px;
  height: 20px;
  color: var(--step-tone);
}
.ai-trace__row[data-status='running'] {
  --step-tone: var(--ai-accent);
}
.ai-trace__row[data-status='done'] {
  --step-tone: var(--ai-green);
}
.ai-trace__row[data-status='failed'] {
  --step-tone: var(--ai-red);
}
.ai-trace__row[data-status='waiting'] {
  --step-tone: var(--ai-orange);
}
.ai-trace__copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.ai-thinking .ai-trace__row small {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
}
.ai-trace__status {
  color: var(--ai-faint);
  font-size: 10px;
  white-space: nowrap;
  line-height: 2;
}
.ai-trace__row[data-status='failed'] .ai-trace__status {
  color: var(--ai-red);
}
.ai-trace__row[data-status='waiting'] .ai-trace__status {
  color: var(--ai-orange);
}
@container (max-width: 360px) {
  .ai-thinking__toggle {
    gap: 7px;
    padding-inline: 6px;
  }
  .ai-thinking__summary {
    display: grid;
    gap: 0;
  }
  .ai-thinking .ai-trace {
    padding-inline: 6px;
  }
  .ai-thinking .ai-trace__row {
    gap: 3px 7px;
    grid-template-columns: 18px minmax(0, 1fr);
  }
  .ai-trace__status {
    grid-column: 2;
  }
}
@keyframes activity-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-thinking__pulse {
    animation: none;
  }
  .ai-thinking__toggle > .ai-thinking__chevron {
    transition: none;
  }
}
:global(html[data-reduce-motion='1']) .ai-thinking__pulse {
  animation: none;
}
:global(html[data-reduce-motion='1']) .ai-thinking__toggle > .ai-thinking__chevron {
  transition: none;
}
</style>
