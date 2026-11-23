<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import AiIcon from './AiIcon.vue'
import { useDismissible } from '@/composables/useDismissible'
import type { ClaudeModelOption } from '@/services/inference/claudeMain'
import { isThinkingTier, THINKING_TIERS, type ThinkingTier } from '@/services/inference/thinking'
import {
  effectiveThinkingTier,
  initialEntryKey,
  menuKeyMove,
  modelSelectorEntries,
  modelSelectorHint,
  modelSelectorLabel,
  modelSelectorProvider,
  modelSelectorTitle,
  moveEntryKey,
  type ModelSelectorEntry,
  type ModelSelectorState,
} from './modelSelectorMenu'

// Combined "Modell & Denktiefe" control of the composer: provider dot, model label and the five
// step bars. The menu opens upwards with the model section above the thinking tiers.
const props = withDefaults(
  defineProps<{
    thinkingTier?: ThinkingTier
    nextPrompt?: boolean
    claudeMode?: boolean
    models?: readonly ClaudeModelOption[]
    /** Selected Claude model id. */
    model?: string
    /** Label outside Claude mode, e.g. the local model name. */
    info?: string
    provider?: 'claude' | 'local' | 'external'
    specialist?: boolean
  }>(),
  {
    thinkingTier: 'balanced',
    nextPrompt: false,
    claudeMode: false,
    models: () => [],
    model: undefined,
    info: '',
    provider: undefined,
    specialist: false,
  }
)
const emit = defineEmits<{
  'update:thinkingTier': [value: ThinkingTier]
  'update:model': [value: string]
}>()

const id = useId()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const highlighted = ref<string | null>(null)

const state = computed<ModelSelectorState>(() => ({
  thinkingTier: props.thinkingTier,
  claudeMode: props.claudeMode,
  models: props.models,
  model: props.model,
  info: props.info,
  provider: props.provider,
  specialist: props.specialist,
}))
const entries = computed(() => modelSelectorEntries(state.value))
const modelEntries = computed(() => entries.value.filter(entry => entry.kind === 'model'))
const tierEntries = computed(() => entries.value.filter(entry => entry.kind === 'tier'))
const label = computed(() => modelSelectorLabel(state.value))
const hint = computed(() => modelSelectorHint(state.value))
const dot = computed(() => modelSelectorProvider(state.value))
const title = computed(() => modelSelectorTitle(state.value, props.nextPrompt))
const level = computed(() => THINKING_TIERS.indexOf(effectiveThinkingTier(state.value)) + 1)

useDismissible(open, root, {
  onClose: () => {
    highlighted.value = null
  },
})

function optionId(key: string) {
  return `${id}-${key}`
}
function focusEntry(key: string | null) {
  highlighted.value = key
  if (key === null) return
  root.value?.querySelector<HTMLElement>(`#${CSS.escape(optionId(key))}`)?.focus()
}
function show() {
  open.value = true
  const key = initialEntryKey(entries.value)
  highlighted.value = key
  void nextTick(() => focusEntry(key))
}
function close(focusTrigger = true) {
  open.value = false
  highlighted.value = null
  if (focusTrigger) trigger.value?.focus()
}
function toggle() {
  if (open.value) close()
  else show()
}
function choose(entry: ModelSelectorEntry) {
  if (entry.disabled) return
  if (entry.kind === 'model') {
    // Stays open: the tier list below depends on the model and is usually picked next.
    if (!entry.selected) emit('update:model', entry.value)
    return
  }
  if (isThinkingTier(entry.value) && entry.value !== props.thinkingTier) emit('update:thinkingTier', entry.value)
  close()
}
function onTriggerKey(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return
  event.preventDefault()
  if (!open.value) show()
  else if (event.key === 'ArrowDown') focusEntry(moveEntryKey(entries.value, highlighted.value, 'next'))
  else if (event.key === 'ArrowUp') focusEntry(moveEntryKey(entries.value, highlighted.value, 'previous'))
  else close()
}
function onMenuKey(event: KeyboardEvent) {
  // Leaving with Tab closes the menu and lets focus move on; Escape is handled by useDismissible.
  if (event.key === 'Tab') return void close(false)
  const move = menuKeyMove(event.key)
  if (!move) return
  event.preventDefault()
  focusEntry(moveEntryKey(entries.value, highlighted.value, move))
}
function onRootKey(event: KeyboardEvent) {
  // useDismissible closes on Escape in the capture phase; hand focus back to the trigger afterwards.
  if (event.key === 'Escape') trigger.value?.focus()
}
</script>

<template>
  <div ref="root" class="ai-model-select" :class="{ 'is-open': open }" :title="title" @keydown="onRootKey">
    <button
      ref="trigger"
      type="button"
      class="ai-model-select__trigger"
      :aria-label="title"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="`${id}-menu`"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <span class="ai-model-select__provider" :class="`is-${dot}`" aria-hidden="true" />
      <span class="ai-model-select__label">{{ label }}</span>
      <span class="ai-model-select__steps" aria-hidden="true">
        <i v-for="n in THINKING_TIERS.length" :key="n" :class="{ 'is-filled': n <= level }" />
      </span>
      <AiIcon name="chevron" :size="11" class="ai-model-select__chevron" />
    </button>
    <Transition name="ai-model-select">
      <div v-show="open" :id="`${id}-menu`" class="ai-model-select__menu" @keydown="onMenuKey">
        <div :id="`${id}-model-head`" class="ai-model-select__head">Modell</div>
        <div
          v-if="claudeMode"
          role="listbox"
          :aria-labelledby="`${id}-model-head`"
          :aria-activedescendant="highlighted?.startsWith('model-') ? optionId(highlighted) : undefined"
        >
          <button
            v-for="entry in modelEntries"
            :id="optionId(entry.key)"
            :key="entry.key"
            type="button"
            role="option"
            class="ai-model-select__option"
            :class="{ 'is-on': entry.selected, 'is-highlighted': entry.key === highlighted }"
            :aria-selected="entry.selected"
            tabindex="-1"
            @click="choose(entry)"
            @pointerenter="highlighted = entry.key"
          >
            <span class="ai-model-select__dot" aria-hidden="true" />
            <span class="ai-model-select__text">
              <span>{{ entry.label }}</span>
              <small v-if="entry.detail">{{ entry.detail }}</small>
            </span>
            <AiIcon v-if="entry.selected" name="check" :size="12" class="ai-model-select__check" />
          </button>
          <p v-if="!modelEntries.length" class="ai-model-select__empty">Der Server bietet derzeit kein Modell an.</p>
        </div>
        <div v-else class="ai-model-select__readonly" :aria-labelledby="`${id}-model-head`" role="group">
          <span class="ai-model-select__dot" :class="`is-${dot}`" aria-hidden="true" />
          <span class="ai-model-select__text">
            <span>{{ label }}</span>
            <small v-if="hint">{{ hint }}</small>
          </span>
        </div>
        <div class="ai-model-select__sep" role="separator" />
        <div
          :id="`${id}-tier-head`"
          class="ai-model-select__head"
          :title="claudeMode ? undefined : 'Anfang / Denkgrenze / Antwortreserve in Tokens'"
        >
          Denktiefe
        </div>
        <div
          role="listbox"
          :aria-labelledby="`${id}-tier-head`"
          :aria-activedescendant="highlighted?.startsWith('tier-') ? optionId(highlighted) : undefined"
        >
          <button
            v-for="(entry, index) in tierEntries"
            :id="optionId(entry.key)"
            :key="entry.key"
            type="button"
            role="option"
            class="ai-model-select__tier"
            :class="{ 'is-on': entry.selected, 'is-highlighted': entry.key === highlighted }"
            :aria-selected="entry.selected"
            :aria-disabled="entry.disabled || undefined"
            :disabled="entry.disabled"
            :title="entry.disabled ? 'Dieses Modell unterstützt diese Denktiefe nicht.' : undefined"
            tabindex="-1"
            @click="choose(entry)"
            @pointerenter="highlighted = entry.disabled ? highlighted : entry.key"
          >
            <span class="ai-model-select__steps" aria-hidden="true">
              <i v-for="n in THINKING_TIERS.length" :key="n" :class="{ 'is-filled': n <= index + 1 }" />
            </span>
            <span>{{ entry.label }}</span>
            <small>{{ entry.detail }}</small>
          </button>
        </div>
        <p v-if="claudeMode" class="ai-model-select__foot">
          Gilt für diesen Chat ab der nächsten Nachricht. Neue Chats starten mit der zuletzt gewählten Kombination.
        </p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ai-model-select {
  position: relative;
  display: inline-flex;
  min-width: 0;
  font-size: 12px;
  color: var(--ai-text-muted, #a3a5af);
}
.ai-model-select__trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  height: 32px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--ai-text-muted, #a3a5af);
  font: 600 12px var(--ai-font, inherit);
  cursor: pointer;
  transition:
    border-color 220ms var(--ease, ease),
    background 220ms var(--ease, ease),
    color 220ms var(--ease, ease);
}
.ai-model-select__trigger:hover,
.ai-model-select__trigger:focus-visible,
.is-open .ai-model-select__trigger {
  color: var(--ai-text, #e9eaf0);
  border-color: var(--g-edge-2, var(--ai-border, #3c3e48));
  background: var(--g-bg-2, var(--ai-surface, #22252d));
  box-shadow: inset 0 1px 0 var(--g-edge, rgba(255, 255, 255, 0.08));
}
.ai-model-select__trigger:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
.ai-model-select__provider,
.ai-model-select__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ai-accent, #ac95ea);
}
.ai-model-select__provider.is-local,
.ai-model-select__dot.is-local {
  background: var(--success-soft, var(--ai-green, #34d399));
}
.ai-model-select__provider.is-external,
.ai-model-select__dot.is-external {
  background: var(--text-muted, #a3a5af);
}
/* The label gives way on narrow composers; the step bars always stay readable. */
.ai-model-select__label {
  min-width: 0;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-model-select__steps {
  display: inline-flex;
  flex: none;
  gap: 3px;
}
.ai-model-select__steps i {
  width: 6px;
  height: 10px;
  border-radius: 2px;
  background: var(--g-edge-2, rgba(255, 255, 255, 0.14));
  transition: background 200ms var(--ease, ease);
}
.ai-model-select__steps i.is-filled {
  background: var(--ai-accent, #ac95ea);
}
.ai-model-select__chevron {
  flex: none;
  color: var(--ai-faint, #6f788d);
  transform: rotate(90deg);
  transition: transform 300ms var(--ease, ease);
}
.is-open .ai-model-select__chevron {
  transform: rotate(-90deg);
}
.ai-model-select__menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 60;
  width: 318px;
  max-width: min(318px, calc(100vw - 32px));
  max-height: min(560px, calc(100vh - 120px));
  overflow-y: auto;
  padding: 4px;
  border-radius: var(--r-md, 14px);
  background: var(--g-bg, var(--ai-surface, #22252d));
  border: 1px solid var(--g-edge-2, var(--ai-border, #3c3e48));
  box-shadow: var(--shadow-panel, 0 24px 60px -30px rgba(0, 0, 0, 0.85));
  backdrop-filter: blur(var(--blur, 36px)) saturate(190%);
  -webkit-backdrop-filter: blur(var(--blur, 36px)) saturate(190%);
  text-align: left;
  font-weight: 400;
}
.ai-model-select__head {
  padding: 7px 10px 5px;
  font: 500 9.5px var(--ai-font, inherit);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ai-text-muted, #a3a5af);
}
.ai-model-select__option,
.ai-model-select__tier {
  display: grid;
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
.ai-model-select__option {
  grid-template-columns: 8px minmax(0, 1fr) auto;
  gap: 10px;
}
.ai-model-select__tier {
  grid-template-columns: auto 1fr;
  gap: 1px 12px;
}
.ai-model-select__option:hover,
.ai-model-select__option.is-highlighted,
.ai-model-select__option:focus-visible,
.ai-model-select__tier:hover:not(:disabled),
.ai-model-select__tier.is-highlighted,
.ai-model-select__tier:focus-visible {
  color: var(--ai-text, #e9eaf0);
  background: var(--g-fill-2, var(--ai-hover, rgba(255, 255, 255, 0.06)));
  outline: none;
}
.ai-model-select__option.is-on {
  color: var(--ai-text, #e9eaf0);
  background: color-mix(in srgb, var(--ai-accent, #ac95ea) 14%, transparent);
}
.ai-model-select__tier.is-on {
  color: var(--ai-text, #e9eaf0);
  background: var(--cy-08, rgba(143, 123, 216, 0.08));
}
.ai-model-select__tier:disabled {
  opacity: 0.45;
  cursor: default;
}
.ai-model-select__tier .ai-model-select__steps {
  grid-row: 1 / span 2;
}
.ai-model-select__tier .ai-model-select__steps i {
  width: 5px;
  height: 9px;
}
.ai-model-select__tier small {
  font: 9.5px var(--font-mono, monospace);
  color: var(--ai-faint, #6f788d);
}
.ai-model-select__tier.is-on small {
  color: var(--ai-accent, #ac95ea);
}
.ai-model-select__text {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.ai-model-select__text > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-model-select__text small {
  font-size: 10.5px;
  color: var(--ai-faint, #6f788d);
  white-space: normal;
}
.ai-model-select__check {
  color: var(--ai-accent, #ac95ea);
}
.ai-model-select__readonly {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--ai-text, #e9eaf0);
}
.ai-model-select__empty {
  margin: 0;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--ai-faint, #6f788d);
}
.ai-model-select__sep {
  height: 1px;
  margin: 5px 6px;
  background: var(--ai-line, rgba(255, 255, 255, 0.08));
}
.ai-model-select__foot {
  margin: 4px 0 0;
  padding: 7px 10px 6px;
  border-top: 1px solid var(--ai-line, rgba(255, 255, 255, 0.08));
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--ai-faint, #6f788d);
}
.ai-model-select-enter-active,
.ai-model-select-leave-active {
  transition:
    opacity 200ms var(--ease, ease),
    transform 260ms var(--ease, ease);
}
.ai-model-select-enter-from,
.ai-model-select-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}
@media (max-width: 560px) {
  .ai-model-select__label {
    max-width: 120px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-model-select__trigger,
  .ai-model-select__steps i,
  .ai-model-select__chevron,
  .ai-model-select__option,
  .ai-model-select__tier,
  .ai-model-select-enter-active,
  .ai-model-select-leave-active {
    transition: none;
  }
}
</style>
