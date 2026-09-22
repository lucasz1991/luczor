<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import { useDismissible } from '@/composables/useDismissible'

type GoalModel = {
  text: string
  active: boolean
  status: 'idle' | 'running' | 'checking' | 'waiting' | 'blocked' | 'completed'
  revision: number
  iterations: number
  phase: 'work' | 'review'
  progress?: string
  evidence?: string
  reason?: string
  updatedAt: number
}

const props = withDefaults(defineProps<{ model?: GoalModel; busy?: boolean; compact?: boolean }>(), {
  model: undefined,
  busy: false,
  compact: false,
})
const emit = defineEmits<{ save: [text: string]; toggle: [active: boolean] }>()
const id = useId()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
// Clicking anywhere else (or moving focus away) closes the popover; the draft stays in memory.
useDismissible(open, root, { escape: false })
const editor = ref<HTMLTextAreaElement | null>(null)
const savedText = computed(() => props.model?.text ?? '')
const draft = ref(savedText.value)
const incomingChange = ref(false)
const dirty = computed(() => draft.value.trim() !== savedText.value.trim())
const canSave = computed(() => dirty.value && draft.value.trim().length > 0 && draft.value.length <= 6000)
const hasGoal = computed(() => savedText.value.trim().length > 0)
const status = computed(() => {
  if (!hasGoal.value) return 'Kein Ziel gespeichert'
  if (props.model?.status === 'completed') return 'Ziel erreicht'
  if (!props.model?.active) return 'Pausiert'
  return {
    idle: 'Bereit',
    running: 'Arbeitet am Ziel',
    checking: 'Prüft das Ergebnis',
    waiting: 'Wartet auf Ausführung',
    blocked: 'Benötigt Unterstützung',
    completed: 'Ziel erreicht',
  }[props.model.status]
})
const reason = computed(() => {
  if (props.model?.status !== 'blocked' && props.model?.status !== 'waiting') return ''
  return props.model.reason?.trim() ?? ''
})

watch(savedText, (current, previous) => {
  if (draft.value.trim() === previous.trim() || draft.value.trim() === current.trim()) {
    draft.value = current
    incomingChange.value = false
  } else {
    incomingChange.value = true
  }
})

async function setOpen(value: boolean): Promise<void> {
  open.value = value
  await nextTick()
  if (value) editor.value?.focus()
  else trigger.value?.focus()
}

function updateDraft(event: Event): void {
  draft.value = (event.target as HTMLTextAreaElement).value
}

function adoptSavedText(): void {
  draft.value = savedText.value
  incomingChange.value = false
}

function save(): void {
  if (canSave.value) emit('save', draft.value.trim())
}
</script>

<template>
  <div ref="root" class="goal-control" @keydown.esc.stop.prevent="setOpen(false)">
    <button
      :id="`${id}-trigger`"
      ref="trigger"
      class="goal-control__trigger"
      :class="{ 'is-active': model?.active, 'is-completed': model?.status === 'completed' }"
      type="button"
      :aria-expanded="open"
      :aria-controls="`${id}-panel`"
      :title="`Arbeitsziel · ${status}`"
      @click="setOpen(!open)"
    >
      <AiIcon name="spark" :size="14" />
      <span v-if="!compact">Ziel</span>
      <span class="goal-control__sr-only">Arbeitsziel: {{ status }}</span>
    </button>
    <button
      v-if="model?.active"
      class="goal-control__pause"
      type="button"
      aria-label="Ziel pausieren"
      title="Ziel pausieren"
      @click="emit('toggle', false)"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <path d="M3 2h2v8H3zm4 0h2v8H7z" />
      </svg>
    </button>
    <section
      v-if="open"
      :id="`${id}-panel`"
      class="goal-control__panel"
      role="region"
      :aria-labelledby="`${id}-heading`"
    >
      <div class="goal-control__heading">
        <strong :id="`${id}-heading`">Arbeitsziel</strong>
        <button type="button" aria-label="Zielsteuerung schließen" @click="setOpen(false)">×</button>
      </div>
      <label :for="`${id}-text`">Was soll Luczor erreichen?</label>
      <textarea
        :id="`${id}-text`"
        ref="editor"
        :value="draft"
        rows="4"
        maxlength="6000"
        placeholder="Beschreibe ein konkretes Ergebnis …"
        :aria-describedby="`${id}-hint`"
        @input="updateDraft"
      />
      <div class="goal-control__save-row">
        <span :id="`${id}-hint`" class="goal-control__hint">
          {{ dirty ? 'Ungespeicherter Entwurf' : hasGoal ? 'Ziel gespeichert' : 'Bis zu 6.000 Zeichen' }}
        </span>
        <button class="goal-control__save" type="button" :disabled="!canSave" @click="save">Ziel speichern</button>
      </div>
      <div v-if="incomingChange" class="goal-control__incoming" role="status">
        Das gespeicherte Ziel wurde geändert. Dein Entwurf bleibt erhalten.
        <button type="button" @click="adoptSavedText">Gespeichertes Ziel übernehmen</button>
      </div>
      <div class="goal-control__toggle-row">
        <span :id="`${id}-toggle-label`">Ziel verfolgen</span>
        <button
          class="goal-control__switch"
          :class="{ 'is-active': model?.active }"
          type="button"
          role="switch"
          :aria-checked="model?.active ?? false"
          :aria-labelledby="`${id}-toggle-label`"
          :disabled="!hasGoal"
          @click="emit('toggle', !model?.active)"
        >
          <span />
        </button>
      </div>
      <p class="goal-control__hint">
        Luczor übernimmt den bestehenden Arbeitskontext, arbeitet am Ziel weiter und prüft das Ergebnis. Du kannst
        jederzeit pausieren.
      </p>
      <div v-if="hasGoal" class="goal-control__status" aria-live="polite" aria-atomic="true">
        <span>{{ status }}</span>
        <span v-if="model && model.iterations > 0"
          >{{ model.iterations }} {{ model.iterations === 1 ? 'Durchlauf' : 'Durchläufe' }}</span
        >
        <span v-if="busy && !model?.active">Aktueller Chat läuft</span>
      </div>
      <p v-if="model?.progress" class="goal-control__summary">{{ model.progress }}</p>
      <p v-if="model?.evidence" class="goal-control__summary"><strong>Nachweis:</strong> {{ model.evidence }}</p>
      <p v-if="reason" class="goal-control__summary">{{ reason }}</p>
    </section>
  </div>
</template>

<style scoped>
.goal-control {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.goal-control button {
  font: inherit;
  cursor: pointer;
}
.goal-control button:disabled {
  opacity: 0.45;
  cursor: default;
}
.goal-control button:focus-visible,
.goal-control textarea:focus-visible {
  outline: 2px solid var(--ai-accent, #7c9cff);
  outline-offset: 3px;
}
.goal-control__trigger,
.goal-control__pause {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 8px;
  color: var(--text-muted, #98a2b1);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 12px !important;
}
.goal-control__trigger:has(svg) {
  min-width: 28px;
}
.goal-control__trigger:hover,
.goal-control__pause:hover {
  color: var(--text-primary, #e9edf3);
  background: var(--ai-surface, #1b1d20);
  border-color: var(--ai-line, #34383e);
}
.goal-control__trigger.is-active {
  color: var(--ai-accent, #7c9cff);
}
.goal-control__trigger.is-completed {
  color: var(--color-success, #73bf9d);
}
.goal-control__dot {
  width: 6px;
  height: 6px;
  border: 1px solid currentColor;
  border-radius: 50%;
}
.is-active .goal-control__dot,
.is-completed .goal-control__dot {
  background: currentColor;
}
.goal-control__pause {
  padding: 4px;
  min-width: 24px;
}
.goal-control__panel {
  position: absolute;
  bottom: calc(100% + 8px);
  inset-inline-start: 0;
  inset-inline-end: auto;
  z-index: 50;
  width: min(380px, calc(100vw - 32px));
  max-height: min(600px, calc(100dvh - 120px));
  overflow-y: auto;
  box-sizing: border-box;
  padding: 16px;
  color: var(--text-primary, #e9edf3);
  background: var(--ai-surface, #1b1d20);
  border: 1px solid var(--ai-line, #34383e);
  border-radius: 12px;
  box-shadow: 0 12px 32px #0004;
  font-size: 12px;
  line-height: 1.5;
}
.goal-control__heading,
.goal-control__save-row,
.goal-control__toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.goal-control__heading {
  margin-bottom: 12px;
}
.goal-control__heading strong {
  font-size: 14px;
}
.goal-control__heading button {
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--text-muted, #98a2b1);
  border: 0;
  border-radius: 4px;
  background: transparent;
  font-size: 20px;
}
.goal-control label {
  display: block;
  margin-bottom: 6px;
}
.goal-control textarea {
  width: 100%;
  min-height: 94px;
  max-height: 220px;
  box-sizing: border-box;
  resize: vertical;
  padding: 10px;
  color: inherit;
  background: var(--ai-page, #15171a);
  border: 1px solid var(--ai-line, #34383e);
  border-radius: 7px;
  font: inherit;
}
.goal-control__save-row {
  margin-top: 8px;
}
.goal-control__save {
  flex-shrink: 0;
  padding: 5px 9px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--ai-line, #34383e);
  border-radius: 6px;
}
.goal-control__hint {
  margin: 6px 0 0;
  color: var(--text-muted, #98a2b1);
  font-size: 11px;
}
.goal-control__save-row .goal-control__hint {
  margin: 0;
}
.goal-control__toggle-row {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--ai-line, #34383e);
}
.goal-control__switch {
  width: 34px;
  height: 20px;
  padding: 2px;
  border: 1px solid var(--ai-line, #34383e);
  border-radius: 12px;
  background: var(--ai-page, #15171a);
}
.goal-control__switch span {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-muted, #98a2b1);
}
.goal-control__switch.is-active {
  background: var(--ai-accent, #7c9cff);
}
.goal-control__switch.is-active span {
  margin-inline-start: auto;
  background: var(--ai-page, #15171a);
}
.goal-control__status {
  display: flex;
  gap: 6px 12px;
  flex-wrap: wrap;
  margin-top: 12px;
  color: var(--text-muted, #98a2b1);
  font-size: 11px;
}
.goal-control__summary {
  margin: 8px 0 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font-size: 11px;
  color: var(--text-muted, #98a2b1);
}
.goal-control__summary strong {
  font-weight: 500;
}
.goal-control__incoming {
  margin-top: 10px;
  color: var(--text-muted, #98a2b1);
  font-size: 11px;
}
.goal-control__incoming button {
  display: block;
  margin-top: 4px;
  padding: 0;
  border: 0;
  color: var(--ai-accent, #7c9cff);
  background: transparent;
  text-align: start;
}
.goal-control__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
