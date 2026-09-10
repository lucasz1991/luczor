<script setup lang="ts">
defineProps<{ ephemeral: boolean }>()
const emit = defineEmits<{ (event: 'save'): void }>()
</script>

<template>
  <section class="tool-artifact-picker" aria-label="Ergebnisablage">
    <span><strong>Ergebnisse</strong> · {{ ephemeral ? 'temporär' : 'Projektartefakt' }}</span>
    <button v-if="ephemeral" type="button" @click="emit('save')">Als Projektartefakt speichern</button>
  </section>
</template>
