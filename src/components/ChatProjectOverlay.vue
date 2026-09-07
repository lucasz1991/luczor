<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    projectId: string
    goalCount?: number
    goalsDone?: number
    hasChecklist?: boolean
    checklistCount?: number
    checklistDone?: number
  }>(),
  { goalCount: 0, goalsDone: 0, hasChecklist: false, checklistCount: 0, checklistDone: 0 }
)

const contextExpanded = defineModel<boolean>('contextExpanded', { default: false })
const checklistExpanded = defineModel<boolean>('checklistExpanded', { default: false })
const id = useId()
const contextToggle = ref<HTMLButtonElement | null>(null)
const checklistToggle = ref<HTMLButtonElement | null>(null)

watch(
  () => props.projectId,
  () => {
    contextExpanded.value = false
    checklistExpanded.value = false
  }
)
watch(
  () => props.hasChecklist,
  available => {
    if (!available) checklistExpanded.value = false
  }
)

async function collapse(event: KeyboardEvent) {
  if (!contextExpanded.value && !checklistExpanded.value) return
  event.preventDefault()
  event.stopPropagation()
  const fromChecklist = event.target instanceof Element && !!event.target.closest('[data-project-checklist]')
  const focusTarget = fromChecklist ? checklistToggle.value : contextToggle.value
  contextExpanded.value = false
  checklistExpanded.value = false
  await nextTick()
  focusTarget?.focus()
}
</script>

<template>
  <section class="chat-project-overlay" aria-label="Projektziele und Checkliste" @keydown.esc="collapse">
    <div class="chat-project-overlay__controls">
      <button
        :id="`${id}-context-toggle`"
        ref="contextToggle"
        type="button"
        class="chat-project-overlay__toggle"
        :class="{ 'is-open': contextExpanded }"
        :aria-expanded="contextExpanded"
        :aria-controls="`${id}-context`"
        :title="contextExpanded ? 'Projektziele und Kontext einklappen' : 'Projektziele und Kontext ausklappen'"
        @click="contextExpanded = !contextExpanded"
      >
        <span class="chat-project-overlay__label">Projektziele</span>
        <span class="chat-project-overlay__count" :aria-label="`${goalsDone} von ${goalCount} Zielen erledigt`">
          {{ goalsDone }}/{{ goalCount }}
        </span>
        <span class="chat-project-overlay__chevron" aria-hidden="true">⌄</span>
      </button>
      <button
        v-if="hasChecklist"
        :id="`${id}-checklist-toggle`"
        ref="checklistToggle"
        type="button"
        class="chat-project-overlay__toggle"
        :class="{ 'is-open': checklistExpanded }"
        :aria-expanded="checklistExpanded"
        :aria-controls="`${id}-checklist`"
        :title="checklistExpanded ? 'Checkliste einklappen' : 'Checkliste ausklappen'"
        data-project-checklist
        @click="checklistExpanded = !checklistExpanded"
      >
        <span class="chat-project-overlay__label">Checkliste</span>
        <span
          v-if="checklistCount"
          class="chat-project-overlay__count"
          :aria-label="`${checklistDone} von ${checklistCount} Schritten erledigt`"
        >
          {{ checklistDone }}/{{ checklistCount }}
        </span>
        <span class="chat-project-overlay__chevron" aria-hidden="true">⌄</span>
      </button>
    </div>
    <div v-show="contextExpanded || (hasChecklist && checklistExpanded)" class="chat-project-overlay__content">
      <section
        v-show="contextExpanded"
        :id="`${id}-context`"
        class="chat-project-overlay__panel"
        :aria-labelledby="`${id}-context-toggle`"
      >
        <slot name="context" />
      </section>
      <section
        v-if="hasChecklist"
        v-show="checklistExpanded"
        :id="`${id}-checklist`"
        class="chat-project-overlay__panel"
        :aria-labelledby="`${id}-checklist-toggle`"
        data-project-checklist
      >
        <slot name="checklist" />
      </section>
    </div>
  </section>
</template>

<style scoped>
.chat-project-overlay {
  position: absolute;
  z-index: 12;
  inset-block-start: 8px;
  inset-inline: 16px;
  display: grid;
  gap: 8px;
  min-width: 0;
  pointer-events: none;
}
.chat-project-overlay__controls {
  display: flex;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}
.chat-project-overlay__toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 38px;
  padding: 7px 12px;
  border: 1px solid var(--border-soft, #344050);
  border-radius: var(--r-md, 9px);
  background: var(--ai-surface, #131b27);
  color: var(--text-secondary, #c3cedd);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 3px 12px rgb(0 0 0 / 12%);
}
.chat-project-overlay__toggle:hover,
.chat-project-overlay__toggle.is-open {
  border-color: var(--border-strong, #5e7b99);
  color: var(--text-primary, #edf2f9);
}
.chat-project-overlay__toggle:focus-visible {
  outline: 2px solid var(--cy, #4ea8de);
  outline-offset: 3px;
}
.chat-project-overlay__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-project-overlay__count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #96a5b8);
  white-space: nowrap;
}
.chat-project-overlay__chevron {
  line-height: 1;
}
.is-open .chat-project-overlay__chevron {
  transform: rotate(180deg);
}
.chat-project-overlay__content {
  display: grid;
  gap: 12px;
  width: min(100%, 900px);
  max-height: min(52vh, 480px);
  min-height: 0;
  margin-inline: auto;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border: 1px solid var(--border-soft, #344050);
  border-radius: var(--r-lg, 12px);
  background: var(--ai-surface, #131b27);
  box-shadow: 0 12px 30px rgb(0 0 0 / 20%);
  pointer-events: auto;
}
.chat-project-overlay__panel {
  min-width: 0;
  padding: 12px;
  overflow-wrap: anywhere;
}
.chat-project-overlay__panel :deep(.info-strip) {
  padding: 0;
  border: 0;
}
.chat-project-overlay__panel :deep(.info-block) {
  min-width: 0;
}
.chat-project-overlay__panel :deep(.plan) {
  max-width: none;
  margin: 0;
}
.chat-project-overlay__panel :deep(.info-head) {
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  .chat-project-overlay {
    inset-inline: 8px;
  }
  .chat-project-overlay__controls {
    gap: 6px;
  }
  .chat-project-overlay__toggle {
    gap: 5px;
    min-height: 42px;
    padding-inline: 8px;
    font-size: 11px;
  }
  .chat-project-overlay__panel {
    padding: 10px;
  }
  .chat-project-overlay__panel :deep(.info-strip) {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
