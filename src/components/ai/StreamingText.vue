<script setup lang="ts">
import { computed, toRef } from 'vue'
import RichMessage from '../RichMessage.vue'
import AiIcon from './AiIcon.vue'
import CodeBlock from './CodeBlock.vue'
import { useClipboard } from '@/composables/useClipboard'
import { useStreamReveal } from '@/composables/useStreamReveal'
const props = withDefaults(
  defineProps<{
    content: string
    streaming?: boolean
    animate?: boolean
    question?: string
    followUps?: string[]
    disabled?: boolean
    speechDisabled?: boolean
    speechDisabledReason?: string
    actions?: boolean
  }>(),
  { followUps: () => [], actions: true, question: '', speechDisabledReason: '' }
)
const emit = defineEmits<{ followUp: [text: string]; speak: [] }>()
const { copy, copied, error } = useClipboard()
const { shown, revealing, skip } = useStreamReveal(toRef(props, 'content'), toRef(props, 'animate'))
const displaying = computed(() => props.streaming || revealing.value)
// Split fenced blocks without interpreting HTML. RichMessage owns escaped prose.
const blocks = computed(() => {
  const result: { type: 'text' | 'code'; content: string; language?: string }[] = []
  const pattern = /^```([^\n]*)\n([\s\S]*?)(?:^```[^\S\n]*(?:\n|$)|$(?![\s\S]))/gm
  let offset = 0
  for (const match of shown.value.matchAll(pattern)) {
    if (match.index > offset) result.push({ type: 'text', content: shown.value.slice(offset, match.index) })
    result.push({ type: 'code', language: (match[1] ?? '').trim(), content: (match[2] ?? '').replace(/\n$/, '') })
    offset = match.index + match[0].length
  }
  if (offset < shown.value.length) result.push({ type: 'text', content: shown.value.slice(offset) })
  return result
})
</script>
<template>
  <div class="ai-answer" :aria-busy="displaying || undefined">
    <div class="ai-answer__body">
      <template v-for="(block, index) in blocks" :key="index"
        ><CodeBlock
          v-if="block.type === 'code'"
          :code="block.content"
          :language="block.language"
          :diff="block.language === 'diff'" /><RichMessage v-else :content="block.content"
      /></template>
      <span v-if="displaying" class="ai-stream-caret" aria-hidden="true" />
    </div>
    <button v-if="revealing" type="button" class="ai-icon-button" @click="skip">Sofort anzeigen</button>
    <p v-if="question && !displaying" class="ai-answer__question">{{ question }}</p>
    <div v-if="content && actions && !displaying" class="ai-answer__actions">
      <button
        class="ai-icon-button"
        type="button"
        :aria-label="copied ? 'Antwort kopiert' : 'Antwort kopieren'"
        @click="copy(content)"
      >
        <AiIcon :name="copied ? 'check' : 'copy'" /></button
      ><button
        class="ai-icon-button"
        type="button"
        aria-label="Antwort vorlesen"
        :disabled="speechDisabled"
        :title="speechDisabled ? speechDisabledReason : undefined"
        @click="emit('speak')"
      >
        <AiIcon name="sound" /></button
      ><slot name="actions" /><span v-if="copied || error" role="status" class="ai-muted">{{
        error || 'Kopiert'
      }}</span>
    </div>
    <div v-if="followUps.length && !displaying" class="ai-follow-ups">
      <span class="ai-section-label">Weiter geht’s</span
      ><button
        v-for="item in followUps.slice(0, 10)"
        :key="item"
        type="button"
        :disabled="disabled"
        @click="emit('followUp', item)"
      >
        <span>{{ item }}</span
        ><AiIcon name="arrow" :size="14" />
      </button>
    </div>
  </div>
</template>
