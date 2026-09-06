<!-- components/PlanPanel.vue
     Visible step checklist for the active project, maintained by the model via
     the `plan_update` tool (Codex-style planning).

     Read-only surface: the user can collapse it or clear it, but step statuses
     are owned by the agent. Renders nothing when no plan exists, so it never
     takes up space during simple one-shot chats. -->
<script setup lang="ts">
import { computed } from 'vue'
import TaskRows from './ai/TaskRows.vue'
import type { ActivityStep } from './ai/types'
import { clearPlan, currentPlanStep, getPlan, isPlanComplete, planProgress } from '@/services/plan'

const props = defineProps<{
  projectId: string
  /** Collapsed state is owned by the parent so it survives re-renders. */
  collapsed?: boolean
}>()

const emit = defineEmits<{ (e: 'toggle'): void }>()

const plan = computed(() => getPlan(props.projectId))
const hasPlan = computed(() => plan.value.steps.length > 0)
const progress = computed(() => planProgress(plan.value))
const active = computed(() => currentPlanStep(plan.value))
const complete = computed(() => isPlanComplete(plan.value))

const tasks = computed<ActivityStep[]>(() =>
  plan.value.steps.map((step, index) => ({
    id: String(index),
    label: step.title,
    status:
      step.status === 'in_progress'
        ? 'running'
        : step.status === 'done'
          ? 'done'
          : step.status === 'skipped'
            ? 'canceled'
            : 'pending',
  }))
)

function onClear() {
  clearPlan(props.projectId)
}
</script>

<template>
  <section v-if="hasPlan" class="plan" :class="{ 'is-collapsed': collapsed, 'is-complete': complete }">
    <header class="plan__head">
      <button
        type="button"
        class="plan__toggle"
        :aria-expanded="!collapsed"
        :title="collapsed ? 'Plan aufklappen' : 'Plan einklappen'"
        @click="emit('toggle')"
      >
        <span class="plan__chevron" :class="{ 'is-open': !collapsed }" aria-hidden="true">›</span>
        <span class="plan__title">{{ complete ? 'Plan abgeschlossen' : 'Plan' }}</span>
        <span class="plan__count">{{ progress.done }}/{{ progress.total }}</span>
      </button>

      <span v-if="active && collapsed" class="plan__active" :title="active.title">{{ active.title }}</span>

      <div class="plan__bar" :aria-label="`Fortschritt ${progress.percent} Prozent`">
        <i :style="{ width: progress.percent + '%' }" />
      </div>

      <button type="button" class="plan__clear" title="Plan verwerfen" aria-label="Plan verwerfen" @click="onClear">
        ×
      </button>
    </header>

    <TaskRows v-if="!collapsed" :tasks="tasks" />

    <p v-if="!collapsed && plan.note" class="plan__note">{{ plan.note }}</p>
  </section>
</template>

<style scoped>
.plan {
  margin: 0 auto var(--s2, 8px);
  max-width: 780px;
  width: 100%;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg, 12px);
  background: var(--surface-1, rgba(255, 255, 255, 0.03));
  overflow: hidden;
}
.plan.is-complete {
  opacity: 0.78;
}

.plan__head {
  display: flex;
  align-items: center;
  gap: var(--s2, 8px);
  padding: 0.5em 0.6em;
}

.plan__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
  flex-shrink: 0;
}
.plan__chevron {
  display: inline-block;
  transition: transform 0.16s ease;
  color: var(--text-muted);
}
.plan__chevron.is-open {
  transform: rotate(90deg);
}
.plan__title {
  font-family: var(--font-mono, monospace);
  font-size: 10.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.plan__count {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.plan__active {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text-muted);
}

.plan__bar {
  flex: 1;
  min-width: 40px;
  height: 3px;
  border-radius: 2px;
  background: rgba(127, 127, 127, 0.22);
  overflow: hidden;
}
.plan__bar > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--cy, #4ea8de);
  transition: width 0.28s ease;
}

.plan__clear {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.plan__clear:hover {
  background: rgba(127, 127, 127, 0.14);
  color: var(--text-primary);
}

.plan__steps {
  margin: 0;
  padding: 0 0.6em 0.5em;
  list-style: none;
}
.plan__step {
  display: flex;
  align-items: baseline;
  gap: 0.55em;
  padding: 0.24em 0;
  font-size: 13px;
  line-height: 1.45;
}
.plan__mark {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--border-soft);
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  color: var(--text-muted);
  align-self: center;
}
.plan__text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.plan__status {
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  opacity: 0.75;
}

.plan__step.is-done .plan__text {
  color: var(--text-muted);
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.plan__step.is-done .plan__mark {
  border-color: transparent;
  background: rgba(80, 200, 130, 0.2);
  color: #6ede9e;
}
.plan__step.is-skipped .plan__text {
  color: var(--text-muted);
  opacity: 0.72;
}
.plan__step.is-in_progress .plan__text {
  color: var(--text-primary);
  font-weight: 600;
}
.plan__step.is-in_progress .plan__mark {
  border-color: var(--cy, #4ea8de);
}

.plan__spin {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cy, #4ea8de);
  animation: plan-pulse 1.3s ease-in-out infinite;
}
@keyframes plan-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}

.plan__note {
  margin: 0;
  padding: 0 0.75em 0.6em 2em;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
