<script setup lang="ts">
import { ref, watch } from 'vue'
import type { DiffRecord } from './types'
const props = withDefaults(defineProps<{ changes: DiffRecord[]; title?: string; busy?: boolean }>(), {
  title: 'Vorgeschlagene Änderungen',
})
const emit = defineEmits<{ apply: [ids: string[]] }>()
const selected = ref<string[]>([])
watch(
  () => props.changes.map(change => change.id),
  ids => {
    selected.value = selected.value.filter(id => ids.includes(id))
  },
  { immediate: true }
)
</script>
<template>
  <section class="ai-card ai-diff">
    <h3>{{ title }}</h3>
    <div class="ai-table-wrap">
      <table class="ai-table">
        <thead>
          <tr>
            <th scope="col">Übernehmen</th>
            <th scope="col">Bisher</th>
            <th scope="col">Vorschlag</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="change in changes" :key="change.id">
            <th scope="row">
              <label
                ><input v-model="selected" type="checkbox" :value="change.id" :disabled="busy" />{{
                  change.label
                }}</label
              >
            </th>
            <td>
              <del>{{ change.before || '—' }}</del>
            </td>
            <td>
              <ins>{{ change.after || '—' }}</ins>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="ai-card-actions">
      <span class="ai-muted">{{ selected.length }} ausgewählt</span
      ><button
        class="ai-button ai-button--primary"
        type="button"
        :disabled="!selected.length || busy"
        @click="emit('apply', [...selected])"
      >
        Auswahl übernehmen
      </button>
    </div>
  </section>
</template>
