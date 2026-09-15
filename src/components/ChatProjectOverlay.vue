<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    projectId: string
    hasChecklist?: boolean
  }>(),
  { hasChecklist: false }
)

/* No toggle bar of its own — a topbar icon button drives each panel (see App.vue header__tools). */
const contextExpanded = defineModel<boolean>('contextExpanded', { default: false })
const checklistExpanded = defineModel<boolean>('checklistExpanded', { default: false })
const panel = ref<HTMLElement | null>(null)

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
  contextExpanded.value = false
  checklistExpanded.value = false
  await nextTick()
  panel.value?.focus()
}
</script>

<template>
  <section
    ref="panel"
    class="chat-project-overlay"
    aria-label="Projektziele und Checkliste"
    tabindex="-1"
    @keydown.esc="collapse"
  >
    <div v-show="contextExpanded || (hasChecklist && checklistExpanded)" class="chat-project-overlay__content">
      <section v-show="contextExpanded" class="chat-project-overlay__panel">
        <slot name="context" />
      </section>
      <section
        v-if="hasChecklist"
        v-show="checklistExpanded"
        class="chat-project-overlay__panel"
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
  outline: none;
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
/* Context content is rendered in the docked column; keep the strip closed when the slot is empty. */
.chat-project-overlay__panel:empty,
.chat-project-overlay__content:not(:has(.chat-project-overlay__panel:not(:empty))) {
  display: none;
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
  .chat-project-overlay__panel {
    padding: 12px;
  }
  .chat-project-overlay__panel :deep(.info-strip) {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
