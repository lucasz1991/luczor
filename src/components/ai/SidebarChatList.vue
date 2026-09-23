<script setup lang="ts">
import { nextTick, ref } from 'vue'
import AiIcon from './AiIcon.vue'
export type NavigationChat = { id: string; projectId: string; label: string; busy?: boolean; status?: string }
defineProps<{ chats: NavigationChat[]; activeId?: string }>()
const emit = defineEmits<{
  select: [projectId: string, chatId: string]
  rename: [projectId: string, chatId: string, title: string]
  delete: [projectId: string, chatId: string, title: string]
}>()
const editing = ref('')
const title = ref('')
const list = ref<HTMLElement | null>(null)
const labels: Record<string, string> = {
  running: 'Arbeitet',
  waiting_approval: 'Freigabe nötig',
  interrupted: 'Fortsetzen',
  failed: 'Fehler',
  queued: 'Wartet',
  waiting_resource: 'Wartet',
}
async function edit(chat: NavigationChat) {
  title.value = chat.label
  editing.value = chat.id
  await nextTick()
  list.value?.querySelector<HTMLInputElement>('input')?.focus()
}
function save(chat: NavigationChat) {
  if (editing.value !== chat.id) return
  editing.value = ''
  if (title.value.trim()) emit('rename', chat.projectId, chat.id, title.value.trim())
}
</script>
<template>
  <div ref="list" class="sidebar-chat-list">
    <div v-for="chat in chats" :key="chat.id" class="chat-row">
      <input
        v-if="editing === chat.id"
        v-model="title"
        class="ai-sidebar__rename"
        aria-label="Chatname bearbeiten"
        maxlength="160"
        @keydown.enter.prevent="save(chat)"
        @keydown.esc.prevent="editing = ''"
        @blur="save(chat)"
      />
      <button
        v-else
        type="button"
        class="chat-select"
        :class="{ 'is-current': chat.id === activeId }"
        :aria-current="chat.id === activeId ? 'page' : undefined"
        :title="chat.status && labels[chat.status] ? `${chat.label} · ${labels[chat.status]}` : chat.label"
        @click="emit('select', chat.projectId, chat.id)"
      >
        <span v-if="chat.busy" class="ai-sidebar__activity" aria-label="Arbeitet" /><AiIcon
          v-else
          name="chat"
          :size="12"
        />
        <span>{{ chat.label }}</span
        ><small v-if="chat.status && labels[chat.status]">{{ labels[chat.status] }}</small>
      </button>
      <template v-if="editing !== chat.id">
        <button type="button" class="chat-action" :aria-label="`Chat ${chat.label} umbenennen`" @click="edit(chat)">
          <AiIcon name="edit" :size="11" />
        </button>
        <button
          type="button"
          class="chat-action chat-action--delete"
          :aria-label="`Chat ${chat.label} löschen`"
          @click="emit('delete', chat.projectId, chat.id, chat.label)"
        >
          <AiIcon name="trash" :size="11" />
        </button>
      </template>
    </div>
  </div>
</template>
<style scoped>
.sidebar-chat-list {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.chat-row {
  display: flex;
  align-items: center;
  min-width: 0;
}
.sidebar-chat-list .chat-select {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 0;
  min-width: 0;
  min-height: 28px;
  padding: 4px 6px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ai-muted);
  font: 11px/18px var(--ai-font);
  cursor: pointer;
  text-align: left;
}
.chat-select > span:not(.ai-sidebar__activity) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-chat-list .chat-select.is-current {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.chat-select small {
  margin-left: auto;
  font-size: 9px;
  color: var(--ai-accent);
  white-space: nowrap;
}
.sidebar-chat-list .chat-action {
  display: grid;
  place-items: center;
  width: 22px;
  min-height: 26px;
  padding: 3px;
  border: 0;
  background: transparent;
  color: var(--ai-faint);
  opacity: 0;
  cursor: pointer;
}
.chat-row:hover .chat-action,
.chat-row:focus-within .chat-action {
  opacity: 1;
}
.sidebar-chat-list .chat-action--delete:hover {
  color: var(--ai-red);
}
.chat-select .ai-sidebar__activity {
  width: 10px;
  height: 10px;
}
@media (pointer: coarse) {
  .sidebar-chat-list .chat-select {
    min-height: 40px;
  }
  .sidebar-chat-list .chat-action {
    min-height: 40px;
    width: 28px;
    opacity: 1;
  }
}
</style>
