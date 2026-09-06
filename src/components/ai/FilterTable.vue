<script setup lang="ts">
import { computed, ref } from 'vue'
import RecordsTable from './RecordsTable.vue'
import type { TableColumn, TableRecord } from './types'
const props = withDefaults(
  defineProps<{ columns: TableColumn[]; rows: TableRecord[]; filterKey?: string; caption?: string }>(),
  { filterKey: 'status', caption: '' }
)
const selected = ref<string | null>(null)
const filters = computed(() => [...new Set(props.rows.map(row => String(row[props.filterKey] ?? '—')))])
const filtered = computed(() =>
  selected.value === null
    ? props.rows
    : props.rows.filter(row => String(row[props.filterKey] ?? '—') === selected.value)
)
</script>
<template>
  <section class="ai-filter">
    <div class="ai-segmented" aria-label="Tabelle filtern">
      <button type="button" :aria-pressed="selected === null" @click="selected = null">
        Alle <span>{{ rows.length }}</span></button
      ><button
        v-for="filter in filters"
        :key="filter"
        type="button"
        :aria-pressed="selected === filter"
        @click="selected = filter"
      >
        {{ filter }} <span>{{ rows.filter(row => String(row[filterKey] ?? '—') === filter).length }}</span>
      </button>
    </div>
    <RecordsTable :columns="columns" :rows="filtered" :caption="caption" />
  </section>
</template>
