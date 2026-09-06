<script setup lang="ts">
import AiIcon from './AiIcon.vue'
import LoadingState from './LoadingState.vue'
defineProps<{ title?: string; imageSrc?: string; active?: boolean; canOpen?: boolean }>()
const emit = defineEmits<{ open: [] }>()
</script>
<template>
  <section class="ai-card ai-agent-screen">
    <header>
      <span><AiIcon name="panel" />{{ title || 'Agent-Ansicht' }}</span
      ><button type="button" class="ai-button" :disabled="!canOpen" @click="emit('open')">
        Öffnen <AiIcon name="arrow" :size="13" />
      </button>
    </header>
    <div class="ai-agent-screen__viewport">
      <img v-if="imageSrc" :src="imageSrc" alt="Vom Agenten bereitgestellte Bildschirmansicht" /><slot v-else
        ><LoadingState v-if="active" label="Ansicht wird geladen" />
        <p v-else class="ai-empty">Keine Bildschirmansicht vorhanden.</p></slot
      >
    </div>
  </section>
</template>
