<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AiIcon from './AiIcon.vue'
import type { SearchItem } from './types'
const props = withDefaults(defineProps<{ items: SearchItem[]; placeholder?: string; emptyLabel?: string }>(), {
  placeholder: 'Suchen…',
  emptyLabel: 'Keine passenden Ergebnisse.',
})
const emit = defineEmits<{ select: [id: string] }>()
const query = ref('')
const active = ref(0)
const results = computed(() =>
  props.items.filter(item =>
    `${item.label} ${item.description ?? ''}`.toLocaleLowerCase('de').includes(query.value.toLocaleLowerCase('de'))
  )
)
watch(query, () => {
  active.value = 0
})
function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    active.value = Math.max(0, Math.min(results.value.length - 1, active.value + (event.key === 'ArrowDown' ? 1 : -1)))
  }
  if (event.key === 'Enter' && results.value[active.value]) {
    event.preventDefault()
    emit('select', results.value[active.value]!.id)
  }
  if (event.key === 'Escape') query.value = ''
}
</script>
<template>
  <div class="ai-search">
    <label class="ai-search__field"
      ><AiIcon name="search" /><input
        v-model="query"
        type="search"
        :aria-label="placeholder"
        :placeholder="placeholder"
        @keydown="onKey"
    /></label>
    <div class="ai-search__results">
      <button
        v-for="(item, index) in results"
        :key="item.id"
        type="button"
        :class="{ 'is-highlighted': index === active }"
        @click="emit('select', item.id)"
      >
        <AiIcon :name="item.icon || 'arrow'" /><span
          >{{ item.label }}<small v-if="item.description">{{ item.description }}</small></span
        >
      </button>
      <p v-if="!results.length" class="ai-empty" role="status">{{ emptyLabel }}</p>
    </div>
  </div>
</template>
