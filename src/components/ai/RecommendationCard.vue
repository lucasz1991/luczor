<script setup lang="ts">
import AiIcon from './AiIcon.vue'
withDefaults(
  defineProps<{ title: string; description: string; evidence?: string; busy?: boolean; acceptLabel?: string }>(),
  { acceptLabel: 'Übernehmen', evidence: '' }
)
const emit = defineEmits<{ accept: []; dismiss: [] }>()
</script>
<template>
  <article class="ai-card ai-recommendation">
    <div class="ai-eyebrow"><AiIcon />Vorschlag</div>
    <h3>{{ title }}</h3>
    <p>{{ description }}</p>
    <p v-if="evidence" class="ai-muted">{{ evidence }}</p>
    <div class="ai-card-actions">
      <button type="button" class="ai-button" :disabled="busy" @click="emit('dismiss')">Verwerfen</button
      ><button type="button" class="ai-button ai-button--primary" :disabled="busy" @click="emit('accept')">
        {{ acceptLabel }}<AiIcon name="arrow" />
      </button>
    </div>
  </article>
</template>
