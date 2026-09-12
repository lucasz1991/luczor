<script setup lang="ts">
import { computed } from 'vue'
import type { ChatCommentary } from '@/state/types'
import { readAlongState } from '@/services/voice/readAlong'
import AiIcon from './AiIcon.vue'
import StreamingText from './StreamingText.vue'
const props = defineProps<{ entries: ChatCommentary[]; messageId?: string; active?: boolean }>()
const latest = computed(() => props.entries.at(-1))
const earlier = computed(() => props.entries.slice(0, -1))
// Spoken commentary remains discoverable when playback advances to an earlier entry.
const readingEarlier = computed(() =>
  !!props.messageId && earlier.value.some(entry => readAlongState.value?.key === `${props.messageId}:${entry.id}`)
)
</script>

<template>
  <section v-if="entries.length" class="chat-commentary" aria-label="Öffentliche Fortschrittsmeldungen">
    <details v-if="earlier.length" class="chat-commentary__history" :open="readingEarlier || undefined">
      <summary>
        <AiIcon name="chevron" :size="12" />
        <span>{{ earlier.length }} {{ earlier.length === 1 ? 'frühere Zwischenmeldung' : 'frühere Zwischenmeldungen' }}</span>
      </summary>
      <ol>
        <li v-for="entry in earlier" :key="entry.id" class="chat-commentary__entry">
          <span class="chat-commentary__round">Runde {{ entry.round }}</span>
          <StreamingText
            :content="entry.content"
            :animate="false"
            :actions="false"
            :speech-key="messageId ? `${messageId}:${entry.id}` : undefined"
          />
        </li>
      </ol>
    </details>
    <div v-if="latest" class="chat-commentary__entry chat-commentary__latest" :class="{ 'is-active': active }">
      <div class="chat-commentary__label">
        <span class="chat-commentary__dot" aria-hidden="true" />
        <span>{{ active ? 'Zwischenstand' : 'Letzter Zwischenstand' }}</span>
        <span class="chat-commentary__round">Runde {{ latest.round }}</span>
      </div>
      <StreamingText
        :content="latest.content"
        :animate="false"
        :actions="false"
        :speech-key="messageId ? `${messageId}:${latest.id}` : undefined"
      />
    </div>
  </section>
</template>

<style scoped>
.chat-commentary {
  margin-block: 16px 24px;
  color: var(--ai-muted);
  min-width: 0;
  font-family: var(--ai-font);
}
.chat-commentary__entry {
  border-inline-start: 1px solid var(--ai-line-strong);
  padding-inline-start: 16px;
  min-width: 0;
}
.chat-commentary__latest.is-active {
  border-inline-start-color: var(--ai-accent);
}
.chat-commentary__label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 500;
}
.chat-commentary__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ai-faint);
}
.is-active .chat-commentary__dot { background: var(--ai-accent); }
.chat-commentary__round {
  color: var(--ai-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}
.chat-commentary__entry :deep(.ai-answer__body .rt) {
  color: var(--ai-muted);
  font-size: 13px;
  line-height: 1.65;
}
.chat-commentary__entry :deep(.rt > :first-child) { margin-top: 0; }
.chat-commentary__entry :deep(.rt > :last-child) { margin-bottom: 0; }
.chat-commentary__history { margin-bottom: 12px; }
.chat-commentary__history summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  min-height: 32px;
  padding: 0 4px;
  color: var(--ai-faint);
  font-size: 11px;
  cursor: pointer;
  list-style: none;
  border-radius: 4px;
}
.chat-commentary__history summary::-webkit-details-marker { display: none; }
.chat-commentary__history summary:hover { color: var(--ai-ink); }
.chat-commentary__history summary:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 2px;
}
.chat-commentary__history[open] summary > svg { transform: rotate(90deg); }
.chat-commentary__history ol {
  list-style: none;
  padding: 8px 0 4px;
  margin: 0;
  display: grid;
  gap: 16px;
}
</style>
