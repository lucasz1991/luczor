<script setup lang="ts">
import { computed } from 'vue'
import AiIcon from './AiIcon.vue'
import { useClipboard } from '@/composables/useClipboard'
const props = defineProps<{ code: string; language?: string; filename?: string; diff?: boolean }>()
const lines = computed(() => props.code.split('\n'))
const { copy, copied, error } = useClipboard()
</script>
<template>
  <figure class="ai-code">
    <figcaption>
      <span><AiIcon name="code" />{{ filename || language || 'Code' }}</span
      ><button
        class="ai-icon-button"
        type="button"
        :aria-label="copied ? 'Code kopiert' : 'Code kopieren'"
        @click="copy(code)"
      >
        <AiIcon :name="copied ? 'check' : 'copy'" />{{ copied ? 'Kopiert' : 'Kopieren' }}
      </button>
    </figcaption>
    <pre
      tabindex="0"
      aria-label="Quelltext"
    ><code><span v-for="(line, index) in lines" :key="index" class="ai-code__line" :class="{ 'is-add': diff && line.startsWith('+'), 'is-remove': diff && line.startsWith('-') }"><span class="ai-code__number" aria-hidden="true">{{ index + 1 }}</span><span>{{ line || ' ' }}</span>
</span></code></pre>
    <p v-if="error" role="status">{{ error }}</p>
  </figure>
</template>
