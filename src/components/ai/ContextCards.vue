<script setup lang="ts">
import AiIcon from './AiIcon.vue'
import type { ContextItem } from './types'
defineProps<{ items: ContextItem[]; title?: string }>()
</script>
<template>
  <section v-if="items.length" class="ai-context">
    <div class="ai-section-label">
      {{ title || 'Kontext' }}<span class="ai-badge">{{ items.length }}</span>
    </div>
    <div class="ai-context__grid">
      <details v-for="item in items" :key="item.id" class="ai-card">
        <summary>
          <AiIcon name="folder" /><span>{{ item.title }}</span
          ><span class="ai-badge">{{ item.kind || 'Text' }}</span>
        </summary>
        <p>{{ item.content }}</p>
        <footer>{{ item.source }}</footer>
      </details>
    </div>
  </section>
</template>
