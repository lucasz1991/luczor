<script setup lang="ts">
import { computed, ref } from 'vue'
import AiIcon from './AiIcon.vue'
import type { SearchItem } from './types'
const props = withDefaults(
  defineProps<{ title?: string; items: SearchItem[]; activeId?: string; collapsed?: boolean }>(),
  { title: 'Luczor', activeId: undefined }
)
const emit = defineEmits<{
  select: [id: string]
  newChat: []
  addProject: []
  settings: []
  system: []
  'update:collapsed': [value: boolean]
}>()
const query = ref('')
const filtered = computed(() =>
  props.items.filter(item => item.label.toLocaleLowerCase('de').includes(query.value.toLocaleLowerCase('de')))
)
</script>
<template>
  <aside class="ai-sidebar" :class="{ 'is-collapsed': collapsed }" aria-label="Workspace-Navigation">
    <div class="ai-sidebar__brand">
      <span class="ai-brand-mark"><AiIcon :size="21" /></span><strong>{{ title }}</strong
      ><button
        class="ai-icon-button"
        type="button"
        :aria-label="collapsed ? 'Navigation aufklappen' : 'Navigation einklappen'"
        :aria-expanded="!collapsed"
        @click="emit('update:collapsed', !collapsed)"
      >
        <AiIcon name="panel" />
      </button>
    </div>
    <button class="ai-sidebar__new" type="button" title="Neuer Chat" @click="emit('newChat')">
      <AiIcon name="plus" /><span>Neuer Chat</span>
    </button>
    <button class="ai-sidebar__action" type="button" title="Projektordner öffnen" @click="emit('addProject')">
      <AiIcon name="folder" /><span>Projektordner öffnen</span>
    </button>
    <div class="ai-sidebar__section">
      <span>Projekte</span><span>{{ items.length }}</span>
    </div>
    <label v-if="!collapsed" class="ai-search__field"
      ><AiIcon name="search" /><input
        v-model="query"
        type="search"
        aria-label="Projekte suchen"
        placeholder="Projekte suchen"
    /></label>
    <nav class="ai-sidebar__items">
      <button
        v-for="item in filtered"
        :key="item.id"
        type="button"
        :title="item.label"
        :aria-label="`Projekt ${item.label}`"
        :aria-current="item.id === activeId ? 'page' : undefined"
        :class="{ 'is-active': item.id === activeId }"
        @click="emit('select', item.id)"
      >
        <AiIcon name="folder" /><span>{{ item.label }}</span>
      </button>
      <p v-if="!filtered.length && !collapsed" class="ai-empty">Kein Projekt gefunden.</p>
    </nav>
    <footer>
      <button type="button" title="Systemstatus und Not-Aus" @click="emit('system')">
        <AiIcon name="shield" /><span>Systemstatus</span></button
      ><button type="button" title="Einstellungen" @click="emit('settings')">
        <AiIcon name="settings" /><span>Einstellungen</span>
      </button>
    </footer>
  </aside>
</template>
