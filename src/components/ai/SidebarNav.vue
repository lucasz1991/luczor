<script setup lang="ts">
import { computed, ref } from 'vue'
import AiIcon from './AiIcon.vue'
import type { SearchItem } from './types'
const props = withDefaults(
  defineProps<{ title?: string; items: SearchItem[]; activeId?: string; activeChatId?: string; collapsed?: boolean }>(),
  { title: 'Luczor', activeId: undefined, activeChatId: undefined }
)
const emit = defineEmits<{
  select: [id: string]
  selectChat: [projectId: string, conversationId: string]
  renameChat: [projectId: string, conversationId: string, title: string]
  newProjectChat: [projectId: string]
  rename: [id: string, name: string]
  newChat: []
  addProject: []
  settings: []
  system: []
  agents: []
  planning: []
  workflows: []
  cloudProjects: []
  devices: []
  'update:collapsed': [value: boolean]
}>()
const query = ref('')
const editingId = ref('')
const editingLabel = ref('')
const editingChat = ref('')
const chatTitle = ref('')
const filtered = computed(() =>
  props.items.filter(item =>
    [item.label, ...(item.chats ?? []).map(chat => chat.label)].some(label =>
      label.toLocaleLowerCase('de').includes(query.value.toLocaleLowerCase('de'))
    )
  )
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
function finishChatRename(projectId: string, chatId: string) {
  if (editingChat.value !== chatId) return
  if (chatTitle.value.trim()) emit('renameChat', projectId, chatId, chatTitle.value.trim())
  editingChat.value = ''
}
function beginChatRename(chat: { id: string; label: string }) {
  editingChat.value = chat.id
  chatTitle.value = chat.label
}
const runLabels: Record<string, string> = {
  queued: 'Wartet',
  running: 'Arbeitet',
  waiting_resource: 'Wartet auf Ressourcen',
  waiting_approval: 'Freigabe nötig',
  interrupted: 'Fortsetzen möglich',
  failed: 'Fehlgeschlagen',
  cancelled: 'Gestoppt',
  completed: 'Erledigt',
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
    <button
      class="ai-sidebar__action"
      type="button"
      title="Projekte auf deinen Geräten abgleichen"
      @click="emit('cloudProjects')"
    >
      <AiIcon name="folder" /><span>Globale Projekte</span>
    </button>
    <button class="ai-sidebar__action" type="button" title="Geräteverbund" @click="emit('devices')">
      <AiIcon name="panel" /><span>Geräteverbund</span>
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
            v-if="item.cloud && !collapsed"
            class="ai-sidebar__cloud"
            title="Globales Projekt"
            aria-label="Globales Projekt"
            >↔</span
          >
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
        <div v-if="!collapsed && item.id === activeId" class="ai-sidebar__chats" :aria-label="`Chats in ${item.label}`">
          <div v-for="chat in item.chats ?? []" :key="chat.id" class="ai-sidebar__chat-row">
            <input
              v-if="editingChat === chat.id"
              v-model="chatTitle"
              class="ai-sidebar__rename"
              aria-label="Chatname bearbeiten"
              maxlength="160"
              @keydown.enter.prevent="finishChatRename(item.id, chat.id)"
              @keydown.esc.prevent="editingChat = ''"
              @blur="finishChatRename(item.id, chat.id)"
            />
            <button
              v-else
              type="button"
              class="ai-sidebar__chat"
              :class="{ 'is-current': chat.id === activeChatId }"
              :aria-current="chat.id === activeChatId ? 'page' : undefined"
              :title="chat.status ? `${chat.label} · ${runLabels[chat.status] ?? chat.status}` : chat.label"
              @click="emit('selectChat', item.id, chat.id)"
            >
              <span v-if="chat.busy" class="ai-sidebar__activity" :aria-label="runLabels[chat.status ?? 'running']" />
              <span v-else aria-hidden="true">·</span><span>{{ chat.label }}</span>
              <small v-if="['interrupted', 'failed', 'waiting_approval', 'queued'].includes(chat.status ?? '')">{{
                runLabels[chat.status!]
              }}</small>
            </button>
            <button
              v-if="editingChat !== chat.id"
              type="button"
              class="ai-sidebar__chat-edit"
              :aria-label="`Chat ${chat.label} umbenennen`"
              @click="beginChatRename(chat)"
            >
              <AiIcon name="settings" :size="11" />
            </button>
          </div>
          <button type="button" class="ai-sidebar__chat-new" @click="emit('newProjectChat', item.id)">
            <AiIcon name="plus" :size="12" /> Neuer Chat im Projekt
          </button>
        </div>
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

<style scoped>
.ai-sidebar__chats {
  flex: 0 0 100%;
  display: grid;
  gap: 3px;
  padding: 4px 4px 9px 18px;
  min-width: 0;
}
.ai-sidebar__project:has(.ai-sidebar__chats) {
  flex-wrap: wrap;
}
.ai-sidebar__chat-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 3px;
}
.ai-sidebar__chat {
  display: flex;
  gap: 7px;
  align-items: center;
  min-width: 0;
  flex: 1;
  padding: 7px 6px;
  border: 0;
  border-radius: 6px;
  color: var(--ai-muted, #aaa);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.ai-sidebar__chat > span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-sidebar__chat.is-current {
  color: var(--ai-text, #fff);
  background: rgba(255, 255, 255, 0.055);
}
.ai-sidebar__chat small {
  font-size: 9px;
  margin-left: auto;
}
.ai-sidebar__chat-edit {
  padding: 4px;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0;
}
.ai-sidebar__chat-row:hover .ai-sidebar__chat-edit,
.ai-sidebar__chat-edit:focus-visible {
  opacity: 0.7;
}
.ai-sidebar__chat-new {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px;
  background: transparent;
  border: 0;
  color: var(--ai-muted, #aaa);
  font-size: 11px;
  cursor: pointer;
}
</style>
