<script setup lang="ts">
withDefaults(defineProps<{ title?: string }>(), { title: 'Darstellung anpassen' })
const value = defineModel<{ radius: number; fontSize: number; spacing: number }>({ required: true })
</script>
<template>
  <section class="ai-card ai-tune">
    <h3>{{ title }}</h3>
    <label
      >Ecken
      <input
        type="range"
        min="0"
        max="28"
        step="1"
        :value="value.radius"
        @input="value = { ...value, radius: Number(($event.target as HTMLInputElement).value) }"
      /><output>{{ value.radius }} px</output></label
    ><label
      >Schriftgröße
      <input
        type="range"
        min="12"
        max="20"
        step="1"
        :value="value.fontSize"
        @input="value = { ...value, fontSize: Number(($event.target as HTMLInputElement).value) }"
      /><output>{{ value.fontSize }} px</output></label
    ><label
      >Abstand
      <input
        type="range"
        min="8"
        max="32"
        step="2"
        :value="value.spacing"
        @input="value = { ...value, spacing: Number(($event.target as HTMLInputElement).value) }"
      /><output>{{ value.spacing }} px</output></label
    >
  </section>
</template>
