<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import AiIcon from './AiIcon.vue'
import { useDismissible } from '@/composables/useDismissible'
export type HeaderAction = {
  id: string
  label: string
  icon: string
  active?: boolean
  disabled?: boolean
  divider?: boolean
}
defineProps<{ label: string; icon: string; items: HeaderAction[] }>()
const emit = defineEmits<{ action: [id: string] }>()
const id = useId()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
useDismissible(open, root, { escape: false })
function close() {
  open.value = false
  trigger.value?.focus()
}
async function toggle() {
  open.value = !open.value
  await nextTick()
  if (open.value) menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}
function choose(item: HeaderAction) {
  if (item.disabled) return
  close()
  emit('action', item.id)
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (!open.value) return
  if (event.key === 'Tab') {
    open.value = false
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons.at(next)?.focus()
}
</script>
<template>
  <div ref="root" class="header-action-menu" @keydown="keydown">
    <button
      ref="trigger"
      type="button"
      class="header-action-menu__trigger"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-controls="`${id}-actions`"
      @click="toggle"
      @keydown.down.stop.prevent="!open && toggle()"
    >
      <AiIcon :name="icon" :size="15" /><span>{{ label }}</span
      ><AiIcon name="chevron" :size="10" class="chevron" />
    </button>
    <div v-if="open" :id="`${id}-actions`" ref="menu" role="menu" :aria-label="label" class="header-action-menu__panel">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        :role="item.active !== undefined ? 'menuitemcheckbox' : 'menuitem'"
        :aria-checked="item.active"
        :disabled="item.disabled"
        :class="{ 'has-divider': item.divider }"
        tabindex="-1"
        @click="choose(item)"
      >
        <AiIcon :name="item.icon" :size="14" /><span>{{ item.label }}</span
        ><AiIcon v-if="item.active" name="check" :size="12" />
      </button>
    </div>
  </div>
</template>
<style scoped>
.header-action-menu {
  position: relative;
}
.header-action-menu__trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 5px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ai-muted);
  cursor: pointer;
  font: 12px var(--ai-font);
}
.chevron {
  transform: rotate(90deg);
  opacity: 0.6;
}
.header-action-menu__trigger:hover,
.header-action-menu__trigger[aria-expanded='true'] {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.header-action-menu__panel {
  position: absolute;
  right: 0;
  top: calc(100% + 9px);
  z-index: 80;
  width: 234px;
  padding: 5px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  border: 1px solid var(--ai-line-strong);
  border-radius: 11px;
  box-shadow: var(--shadow-panel);
}
.header-action-menu__panel button {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: 12px var(--ai-font);
  text-align: left;
  cursor: pointer;
}
.header-action-menu__panel button span {
  flex: 1;
}
.header-action-menu__panel button:hover,
.header-action-menu__panel button:focus-visible {
  background: var(--ai-hover);
}
.header-action-menu__panel .has-divider {
  margin-top: 5px;
  border-top: 1px solid var(--ai-line);
  border-radius: 0 0 6px 6px;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 1px;
}
@media (max-width: 700px) {
  .header-action-menu__trigger > span {
    display: none;
  }
  .header-action-menu__trigger {
    padding: 5px;
  }
  .header-action-menu {
    position: static;
  }
  .header-action-menu__panel {
    right: 0;
    max-width: calc(100vw - 80px);
  }
}
</style>
