<script setup lang="ts">
import { ref } from 'vue'
import AiIcon from './AiIcon.vue'
const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ action: [instruction: string, selection: string]; speak: [selection: string] }>()
const root = ref<HTMLElement | null>(null)
const selection = ref('')
function capture() {
  const selected = window.getSelection()
  if (selected?.rangeCount && root.value?.contains(selected.anchorNode) && root.value?.contains(selected.focusNode))
    selection.value = selected.toString().trim().slice(0, 8000)
  else selection.value = ''
}
function act(instruction: string) {
  if (!props.disabled && selection.value) emit('action', instruction, selection.value)
}
function speak() {
  const text = selection.value
  if (props.disabled || !text) return
  emit('speak', text)
  window.getSelection()?.removeAllRanges()
  selection.value = ''
}
</script>
<template>
  <div class="ai-selection">
    <div ref="root" @mouseup="capture" @keyup="capture"><slot /></div>
    <div v-if="selection" class="ai-selection__toolbar" role="toolbar" aria-label="Aktionen für ausgewählten Text">
      <span>{{ selection.length }} Zeichen ausgewählt</span
      ><button
        type="button"
        class="ai-selection__speak"
        :disabled="disabled"
        title="Nur den markierten Text einmal vorlesen"
        @mousedown.prevent
        @click="speak"
      >
        <AiIcon name="sound" :size="14" />Auswahl vorlesen</button
      ><button
        v-for="action in ['Erklären', 'Verbessern', 'Kürzen']"
        :key="action"
        type="button"
        :disabled="disabled"
        @mousedown.prevent
        @click="act(action)"
      >
        {{ action }}</button
      ><button type="button" aria-label="Textauswahl schließen" @mousedown.prevent @click="selection = ''">×</button>
    </div>
  </div>
</template>
