<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TableColumn, TableRecord } from './types'
const props = defineProps<{ columns: TableColumn[]; rows: TableRecord[]; caption?: string }>()
const sort = ref('')
const direction = ref(1)
function order(key: string) {
  direction.value = sort.value === key ? -direction.value : 1
  sort.value = key
}
const sorted = computed(() =>
  [...props.rows].sort((first, second) => {
    if (!sort.value) return 0
    const left = first[sort.value] ?? ''
    const right = second[sort.value] ?? ''
    return (
      direction.value *
      (typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'de', { numeric: true }))
    )
  })
)
</script>
<template>
  <div class="ai-table-wrap" tabindex="0" :aria-label="caption || 'Datentabelle'">
    <table class="ai-table">
      <caption v-if="caption">
        {{
          caption
        }}
      </caption>
      <thead>
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            scope="col"
            :aria-sort="sort === column.key ? (direction === 1 ? 'ascending' : 'descending') : 'none'"
          >
            <button type="button" @click="order(column.key)">
              {{ column.label
              }}<span aria-hidden="true">{{ sort === column.key ? (direction === 1 ? '↑' : '↓') : '↕' }}</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in sorted" :key="row.id">
          <td v-for="column in columns" :key="column.key">{{ row[column.key] ?? '—' }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length" class="ai-empty">Keine Einträge vorhanden.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
