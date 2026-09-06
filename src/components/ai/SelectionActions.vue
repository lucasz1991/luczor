<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ action: [instruction: string, selection: string] }>()
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
</script>
<template>
  <div class="ai-selection">
    <div ref="root" @mouseup="capture" @keyup="capture"><slot /></div>
    <div v-if="selection" class="ai-selection__toolbar" role="toolbar" aria-label="Ausgewählten Text bearbeiten">
      <span>{{ selection.length }} Zeichen</span
      ><button
        v-for="action in ['Erklären', 'Verbessern', 'Kürzen']"
        :key="action"
        type="button"
        :disabled="disabled"
        @click="act(action)"
      >
        {{ action }}</button
      ><button type="button" aria-label="Textauswahl schließen" @click="selection = ''">×</button>
    </div>
  </div>
</template>
