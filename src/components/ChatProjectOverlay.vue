<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue'
import AiIcon from './ai/AiIcon.vue'

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

function toggleContext() {
  contextExpanded.value = !contextExpanded.value
  if (contextExpanded.value) checklistExpanded.value = false
}

function toggleChecklist() {
  checklistExpanded.value = !checklistExpanded.value
  if (checklistExpanded.value) contextExpanded.value = false
}
</script>

<template>
  <section class="chat-project-overlay" aria-label="Projektziele und Checkliste" @keydown.esc="collapse">
    <div class="chat-project-overlay__controls" role="tablist" aria-label="Projektinformationen">
      <button
        :id="`${id}-context-toggle`"
        ref="contextToggle"
        type="button"
        class="chat-project-overlay__toggle"
        :class="{ 'is-open': contextExpanded }"
        role="tab"
        :aria-selected="contextExpanded"
        :aria-expanded="contextExpanded"
        :aria-controls="`${id}-context`"
        :title="contextExpanded ? 'Projektziele und Kontext einklappen' : 'Projektziele und Kontext ausklappen'"
        @click="toggleContext"
      >
        <AiIcon name="check" :size="14" />
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
        role="tab"
        :aria-selected="checklistExpanded"
        :aria-expanded="checklistExpanded"
        :aria-controls="`${id}-checklist`"
        :title="checklistExpanded ? 'Checkliste einklappen' : 'Checkliste ausklappen'"
        data-project-checklist
        @click="toggleChecklist"
      >
        <AiIcon name="grid" :size="14" />
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
        role="tabpanel"
        :aria-labelledby="`${id}-context-toggle`"
      >
        <slot name="context" />
      </section>
      <section
        v-if="hasChecklist"
        v-show="checklistExpanded"
        :id="`${id}-checklist`"
        class="chat-project-overlay__panel"
        role="tabpanel"
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
  inset-block-start: 0;
  inset-inline: 0;
  display: grid;
  gap: 0;
  min-width: 0;
  pointer-events: none;
}
.chat-project-overlay__controls {
  display: flex;
  justify-content: flex-start;
  gap: 2px;
  min-width: 0;
  min-height: 48px;
  padding: 6px 24px;
  border-bottom: 1px solid var(--ai-line, #29313b);
  background: color-mix(in srgb, var(--ai-page, #101317) 94%, transparent);
  backdrop-filter: blur(18px);
  pointer-events: auto;
}
.chat-project-overlay__toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 36px;
  padding: 7px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary, #c3cedd);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: none;
}
.chat-project-overlay__toggle:hover,
.chat-project-overlay__toggle.is-open {
  background: var(--ai-hover, #1b222b);
  color: var(--text-primary, #edf2f9);
}
.chat-project-overlay__toggle.is-open::after {
  content: '';
  position: absolute;
  right: 9px;
  bottom: -6px;
  left: 9px;
  height: 2px;
  border-radius: 2px;
  background: var(--ai-accent, #7c9cff);
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
  width: 100%;
  max-height: min(48vh, 520px);
  min-height: 0;
  margin-inline: auto;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border: 0;
  border-bottom: 1px solid var(--border-soft, #344050);
  border-radius: 0 0 12px 12px;
  background: color-mix(in srgb, var(--ai-surface, #131b27) 97%, transparent);
  box-shadow: 0 16px 34px rgb(0 0 0 / 24%);
  pointer-events: auto;
}
.chat-project-overlay__panel {
  min-width: 0;
  padding: 16px 24px 20px;
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
  .chat-project-overlay__controls {
    gap: 6px;
    padding-inline: 10px;
  }
  .chat-project-overlay__toggle {
    gap: 5px;
    min-height: 42px;
    padding-inline: 8px;
    font-size: 11px;
  }
  .chat-project-overlay__panel {
    padding: 12px;
  }
  .chat-project-overlay__panel :deep(.info-strip) {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
