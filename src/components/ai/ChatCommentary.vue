<script setup lang="ts">
import type { ChatCommentary } from '@/state/types'
import StreamingText from './StreamingText.vue'
defineProps<{ entries: ChatCommentary[]; messageId?: string }>()
</script>

<template>
  <section v-if="entries.length" class="chat-commentary" aria-label="Öffentliche Fortschrittsmeldungen">
    <div v-for="entry in entries" :key="entry.id" class="chat-commentary__entry">
      <StreamingText
        :content="entry.content"
        :animate="false"
        :actions="false"
        :speech-key="messageId ? `${messageId}:${entry.id}` : undefined"
      />
    </div>
  </section>
</template>

<style scoped>
.chat-commentary {
  display: grid;
  gap: 14px;
  margin-block: 12px 18px;
}
.chat-commentary__entry {
  border-inline-start: 2px solid var(--ai-border, rgba(128, 128, 128, 0.25));
  padding-inline-start: 14px;
  min-width: 0;
}
.chat-commentary__entry > .ai-section-label {
  display: block;
  margin-block-end: 5px;
}
</style>
