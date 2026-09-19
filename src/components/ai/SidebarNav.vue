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
  deleteChat: [projectId: string, conversationId: string, title: string]
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
  memory: []
  'update:collapsed': [value: boolean]
}>()
/* Every rail item flies out its own column while collapsed (projects stays the default). */
type RailPane = 'projects' | 'agents' | 'planning' | 'workflows' | 'cloud' | 'devices'
const pane = ref<RailPane>('projects')
let paneReset: ReturnType<typeof setTimeout> | undefined
function showPane(next: RailPane) {
  if (paneReset) clearTimeout(paneReset)
  pane.value = next
}
function leaveRail() {
  if (paneReset) clearTimeout(paneReset)
  // Let the fly-out finish fading before the content snaps back to projects.
  paneReset = setTimeout(() => (pane.value = 'projects'), 320)
}
const sections: Record<
  Exclude<RailPane, 'projects'>,
  {
    title: string
    icon: string
    text: string
    action: string
    event: 'agents' | 'planning' | 'workflows' | 'cloudProjects' | 'devices'
  }
> = {
  agents: {
    title: 'Agenten & Erinnerungen',
    icon: 'spark',
    text: 'Teams aus Spezialisten, Modellzuordnung und die Übertragung von Erinnerungen zwischen Projekten.',
    action: 'Agenten-Hub öffnen',
    event: 'agents',
  },
  planning: {
    title: 'Planungsfenster',
    icon: 'check',
    text: 'Ziele, Schritte und Freigaben für das aktive Projekt – vor der Ausführung gemeinsam abstimmen.',
    action: 'Planung öffnen',
    event: 'planning',
  },
  workflows: {
    title: 'Workflows',
    icon: 'tool',
    text: 'Wiederholbare Abläufe mit Auslösern, Läufen und Ergebnisverlauf.',
    action: 'Workflows öffnen',
    event: 'workflows',
  },
  cloud: {
    title: 'Globale Projekte',
    icon: 'folder',
    text: 'Projekte, die zwischen deinen Geräten abgeglichen werden.',
    action: 'Abgleich öffnen',
    event: 'cloudProjects',
  },
  devices: {
    title: 'Geräteverbund',
    icon: 'panel',
    text: 'Verbundene Geräte, Master-Zuordnung und laufende Aufträge.',
    action: 'Geräteverbund öffnen',
    event: 'devices',
  },
}
const activeSection = computed(() => sections[pane.value === 'projects' ? 'agents' : pane.value])
function openSection(next: RailPane) {
  switch (next) {
    case 'agents':
      emit('agents')
      break
    case 'planning':
      emit('planning')
      break
    case 'workflows':
      emit('workflows')
      break
    case 'cloud':
      emit('cloudProjects')
      break
    case 'devices':
      emit('devices')
      break
  }
}
const cloudItems = computed(() => props.items.filter(item => item.cloud))
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
/* Chats of every project stay reachable: the shown project and projects with
 * running chats open by default; the user can fold or unfold any project. */
const folded = ref(new Set<string>())
const unfolded = ref(new Set<string>())
function chatsOpen(item: SearchItem): boolean {
  if (folded.value.has(item.id)) return false
  return item.id === props.activeId || unfolded.value.has(item.id) || !!item.chats?.some(chat => chat.busy)
}
function toggleChats(item: SearchItem) {
  const open = chatsOpen(item)
  const nextFolded = new Set(folded.value)
  const nextUnfolded = new Set(unfolded.value)
  if (open) {
    nextFolded.add(item.id)
    nextUnfolded.delete(item.id)
  } else {
    nextFolded.delete(item.id)
    nextUnfolded.add(item.id)
  }
  folded.value = nextFolded
  unfolded.value = nextUnfolded
}
/** Live chats across all projects, for switching to them directly. */
const liveChats = computed(() =>
  props.items.flatMap(item =>
    (item.chats ?? [])
      .filter(chat => chat.busy || ['waiting_approval', 'interrupted'].includes(chat.status ?? ''))
      .map(chat => ({ ...chat, projectId: item.id, projectLabel: item.label }))
  )
)
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
  <aside
    class="ai-sidebar"
    :class="{ 'is-collapsed': collapsed }"
    :data-pane="pane"
    aria-label="Workspace-Navigation"
    @pointerleave="leaveRail"
  >
    <!-- Icon rail: always visible, labels as tooltips -->
    <nav class="ai-rail" aria-label="Bereiche">
      <div class="ai-sidebar__brand">
        <span class="ai-brand-mark"><AiIcon :size="21" /></span><strong>{{ title }}</strong>
      </div>
      <button
        class="ai-sidebar__new"
        type="button"
        title="Neuer Chat"
        aria-label="Neuer Chat"
        @pointerenter="showPane('projects')"
        @click="emit('newChat')"
      >
        <AiIcon name="plus" /><span>Neuer Chat</span>
      </button>
      <button
        class="ai-icon-button ai-rail__toggle"
        type="button"
        :title="collapsed ? 'Projekte andocken' : 'Projekte einklappen'"
        :aria-label="collapsed ? 'Projekte andocken' : 'Projekte einklappen'"
        :aria-expanded="!collapsed"
        @pointerenter="showPane('projects')"
        @click="emit('update:collapsed', !collapsed)"
      >
        <AiIcon name="panel" />
      </button>
      <button
        class="ai-sidebar__action"
        type="button"
        title="Projektordner öffnen"
        aria-label="Projektordner öffnen"
        @pointerenter="showPane('projects')"
        @click="emit('addProject')"
      >
        <AiIcon name="folder" /><span>Projektordner öffnen</span>
      </button>
      <button
        class="ai-sidebar__action"
        type="button"
        title="Agenten und Erinnerungsübertragung"
        aria-label="Agenten und Erinnerungsübertragung"
        @pointerenter="showPane('agents')"
        @focus="showPane('agents')"
        @click="emit('agents')"
      >
        <AiIcon name="spark" /><span>Agenten & Erinnerungen</span>
      </button>
      <button
        class="ai-sidebar__action"
        type="button"
        title="Optionales Planungsfenster öffnen"
        aria-label="Planungsfenster öffnen"
        @pointerenter="showPane('planning')"
        @focus="showPane('planning')"
        @click="emit('planning')"
      >
        <AiIcon name="check" /><span>Planungsfenster</span>
      </button>
      <button
        class="ai-sidebar__action"
        type="button"
        title="Workflows, Auslöser und Läufe"
        aria-label="Workflows, Auslöser und Läufe"
        @pointerenter="showPane('workflows')"
        @focus="showPane('workflows')"
        @click="emit('workflows')"
      >
        <AiIcon name="tool" /><span>Workflows</span>
      </button>
      <button
        class="ai-sidebar__action"
        type="button"
        title="Projekte auf deinen Geräten abgleichen"
        aria-label="Globale Projekte"
        @pointerenter="showPane('cloud')"
        @focus="showPane('cloud')"
        @click="emit('cloudProjects')"
      >
        <AiIcon name="folder" /><span>Globale Projekte</span>
      </button>
      <button
        class="ai-sidebar__action"
        type="button"
        title="Geräteverbund"
        aria-label="Geräteverbund"
        @pointerenter="showPane('devices')"
        @focus="showPane('devices')"
        @click="emit('devices')"
      >
        <AiIcon name="panel" /><span>Geräteverbund</span>
      </button>
      <button
        class="ai-sidebar__action"
        type="button"
        title="Gedächtnis und 3D-Graph"
        aria-label="Gedächtnis und 3D-Graph"
        @click="emit('memory')"
      >
        <AiIcon name="spark" /><span>Gedächtnis</span>
      </button>
      <footer>
        <button
          type="button"
          title="Systemstatus und Not-Aus"
          aria-label="Systemstatus und Not-Aus"
          @click="emit('system')"
        >
          <AiIcon name="shield" /><span>Systemstatus</span></button
        ><button type="button" title="Einstellungen" aria-label="Einstellungen" @click="emit('settings')">
          <AiIcon name="settings" /><span>Einstellungen</span>
        </button>
      </footer>
    </nav>

    <!-- Projects: docked column, or a fly-out on hover while collapsed -->
    <div class="ai-sidebar__panel">
      <template v-if="pane !== 'projects'">
        <div class="ai-sidebar__section">
          <span>{{ activeSection.title }}</span>
        </div>
        <div class="ai-rail-pane">
          <p class="ai-rail-pane__text">{{ activeSection.text }}</p>
          <slot :name="pane">
            <nav v-if="pane === 'cloud'" class="ai-sidebar__items">
              <button
                v-for="item in cloudItems"
                :key="item.id"
                type="button"
                class="ai-sidebar__project-main ai-rail-pane__row"
                :class="{ 'is-active': item.id === activeId }"
                @click="emit('select', item.id)"
              >
                <AiIcon name="folder" /><span>{{ item.label }}</span>
              </button>
              <p v-if="!cloudItems.length" class="ai-empty">Noch kein Projekt wird abgeglichen.</p>
            </nav>
          </slot>
          <button type="button" class="ai-rail-pane__open" @click="openSection(pane)">
            <AiIcon :name="activeSection.icon" :size="14" /><span>{{ activeSection.action }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <div class="ai-sidebar__section">
          <span>Projekte</span><span>{{ items.length }}</span>
        </div>
        <label class="ai-search__field"
          ><AiIcon name="search" /><input
            v-model="query"
            type="search"
            aria-label="Projekte suchen"
            placeholder="Projekte suchen"
        /></label>
        <nav v-if="liveChats.length" class="ai-sidebar__live" aria-label="Laufende Chats">
          <div class="ai-sidebar__section">
            <span>Laufende Chats</span><span>{{ liveChats.length }}</span>
          </div>
          <button
            v-for="chat in liveChats"
            :key="chat.id"
            type="button"
            class="ai-sidebar__chat ai-sidebar__live-chat"
            :class="{ 'is-current': chat.id === activeChatId }"
            :title="`${chat.projectLabel} · ${chat.label} · ${runLabels[chat.status ?? 'running'] ?? chat.status}`"
            @click="emit('selectChat', chat.projectId, chat.id)"
          >
            <span
              v-if="chat.busy"
              class="ai-sidebar__activity"
              :aria-label="runLabels[chat.status ?? 'running']"
            /><span v-else aria-hidden="true">·</span>
            <span>{{ chat.label }}</span>
            <small>{{ chat.projectLabel }}</small>
          </button>
        </nav>
        <nav class="ai-sidebar__items">
          <div
            v-for="item in filtered"
            :key="item.id"
            class="ai-sidebar__project"
            :class="{ 'is-active': item.id === activeId, 'is-busy': item.busy, 'is-open': chatsOpen(item) }"
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
              <span v-if="item.cloud" class="ai-sidebar__cloud" title="Globales Projekt" aria-label="Globales Projekt"
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
              v-if="editingId !== item.id"
              type="button"
              class="ai-sidebar__edit"
              :aria-label="`${item.label} umbenennen`"
              @click.stop="beginRename(item)"
            >
              <AiIcon name="settings" :size="12" />
            </button>
            <button
              type="button"
              class="ai-sidebar__edit ai-sidebar__fold"
              :aria-label="chatsOpen(item) ? `Chats in ${item.label} einklappen` : `Chats in ${item.label} anzeigen`"
              :aria-expanded="chatsOpen(item)"
              @click.stop="toggleChats(item)"
            >
              <AiIcon name="chevron" :size="12" />
            </button>
            <div v-if="chatsOpen(item)" class="ai-sidebar__chats" :aria-label="`Chats in ${item.label}`">
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
                  <span
                    v-if="chat.busy"
                    class="ai-sidebar__activity"
                    :aria-label="runLabels[chat.status ?? 'running']"
                  />
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
                <button
                  v-if="editingChat !== chat.id"
                  type="button"
                  class="ai-sidebar__chat-edit ai-sidebar__chat-delete"
                  :aria-label="`Chat ${chat.label} löschen`"
                  @click="emit('deleteChat', item.id, chat.id, chat.label)"
                >
                  <AiIcon name="trash" :size="11" />
                </button>
              </div>
              <button type="button" class="ai-sidebar__chat-new" @click="emit('newProjectChat', item.id)">
                <AiIcon name="plus" :size="12" /> Neuer Chat im Projekt
              </button>
            </div>
          </div>
          <p v-if="!filtered.length" class="ai-empty">Kein Projekt gefunden.</p>
        </nav>
      </template>
    </div>
  </aside>
</template>

<style scoped>
/* ---------- Leiste + Projektspalte ---------- */
.ai-sidebar {
  --rail-w: 56px;
  --panel-w: 240px;
  position: relative;
  display: grid;
  grid-template-columns: var(--rail-w) minmax(0, 1fr);
  gap: 0;
  padding: 0;
  overflow: visible;
}
.ai-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 0 10px;
  min-height: 0;
  border-right: 1px solid var(--ai-line);
  background: var(--ai-canvas);
}
.ai-rail .ai-sidebar__brand {
  width: 38px;
  height: 38px;
  margin: 0 0 8px;
  justify-content: center;
}
.ai-rail .ai-sidebar__brand strong,
.ai-rail button > span,
.ai-rail footer small {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.ai-rail .ai-sidebar__new,
.ai-rail .ai-sidebar__action,
.ai-rail .ai-rail__toggle,
.ai-rail footer button {
  width: 38px;
  min-height: 38px;
  height: 38px;
  padding: 0;
  justify-content: center;
  border-radius: 11px;
  flex-shrink: 0;
}
.ai-rail .ai-rail__toggle {
  color: var(--ai-faint);
  border: 0;
  background: transparent;
}
.ai-rail .ai-rail__toggle:hover,
.ai-sidebar:not(.is-collapsed) .ai-rail .ai-rail__toggle {
  color: var(--ai-ink);
  background: var(--ai-hover);
}
.ai-rail footer {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--ai-line);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.ai-sidebar__panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 14px 10px 12px;
  gap: 6px;
  background: var(--ai-canvas);
  border-right: 1px solid var(--ai-line);
}
.ai-sidebar__panel .ai-sidebar__section {
  padding: 0 6px 6px;
}
.ai-sidebar__panel .ai-sidebar__items {
  padding-top: 2px;
}
/* Section fly-outs: same column as projects, one pane per rail item. */
.ai-rail-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 2px 6px;
  animation: ai-rail-pane-in 320ms var(--ease, ease) both;
}
@keyframes ai-rail-pane-in {
  from {
    opacity: 0;
    transform: translateX(-6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.ai-rail-pane__text {
  margin: 0;
  color: var(--ai-muted);
  font-size: 11.5px;
  line-height: 1.55;
}
.ai-rail-pane__row {
  width: 100%;
}
.ai-rail-pane__open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: auto;
  padding: 8px 12px;
  border: 1px solid var(--ai-line);
  border-radius: 999px;
  background: var(--ai-inset, transparent);
  color: var(--ai-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    background 200ms var(--ease, ease),
    border-color 200ms var(--ease, ease);
}
.ai-rail-pane__open:hover {
  border-color: var(--ai-line-strong);
  background: var(--ai-hover);
}
/* Collapsed: rail only, projects fly out on hover */
.ai-sidebar.is-collapsed {
  grid-template-columns: var(--rail-w);
}
.ai-sidebar.is-collapsed .ai-sidebar__panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--rail-w);
  width: var(--panel-w);
  z-index: 40;
  opacity: 0;
  transform: translateX(-12px);
  pointer-events: none;
  background: var(--g-bg, var(--ai-canvas));
  backdrop-filter: blur(var(--blur, 24px)) saturate(160%);
  -webkit-backdrop-filter: blur(var(--blur, 24px)) saturate(160%);
  box-shadow: 30px 0 60px -34px rgba(0, 0, 0, 0.7);
  transition:
    transform var(--dur-slow, 420ms) var(--ease, ease),
    opacity var(--dur, 240ms) var(--ease, ease);
}
.ai-sidebar.is-collapsed:hover .ai-sidebar__panel,
.ai-sidebar.is-collapsed .ai-sidebar__panel:focus-within {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
@media (max-width: 1100px) {
  .ai-sidebar {
    grid-template-columns: var(--rail-w);
  }
  .ai-sidebar .ai-sidebar__panel {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--rail-w);
    width: var(--panel-w);
    z-index: 40;
    opacity: 0;
    transform: translateX(-12px);
    pointer-events: none;
  }
  .ai-sidebar:hover .ai-sidebar__panel,
  .ai-sidebar .ai-sidebar__panel:focus-within {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-sidebar.is-collapsed .ai-sidebar__panel {
    transition: none;
  }
}

.ai-sidebar__live {
  display: grid;
  gap: 2px;
  padding: 0 4px 6px;
}
.ai-sidebar__live-chat small {
  font-size: 9px;
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}
.ai-sidebar__fold {
  width: auto;
  min-height: 0;
  flex: 0 0 auto;
  padding: 4px;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  transition: transform var(--dur, 240ms) var(--ease, ease);
}
.ai-sidebar__project.is-open .ai-sidebar__fold {
  transform: rotate(90deg);
}
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
  width: auto;
  flex: 1 1 0;
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
  width: auto;
  min-height: 0;
  flex: 0 0 auto;
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
.ai-sidebar__chat-delete:hover,
.ai-sidebar__chat-delete:focus-visible {
  color: var(--ai-red, #e06c75);
  opacity: 1;
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
