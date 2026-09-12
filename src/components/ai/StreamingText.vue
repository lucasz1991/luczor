<script setup lang="ts">
import { computed, toRef } from 'vue'
import RichMessage from '../RichMessage.vue'
import AiIcon from './AiIcon.vue'
import CodeBlock from './CodeBlock.vue'
import { useClipboard } from '@/composables/useClipboard'
import { useStreamReveal } from '@/composables/useStreamReveal'
import { readAlongState } from '@/services/voice/readAlong'
import ReadAloudText from './ReadAloudText.vue'
const props = withDefaults(
  defineProps<{
    content: string
    streaming?: boolean
    showStreamStatus?: boolean
    animate?: boolean
    question?: string
    followUps?: string[]
    disabled?: boolean
    speechDisabled?: boolean
    speechDisabledReason?: string
    speechKey?: string
    actions?: boolean
  }>(),
  { followUps: () => [], actions: true, question: '', speechDisabledReason: '', speechKey: '', showStreamStatus: true }
)
const emit = defineEmits<{ followUp: [text: string]; speak: [] }>()
const { copy, copied, error } = useClipboard()
const { shown, revealing, skip } = useStreamReveal(
  toRef(props, 'content'),
  toRef(props, 'animate'),
  toRef(props, 'streaming')
)
const displaying = computed(() => props.streaming || revealing.value)
const playback = computed(() =>
  props.speechKey && readAlongState.value?.key === props.speechKey ? readAlongState.value : null
)
// Match serverSpeechText's original-source offsets, including the final question.
const speechSource = computed(() => [shown.value, props.question.trim()].filter(part => !!part.trim()).join('\n\n'))
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
  <div class="ai-answer" :class="{ 'ai-answer--streaming': displaying }" :aria-busy="displaying || undefined">
    <ReadAloudText :playback="playback" :content="speechSource">
      <div class="ai-answer__body">
        <template v-for="(block, index) in blocks" :key="index"
          ><CodeBlock
            v-if="block.type === 'code'"
            :code="block.content"
            :language="block.language"
            :diff="block.language === 'diff'" /><RichMessage v-else :content="block.content"
        /></template>
        <span v-if="displaying && shown" class="ai-stream-caret" aria-hidden="true" />
      </div>
      <p v-if="question" class="ai-answer__question">{{ question }}</p>
    </ReadAloudText>
    <div v-if="displaying && showStreamStatus" class="ai-answer__stream-status" role="status">
      <span class="ai-answer__stream-dot" aria-hidden="true" />
      {{ streaming ? (shown ? 'Antwort wird geschrieben' : 'Antwort wird vorbereitet') : 'Antwort wird eingeblendet' }}
    </div>
    <button v-if="revealing" type="button" class="ai-icon-button" @click="skip">Sofort anzeigen</button>
    <ul v-if="followUps.length && displaying" class="ai-answer__streamed-bullets">
      <li v-for="(item, index) in followUps" :key="index">{{ item }}</li>
    </ul>
    <div v-if="content && actions && !displaying" class="ai-answer__actions">
      <button
        class="ai-icon-button"
        type="button"
        :aria-label="copied ? 'Antwort kopiert' : 'Antwort kopieren'"
        :title="copied ? 'Kopiert' : 'Antwort kopieren'"
        @click="copy(content)"
      >
        <AiIcon :name="copied ? 'check' : 'copy'" /></button
      ><button
        class="ai-icon-button"
        type="button"
        aria-label="Antwort vorlesen"
        :disabled="speechDisabled"
        :title="speechDisabled ? speechDisabledReason : 'Antwort vorlesen'"
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

<style scoped>
.ai-answer__body :deep(.rt) {
  font-size: 14px;
  line-height: 1.8;
  letter-spacing: -0.008em;
}
.ai-answer__body :deep(.rt > :first-child) {
  margin-top: 0;
}
.ai-answer__body :deep(.rt > :last-child) {
  margin-bottom: 0;
}
.ai-answer__body :deep(.rt h3.rt-h) {
  font-size: 20px;
  letter-spacing: -0.025em;
}
.ai-answer__body :deep(.rt h4.rt-h) {
  font-size: 18px;
  letter-spacing: -0.015em;
}
.ai-answer__body :deep(.rt h5.rt-h) {
  font-size: 15px;
  letter-spacing: -0.01em;
  text-transform: none;
  color: var(--ai-ink);
}
.ai-stream-caret {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ai-accent);
  margin: 6px 0 0;
}
.ai-answer__stream-status {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  margin-top: 8px;
  font: 11px/1.5 var(--ai-font);
  color: var(--ai-faint);
}
.ai-answer__stream-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--ai-accent);
}
.ai-answer__actions {
  flex-wrap: wrap;
  margin-top: 12px;
  gap: 3px;
}
.ai-answer__actions :deep(button) {
  min-width: 32px;
  min-height: 32px;
  border-radius: 7px;
}
.ai-follow-ups {
  gap: 6px;
  margin-top: 20px;
}
.ai-follow-ups button {
  width: 100%;
  justify-content: space-between;
  min-height: 36px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  line-height: 1.5;
}
.ai-follow-ups button:hover:not(:disabled) {
  border-color: var(--ai-line);
  background: var(--ai-canvas);
}
.ai-follow-ups button svg {
  flex-shrink: 0;
}
@media (prefers-reduced-motion: reduce) {
  .ai-stream-caret {
    animation: none;
  }
}
:global(html[data-reduce-motion='1']) .ai-stream-caret,
:global([data-reduce-motion='true']) .ai-stream-caret { animation: none; }
</style>
