<script setup lang="ts" generic="T extends string">
import { computed, nextTick, ref, useId, watch, type Ref } from 'vue'
import AiIcon from './AiIcon.vue'
import { useDismissible } from '@/composables/useDismissible'

/**
 * Shared glass dropdown: a trigger plus a listbox that closes on outside click, focus loss and
 * Escape, with full keyboard navigation. Replaces hidden native <select>s, whose option popups
 * inherit the trigger's invisible text styling and render as empty rows in the desktop webview.
 */
export type DropdownOption<V extends string = string> = {
  value: V
  label: string
  description?: string
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: T
    options: ReadonlyArray<DropdownOption<T>>
    /** Accessible name of the control. */
    label: string
    heading?: string
    title?: string
    disabled?: boolean
    /** Where the menu opens relative to the trigger; composer controls open upwards. */
    direction?: 'up' | 'down'
    align?: 'start' | 'end'
    /** Extra class for the trigger so callers keep their existing look (icon pill, dot, …). */
    triggerClass?: string
    menuWidth?: number
  }>(),
  { heading: '', title: '', disabled: false, direction: 'up', align: 'start', triggerClass: '', menuWidth: 232 }
)
const emit = defineEmits<{ 'update:modelValue': [value: T] }>()

const id = useId()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
// `ref<T>` cannot unwrap a generic that might itself be a Ref; the cast keeps the plain value type.
const highlighted = ref(null) as Ref<T | null>
const current = computed(() => props.options.find(option => option.value === props.modelValue) ?? null)
const enabled = computed(() => props.options.filter(option => !option.disabled))
useDismissible(open, root, {
  onClose: () => {
    highlighted.value = null
  },
})

function toggle() {
  if (props.disabled) return
  if (open.value) return void close()
  open.value = true
  highlighted.value = props.modelValue
  void nextTick(() => focusOption(props.modelValue))
}
function close(focusTrigger = true) {
  open.value = false
  highlighted.value = null
  if (focusTrigger) trigger.value?.focus()
}
function choose(option: DropdownOption<T>) {
  if (option.disabled) return
  if (option.value !== props.modelValue) emit('update:modelValue', option.value)
  close()
}
function optionId(value: T) {
  return `${id}-option-${value}`
}
function focusOption(value: T | null) {
  if (value === null) return
  root.value?.querySelector<HTMLElement>(`#${CSS.escape(optionId(value))}`)?.focus()
}
function move(delta: number) {
  const list = enabled.value
  if (!list.length) return
  const index = list.findIndex(option => option.value === (highlighted.value ?? props.modelValue))
  const next = list.at((index + delta + list.length) % list.length)
  if (!next) return
  highlighted.value = next.value
  focusOption(next.value)
}
function onTriggerKey(event: KeyboardEvent) {
  if (props.disabled) return
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault()
    if (!open.value) toggle()
    else if (event.key === 'ArrowDown') move(1)
    else if (event.key === 'ArrowUp') move(-1)
  }
}
function onMenuKey(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Home':
      event.preventDefault()
      highlighted.value = enabled.value[0]?.value ?? null
      focusOption(highlighted.value)
      break
    case 'End':
      event.preventDefault()
      highlighted.value = enabled.value.at(-1)?.value ?? null
      focusOption(highlighted.value)
      break
    case 'Tab':
      close(false)
      break
    default:
      break
  }
}
watch(
  () => props.disabled,
  disabled => {
    if (disabled) close(false)
  }
)
</script>

<template>
  <div
    ref="root"
    class="ai-dropdown"
    :class="{
      'is-open': open,
      'is-disabled': disabled,
      'opens-down': direction === 'down',
      'align-end': align === 'end',
    }"
    :title="title || undefined"
  >
    <button
      ref="trigger"
      type="button"
      class="ai-dropdown__trigger"
      :class="triggerClass"
      :disabled="disabled"
      :aria-label="`${label}: ${current?.label ?? '–'}`"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${id}-menu`"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <slot name="trigger" :open="open" :current="current">
        <span class="ai-dropdown__value">{{ current?.label ?? '–' }}</span>
        <AiIcon name="chevron" :size="11" class="ai-dropdown__chevron" />
      </slot>
    </button>
    <Transition name="ai-dropdown">
      <div
        v-show="open"
        :id="`${id}-menu`"
        class="ai-dropdown__menu"
        role="listbox"
        :aria-label="label"
        :aria-activedescendant="highlighted ? optionId(highlighted) : undefined"
        :style="{ width: `${menuWidth}px` }"
        @keydown="onMenuKey"
      >
        <div v-if="heading" class="ai-dropdown__head">{{ heading }}</div>
        <button
          v-for="option in options"
          :id="optionId(option.value)"
          :key="option.value"
          type="button"
          role="option"
          class="ai-dropdown__option"
          :class="{ 'is-on': option.value === modelValue, 'is-highlighted': option.value === highlighted }"
          :data-tone="option.tone ?? 'neutral'"
          :aria-selected="option.value === modelValue"
          :aria-disabled="option.disabled || undefined"
          :disabled="option.disabled"
          tabindex="-1"
          @click="choose(option)"
          @pointerenter="highlighted = option.value"
        >
          <span class="ai-dropdown__dot" aria-hidden="true" />
          <span class="ai-dropdown__text">
            <span>{{ option.label }}</span>
            <small v-if="option.description">{{ option.description }}</small>
          </span>
          <AiIcon v-if="option.value === modelValue" name="check" :size="12" class="ai-dropdown__check" />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ai-dropdown {
  position: relative;
  display: inline-flex;
  min-width: 0;
}
.ai-dropdown__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border, var(--ai-line));
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted, var(--ai-muted));
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 220ms var(--ease, ease),
    background 220ms var(--ease, ease),
    color 220ms var(--ease, ease);
}
.ai-dropdown__trigger:hover:not(:disabled),
.is-open .ai-dropdown__trigger {
  color: var(--text-primary, var(--ai-ink));
  background: var(--g-bg-2, var(--ai-hover));
}
.ai-dropdown__trigger:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
.ai-dropdown__trigger:disabled {
  opacity: 0.6;
  cursor: default;
}
.ai-dropdown__chevron {
  color: var(--ai-faint, #6f788d);
  transition: transform 300ms var(--ease, ease);
}
.is-open .ai-dropdown__chevron {
  transform: rotate(180deg);
}
.ai-dropdown__menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 60;
  padding: 4px;
  border-radius: var(--r-md, 14px);
  background: var(--g-bg, var(--ai-surface, #22252d));
  border: 1px solid var(--g-edge-2, var(--ai-border, #3c3e48));
  box-shadow: var(--shadow-panel, 0 24px 60px -30px rgba(0, 0, 0, 0.85));
  backdrop-filter: blur(var(--blur, 36px)) saturate(190%);
  -webkit-backdrop-filter: blur(var(--blur, 36px)) saturate(190%);
  text-align: left;
}
.opens-down .ai-dropdown__menu {
  bottom: auto;
  top: calc(100% + 8px);
}
.align-end .ai-dropdown__menu {
  left: auto;
  right: 0;
}
.ai-dropdown__head {
  padding: 7px 10px 5px;
  font: 500 9.5px var(--ai-font, inherit);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ai-text-muted, #a3a5af);
}
.ai-dropdown__option {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ai-text-muted, #a3a5af);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    background 180ms var(--ease, ease),
    color 180ms var(--ease, ease);
}
.ai-dropdown__option:hover,
.ai-dropdown__option.is-highlighted,
.ai-dropdown__option:focus-visible {
  background: var(--g-fill-2, var(--ai-hover, rgba(255, 255, 255, 0.06)));
  color: var(--ai-text, #e9eaf0);
  outline: none;
}
.ai-dropdown__option.is-on {
  color: var(--ai-text, #e9eaf0);
  background: color-mix(in srgb, var(--ai-accent, #ac95ea) 14%, transparent);
}
.ai-dropdown__option:disabled {
  opacity: 0.45;
  cursor: default;
}
.ai-dropdown__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted, #a3a5af);
}
.ai-dropdown__option[data-tone='accent'] .ai-dropdown__dot {
  background: var(--ai-accent, #ac95ea);
}
.ai-dropdown__option[data-tone='success'] .ai-dropdown__dot {
  background: var(--success-soft, var(--ai-green, #34d399));
}
.ai-dropdown__option[data-tone='warning'] .ai-dropdown__dot {
  background: var(--ai-orange, #e6a23c);
}
.ai-dropdown__option[data-tone='danger'] .ai-dropdown__dot {
  background: var(--danger-soft, var(--ai-red, #fb7185));
}
.ai-dropdown__text {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.ai-dropdown__text > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-dropdown__text small {
  font-size: 10.5px;
  color: var(--ai-faint, #6f788d);
  white-space: normal;
}
.ai-dropdown__check {
  color: var(--ai-accent, #ac95ea);
}
.ai-dropdown-enter-active,
.ai-dropdown-leave-active {
  transition:
    opacity 200ms var(--ease, ease),
    transform 260ms var(--ease, ease);
}
.ai-dropdown-enter-from,
.ai-dropdown-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}
.opens-down .ai-dropdown-enter-from,
.opens-down .ai-dropdown-leave-to {
  transform: translateY(-6px) scale(0.98);
}
@media (prefers-reduced-motion: reduce) {
  .ai-dropdown-enter-active,
  .ai-dropdown-leave-active,
  .ai-dropdown__chevron {
    transition: none;
  }
}
</style>
