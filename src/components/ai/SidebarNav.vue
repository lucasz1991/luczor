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
  rename: [id: string, name: string]
  newChat: []
  addProject: []
  settings: []
  system: []
  agents: []
  planning: []
  workflows: []
  'update:collapsed': [value: boolean]
}>()
const query = ref('')
const editingId = ref('')
const editingLabel = ref('')
const filtered = computed(() =>
  props.items.filter(item => item.label.toLocaleLowerCase('de').includes(query.value.toLocaleLowerCase('de')))
)
function beginRename(item: SearchItem) {
  if (props.collapsed) return
  editingId.value = item.id
  editingLabel.value = item.label
}
function commitRename(item: SearchItem) {
  const next = editingLabel.value.trim()
  if (editingId.value !== item.id) return
  editingId.value = ''
  editingLabel.value = ''
  if (next && next !== item.label) emit('rename', item.id, next)
}
function cancelRename() {
  editingId.value = ''
  editingLabel.value = ''
}
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
    <button class="ai-sidebar__action" type="button" title="Agenten und Erinnerungsübertragung" @click="emit('agents')">
      <AiIcon name="spark" /><span>Agenten & Erinnerungen</span>
    </button>
    <button
      class="ai-sidebar__action"
      type="button"
      title="Optionales Planungsfenster öffnen"
      @click="emit('planning')"
    >
      <AiIcon name="check" /><span>Planungsfenster</span>
    </button>
    <button class="ai-sidebar__action" type="button" title="Workflows, Auslöser und Läufe" @click="emit('workflows')">
      <AiIcon name="tool" /><span>Workflows</span>
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
      <div
        v-for="item in filtered"
        :key="item.id"
        class="ai-sidebar__project"
        :class="{ 'is-active': item.id === activeId, 'is-busy': item.busy }"
      >
        <button
          type="button"
          class="ai-sidebar__project-main"
          :title="item.label"
          :aria-label="`Projekt ${item.label}`"
          :aria-current="item.id === activeId ? 'page' : undefined"
          @click="emit('select', item.id)"
        >
          <AiIcon name="folder" />
          <input
            v-if="editingId === item.id"
            v-model="editingLabel"
            class="ai-sidebar__rename"
            aria-label="Projektname bearbeiten"
            maxlength="160"
            @click.stop
            @keydown.enter.prevent="commitRename(item)"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename(item)"
          />
          <span v-else>{{ item.label }}</span>
          <span
            v-if="item.busy"
            class="ai-sidebar__activity"
            aria-label="AI läuft"
            title="In diesem Projekt läuft gerade eine AI"
          />
        </button>
        <button
          v-if="!collapsed && editingId !== item.id"
          type="button"
          class="ai-sidebar__edit"
          :aria-label="`${item.label} umbenennen`"
          @click.stop="beginRename(item)"
        >
          <AiIcon name="settings" :size="12" />
        </button>
      </div>
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
