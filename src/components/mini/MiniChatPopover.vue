<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import { useDismissible } from '@/composables/useDismissible'

defineProps<{ label: string; wide?: boolean }>()
const id = useId()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const open = ref(false)
useDismissible(open, root, { escape: false })
function close() {
  open.value = false
  trigger.value?.focus()
}
async function toggle() {
  open.value = !open.value
  if (open.value) {
    await nextTick()
    panel.value?.querySelector<HTMLElement>('select, button:not(:disabled), input')?.focus()
  }
}
function escape(event: KeyboardEvent) {
  if (!open.value || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  close()
}
</script>

<template>
  <div ref="root" class="mini-chat-popover" :class="{ 'is-wide': wide }" @keydown.esc="escape">
    <button
      ref="trigger"
      type="button"
      class="mini-chat-popover__trigger"
      :aria-label="label"
      :title="label"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="id"
      @click="toggle"
    >
      <slot name="trigger" />
    </button>
    <section v-if="open" :id="id" ref="panel" role="dialog" :aria-label="label" class="mini-chat-popover__panel">
      <slot :close="close" />
    </section>
  </div>
</template>

<style scoped>
.mini-chat-popover {
  position: static;
  flex-shrink: 0;
}
.mini-chat-popover.is-wide {
  flex: 1;
  min-width: 0;
}
.mini-chat-popover__trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 7px;
  color: var(--ai-muted);
  cursor: pointer;
}
.is-wide .mini-chat-popover__trigger {
  width: 100%;
  justify-content: flex-start;
  padding: 0 4px;
}
.mini-chat-popover__trigger:hover,
.mini-chat-popover__trigger[aria-expanded='true'] {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.mini-chat-popover__panel {
  position: absolute;
  top: 49px;
  right: 10px;
  z-index: 90;
  width: min(260px, calc(100% - 20px));
  max-height: calc(100% - 64px);
  overflow: auto;
  padding: 7px;
  border: 1px solid var(--ai-line-strong);
  border-radius: 12px;
  color: var(--ai-ink);
  background: var(--ai-surface);
  box-shadow: 0 8px 24px #0002;
}
.is-wide .mini-chat-popover__panel {
  top: 85px;
  left: 10px;
  width: auto;
  max-height: calc(100% - 100px);
}
</style>
