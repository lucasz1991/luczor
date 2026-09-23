<script setup lang="ts">
import { computed } from 'vue'
import AiIcon from '../ai/AiIcon.vue'
import MiniChatPopover from './MiniChatPopover.vue'
import type { MiniAction, MiniSnapshot } from '@/services/miniChat/types'

const props = defineProps<{ snapshot: MiniSnapshot; disabled?: boolean }>()
const emit = defineEmits<{ action: [action: MiniAction] }>()
const title = computed(() =>
  props.snapshot.view === 'workspace'
    ? 'Temporärer Chat'
    : props.snapshot.conversations?.find(chat => chat.id === props.snapshot.conversationId)?.title || 'Neuer Chat'
)
function selectView(view: MiniSnapshot['view'], close: () => void) {
  if (props.disabled) return
  emit('action', { type: 'view', sessionId: props.snapshot.sessionId, view })
  close()
}
function selectProject(event: Event) {
  emit('action', {
    type: 'select_project',
    sessionId: props.snapshot.sessionId,
    projectId: (event.target as HTMLSelectElement).value,
  })
}
function selectChat(conversationId: string, close: () => void) {
  if (!props.snapshot.project || props.disabled) return
  emit('action', {
    type: 'select_conversation',
    sessionId: props.snapshot.sessionId,
    projectId: props.snapshot.project.id,
    conversationId,
  })
  close()
}
function newChat(close: () => void) {
  if (!props.snapshot.project || props.disabled) return
  emit('action', {
    type: 'new_conversation',
    sessionId: props.snapshot.sessionId,
    projectId: props.snapshot.project.id,
  })
  close()
}
</script>

<template>
  <div class="mini-conversation-bar">
    <MiniChatPopover wide label="Chat wechseln">
      <template #trigger>
        <AiIcon :name="snapshot.view === 'workspace' ? 'spark' : 'chat'" :size="13" />
        <span class="mini-conversation-bar__title">{{ title }}</span>
        <small>{{ snapshot.project?.name || 'Chat auswählen' }}</small>
        <AiIcon name="chevron" :size="10" class="mini-conversation-bar__chevron" />
      </template>
      <template #default="{ close }">
        <div class="mini-context-chats mini-context-modes" role="group" aria-label="Unterhaltungsmodus">
          <button
            type="button"
            :aria-pressed="snapshot.view === 'workspace'"
            :disabled="disabled"
            @click="selectView('workspace', close)"
          >
            <AiIcon name="spark" :size="13" /><span>Temporärer Chat</span
            ><AiIcon v-if="snapshot.view === 'workspace'" name="check" :size="12" />
          </button>
          <button
            type="button"
            :aria-pressed="snapshot.view === 'chat'"
            :disabled="disabled || !snapshot.project"
            @click="selectView('chat', close)"
          >
            <AiIcon name="chat" :size="13" /><span>Im Hauptchat weiterarbeiten</span
            ><AiIcon v-if="snapshot.view === 'chat'" name="check" :size="12" />
          </button>
        </div>
        <label class="mini-context-project">
          <span>Chats & Projekte</span>
          <select
            :value="snapshot.project?.id ?? ''"
            :disabled="disabled"
            aria-label="Projekt oder freie Chats auswählen"
            @change="selectProject"
          >
            <option v-if="!snapshot.project" value="" disabled>Auswählen</option>
            <option v-for="project in snapshot.projects" :key="project.id" :value="project.id">
              {{ project.name }}
            </option>
          </select>
        </label>
        <div v-if="snapshot.view === 'chat'" class="mini-context-chats" role="group" aria-label="Unterhaltungen">
          <button
            v-for="chat in snapshot.conversations"
            :key="chat.id"
            type="button"
            :aria-pressed="chat.id === snapshot.conversationId"
            :disabled="disabled"
            @click="selectChat(chat.id, close)"
          >
            <AiIcon :name="chat.busy ? 'clock' : 'chat'" :size="13" />
            <span>{{ chat.title }}</span>
            <AiIcon v-if="chat.id === snapshot.conversationId" name="check" :size="12" />
          </button>
          <button
            type="button"
            class="mini-context-new"
            :disabled="!snapshot.project || disabled"
            @click="newChat(close)"
          >
            <AiIcon name="plus" :size="13" /> Neuer Chat
          </button>
        </div>
      </template>
    </MiniChatPopover>
  </div>
</template>

<style scoped>
.mini-conversation-bar {
  display: flex;
  flex-shrink: 0;
  padding: 0 12px 6px;
  min-width: 0;
  border-bottom: 1px solid var(--ai-line);
}
.mini-conversation-bar__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--ai-ink);
}
.mini-conversation-bar small {
  margin-left: auto;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--ai-faint);
}
.mini-conversation-bar__chevron {
  flex-shrink: 0;
  transform: rotate(90deg);
}
.mini-context-project {
  display: grid;
  gap: 6px;
  padding: 6px;
  font-size: 11px;
  color: var(--ai-muted);
}
.mini-context-project select {
  width: 100%;
  min-width: 0;
  padding: 7px;
  border: 1px solid var(--ai-line);
  border-radius: 7px;
  background: var(--ai-page);
  color: var(--ai-ink);
  font: inherit;
}
.mini-context-chats {
  display: grid;
  gap: 2px;
  padding: 4px 0 0;
}
.mini-context-modes {
  border-bottom: 1px solid var(--ai-line);
  padding-bottom: 6px;
  margin-bottom: 5px;
}
.mini-context-chats button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  min-width: 0;
  border-radius: 6px;
  text-align: left;
  font-size: 11px;
}
.mini-context-chats button span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-context-chats button:hover,
.mini-context-chats button[aria-pressed='true'] {
  background: var(--ai-hover);
}
.mini-context-chats .mini-context-new {
  border-top: 1px solid var(--ai-line);
  margin-top: 5px;
  border-radius: 0;
  color: var(--ai-muted);
}
</style>
