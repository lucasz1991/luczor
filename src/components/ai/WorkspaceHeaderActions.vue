<script setup lang="ts">
import { computed } from 'vue'
import HeaderActionMenu, { type HeaderAction } from './HeaderActionMenu.vue'
const props = defineProps<{
  standalone: boolean
  browserOpen: boolean
  toolsOpen: boolean
  auditOpen: boolean
  contextOpen: boolean
  checklistOpen: boolean
  checklistAvailable: boolean
  systemOpen: boolean
  light: boolean
}>()
defineEmits<{ action: [id: string] }>()
const groups = computed<Array<{ label: string; icon: string; items: HeaderAction[] }>>(() => [
  {
    label: 'Werkzeuge',
    icon: 'tool',
    items: [
      { id: 'browser', label: 'Chat Playground', icon: 'panel', active: props.browserOpen },
      { id: 'tools', label: 'Tool-Center', icon: 'tool', active: props.toolsOpen },
      { id: 'audit', label: 'Tool-Protokoll', icon: 'code', active: props.auditOpen },
    ],
  },
  {
    label: 'Chat',
    icon: 'chat',
    items: [
      { id: 'new-chat', label: 'Neuer Chat ohne Projekt', icon: 'plus' },
      { id: 'project-chat', label: 'Neuer Chat im Projekt', icon: 'chat', disabled: props.standalone },
      { id: 'create-project', label: 'Projekt erstellen', icon: 'folder', divider: true },
      { id: 'project-settings', label: 'Projekteinstellungen', icon: 'settings', disabled: props.standalone },
      {
        id: 'context',
        label: props.standalone ? 'Chatkontext' : 'Projektziele & Kontext',
        icon: 'check',
        active: props.contextOpen,
      },
      ...(props.checklistAvailable
        ? [{ id: 'checklist', label: 'Checkliste', icon: 'grid', active: props.checklistOpen }]
        : []),
    ],
  },
  {
    label: 'Ansicht',
    icon: 'grid',
    items: [
      { id: 'mini', label: 'Luczor Mini öffnen', icon: 'spark' },
      { id: 'system', label: 'Systemstatus', icon: 'gauge', active: props.systemOpen },
      { id: 'theme', label: props.light ? 'Dunkles Design' : 'Helles Design', icon: 'theme', divider: true },
      { id: 'notifications', label: 'Benachrichtigungen', icon: 'bell' },
      { id: 'settings', label: 'Einstellungen', icon: 'settings' },
    ],
  },
])
</script>
<template>
  <div class="workspace-header-actions">
    <HeaderActionMenu v-for="group in groups" :key="group.label" v-bind="group" @action="$emit('action', $event)" />
  </div>
</template>
<style scoped>
.workspace-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  position: relative;
  flex-shrink: 0;
}
.workspace-header-actions > :not(:first-child) {
  border-left: 1px solid var(--ai-line);
  padding-left: 3px;
}
</style>
