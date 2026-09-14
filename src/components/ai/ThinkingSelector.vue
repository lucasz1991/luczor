<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AiIcon from './AiIcon.vue'
import { isThinkingTier, THINKING_DEFAULTS, THINKING_TIERS, type ThinkingTier } from '@/services/inference/thinking'

// Step-tier control from the design board: five bars show the depth, the label sits beside them,
// a chevron appears on hover and a glass listbox opens with every tier plus its token budget.
const props = withDefaults(defineProps<{ modelValue?: ThinkingTier; nextPrompt?: boolean }>(), {
  modelValue: 'balanced',
})
const emit = defineEmits<{ 'update:modelValue': [value: ThinkingTier] }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const level = computed(() => THINKING_TIERS.indexOf(props.modelValue) + 1)
const current = computed(() => THINKING_DEFAULTS[props.modelValue])
const title = computed(
  () => `Denkstufe: ${current.value.label}${props.nextPrompt ? ' · gilt für den nächsten Auftrag' : ''}`
)
const format = (value: number) => value.toLocaleString('de-DE')
function budget(tier: ThinkingTier) {
  // `tier` comes straight from the closed THINKING_TIERS union rendered above.
  // eslint-disable-next-line security/detect-object-injection
  const defaults = THINKING_DEFAULTS[tier]
  return `${format(defaults.initialTokens)} / ${format(defaults.maxThinkingTokens)} / ${format(defaults.responseReserveTokens)}`
}
function choose(tier: ThinkingTier) {
  if (isThinkingTier(tier) && tier !== props.modelValue) emit('update:modelValue', tier)
  open.value = false
}
function step(delta: number) {
  const index = Math.min(THINKING_TIERS.length - 1, Math.max(0, THINKING_TIERS.indexOf(props.modelValue) + delta))
  const tier = THINKING_TIERS.at(index)
  if (tier) emit('update:modelValue', tier)
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
    event.preventDefault()
    step(1)
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
    event.preventDefault()
    step(-1)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open.value = !open.value
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    open.value = false
  }
}
function onDocumentPointer(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false
}
watch(open, value => {
  if (value) document.addEventListener('pointerdown', onDocumentPointer, true)
  else document.removeEventListener('pointerdown', onDocumentPointer, true)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointer, true))
</script>
<template>
  <div ref="root" class="ai-thinking-select" :class="{ 'is-open': open }" :title="title">
    <button
      type="button"
      class="ai-thinking-select__trigger"
      :aria-label="`${nextPrompt ? 'Denktiefe für den nächsten Auftrag' : 'Denktiefe'}: ${current.label}`"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open = !open"
      @keydown="onKey"
    >
      <span class="ai-thinking-select__steps" aria-hidden="true">
        <i v-for="n in THINKING_TIERS.length" :key="n" :class="{ 'is-filled': n <= level }" />
      </span>
      <span class="ai-thinking-select__label">{{ current.label }}</span>
      <AiIcon name="chevron" :size="11" class="ai-thinking-select__chevron" />
    </button>
    <div v-show="open" class="ai-thinking-select__menu" role="listbox" aria-label="Denkstufe">
      <div class="ai-thinking-select__head" title="Anfang / Denkgrenze / Antwortreserve in Tokens">Denkstufe</div>
      <button
        v-for="(tier, index) in THINKING_TIERS"
        :key="tier"
        type="button"
        role="option"
        class="ai-thinking-select__option"
        :class="{ 'is-on': tier === modelValue }"
        :aria-selected="tier === modelValue"
        @click="choose(tier)"
      >
        <span class="ai-thinking-select__steps" aria-hidden="true">
          <i v-for="n in THINKING_TIERS.length" :key="n" :class="{ 'is-filled': n <= index + 1 }" />
        </span>
        <span>{{ THINKING_DEFAULTS[tier].label }}</span>
        <small>{{ budget(tier) }}</small>
      </button>
    </div>
  </div>
</template>
<style scoped>
.ai-thinking-select {
  position: relative;
  display: inline-flex;
  min-width: 0;
  font-size: 12px;
  color: var(--ai-text-muted, #a3a5af);
}
.ai-thinking-select__trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 10px 0 12px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--ai-text-muted, #a3a5af);
  font: inherit;
  cursor: pointer;
  transition:
    border-color 220ms var(--ease, ease),
    background 220ms var(--ease, ease),
    color 220ms var(--ease, ease);
}
.ai-thinking-select__trigger:hover,
.ai-thinking-select__trigger:focus-visible,
.is-open .ai-thinking-select__trigger {
  color: var(--ai-text, #e9eaf0);
  border-color: var(--g-edge-2, var(--ai-border, #3c3e48));
  background: var(--g-bg-2, var(--ai-surface, #22252d));
  box-shadow: inset 0 1px 0 var(--g-edge, rgba(255, 255, 255, 0.08));
}
.ai-thinking-select__trigger:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
.ai-thinking-select__steps {
  display: inline-flex;
  gap: 3px;
}
.ai-thinking-select__steps i {
  width: 6px;
  height: 10px;
  border-radius: 2px;
  background: var(--g-edge-2, rgba(255, 255, 255, 0.14));
  transition: background 200ms var(--ease, ease);
}
.ai-thinking-select__steps i.is-filled {
  background: var(--ai-accent, #ac95ea);
}
.ai-thinking-select__label {
  white-space: nowrap;
}
.ai-thinking-select__chevron {
  width: 0;
  margin-left: -8px;
  opacity: 0;
  color: var(--ai-faint, #6f788d);
  transition:
    opacity 240ms var(--ease, ease),
    width 240ms var(--ease, ease),
    margin 240ms var(--ease, ease),
    transform 300ms var(--ease, ease);
}
.ai-thinking-select__trigger:hover .ai-thinking-select__chevron,
.ai-thinking-select__trigger:focus-visible .ai-thinking-select__chevron,
.is-open .ai-thinking-select__chevron {
  width: 11px;
  margin-left: 0;
  opacity: 1;
}
.is-open .ai-thinking-select__chevron {
  transform: rotate(180deg);
}
.ai-thinking-select__menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 60;
  width: 248px;
  padding: 4px;
  border-radius: var(--r-md, 14px);
  background: var(--g-bg, var(--ai-surface, #22252d));
  border: 1px solid var(--g-edge-2, var(--ai-border, #3c3e48));
  box-shadow: var(--shadow-panel, 0 24px 60px -30px rgba(0, 0, 0, 0.85));
  backdrop-filter: blur(var(--blur, 36px)) saturate(190%);
  -webkit-backdrop-filter: blur(var(--blur, 36px)) saturate(190%);
  text-align: left;
}
.ai-thinking-select__head {
  padding: 7px 10px 5px;
  font: 500 9.5px var(--ai-font, inherit);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ai-text-muted, #a3a5af);
}
.ai-thinking-select__option {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1px 12px;
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
.ai-thinking-select__option .ai-thinking-select__steps {
  grid-row: 1 / span 2;
}
.ai-thinking-select__option .ai-thinking-select__steps i {
  width: 5px;
  height: 9px;
}
.ai-thinking-select__option small {
  font: 9.5px var(--font-mono, monospace);
  color: var(--ai-faint, #6f788d);
}
.ai-thinking-select__option:hover {
  color: var(--ai-text, #e9eaf0);
  background: var(--g-fill-2, rgba(255, 255, 255, 0.05));
}
.ai-thinking-select__option.is-on {
  color: var(--ai-text, #e9eaf0);
  background: var(--cy-08, rgba(143, 123, 216, 0.08));
}
.ai-thinking-select__option.is-on small {
  color: var(--ai-accent, #ac95ea);
}
@media (prefers-reduced-motion: reduce) {
  .ai-thinking-select__chevron,
  .ai-thinking-select__steps i,
  .ai-thinking-select__trigger {
    transition: none;
  }
}
</style>
