<script setup lang="ts">
import { reactive } from 'vue'
import { MODEL_CONTROL_SCHEMA, validateModelControls } from '@/services/tools/modelControl'

const state = reactive({
  inference: 'local',
  thinking_tier: 'balanced',
  temperature: 0.7,
  top_p: 1,
  max_output_tokens: 8192,
})
const emit = defineEmits<{ (event: 'change', value: Record<string, unknown>): void }>()
function changed() {
  const value = validateModelControls({ ...state })
  emit('change', value)
}
</script>

<template>
  <section class="model-control-panel" aria-labelledby="model-control-title">
    <div class="tool-section-heading">
      <span id="model-control-title">Modellsteuerung</span><small>katalogvalidiert</small>
    </div>
    <div class="model-control-grid">
      <label
        >Ziel<select v-model="state.inference" @change="changed">
          <option value="local">Lokal</option>
          <option value="external">Extern</option>
        </select></label
      >
      <label
        >Denkstufe<select v-model="state.thinking_tier" @change="changed">
          <option v-for="tier in MODEL_CONTROL_SCHEMA.properties.thinking_tier.enum" :key="tier" :value="tier">
            {{ tier }}
          </option>
        </select></label
      >
      <label
        >Temperatur<input v-model.number="state.temperature" type="number" min="0" max="2" step="0.1" @change="changed"
      /></label>
      <label
        >Top-p<input v-model.number="state.top_p" type="number" min="0" max="1" step="0.05" @change="changed"
      /></label>
      <label class="model-control-wide"
        >Ausgabelimit<input
          v-model.number="state.max_output_tokens"
          type="number"
          min="256"
          max="131072"
          step="256"
          @change="changed"
      /></label>
    </div>
  </section>
</template>
