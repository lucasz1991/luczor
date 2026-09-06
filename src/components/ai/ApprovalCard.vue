<script setup lang="ts">
import { ref, useId } from 'vue'
import AiIcon from './AiIcon.vue'
const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    detail?: string
    notice?: string
    approveLabel?: string
    rejectLabel?: string
    busy?: boolean
    choices?: string[]
    compact?: boolean
  }>(),
  {
    approveLabel: 'Einmal ausführen',
    rejectLabel: 'Ablehnen',
    choices: () => [],
    description: '',
    detail: '',
    notice: '',
  }
)
const emit = defineEmits<{ approve: [choice: string]; reject: [] }>()
const choice = ref('')
const submitted = ref(false)
const id = useId()
function resolve(approved: boolean) {
  if (props.busy || submitted.value) return
  submitted.value = true
  if (approved) emit('approve', choice.value)
  else emit('reject')
}
</script>
<template>
  <section class="ai-approval ai-card" :aria-labelledby="id">
    <div class="ai-eyebrow"><AiIcon name="shield" />Deine Entscheidung</div>
    <h3 :id="id">{{ title }}</h3>
    <p v-if="description" class="ai-muted">{{ description }}</p>
    <details v-if="detail && compact" class="ai-approval__details">
      <summary>Details prüfen</summary>
      <pre class="ai-approval__detail">{{ detail }}</pre>
    </details>
    <pre v-else-if="detail" class="ai-approval__detail">{{ detail }}</pre>
    <fieldset v-if="choices.length" class="ai-choices">
      <legend class="ai-sr-only">Auswahl</legend>
      <label v-for="item in choices" :key="item"
        ><input v-model="choice" type="radio" :name="id" :value="item" :disabled="busy || submitted" />{{ item }}</label
      >
    </fieldset>
    <p v-if="notice" class="ai-notice">{{ notice }}</p>
    <div class="ai-card-actions">
      <button class="ai-button" type="button" :disabled="busy || submitted" @click="resolve(false)">
        {{ rejectLabel }}</button
      ><button
        class="ai-button ai-button--primary"
        type="button"
        :disabled="busy || submitted || (choices.length > 0 && !choice)"
        @click="resolve(true)"
      >
        {{ submitted ? 'Entscheidung übermittelt' : approveLabel }}<AiIcon name="arrow" />
      </button>
    </div>
  </section>
</template>
