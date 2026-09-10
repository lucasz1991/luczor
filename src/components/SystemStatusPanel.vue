<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { OrbPhase } from '@/services/miniChat/presentation'
import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'
import LocalModelAnalysis from './LocalModelAnalysis.vue'
import JarvisHud from './JarvisHud.vue'
import LocalModelStatus from './LocalModelStatus.vue'
import AssistantProfileStatus from './AssistantProfileStatus.vue'
import AiIcon from './ai/AiIcon.vue'
import SystemStopButton from './SystemStopButton.vue'

type DisplayMode = 'mini' | 'tabs' | 'dashboard'
const props = withDefaults(
  defineProps<{
    projectName?: string
    active?: boolean
    assistantPhase?: OrbPhase
    nativeWindow?: boolean
    initialDisplayMode?: Exclude<DisplayMode, 'mini'>
    sidebarCollapsed?: boolean
  }>(),
  {
    projectName: '',
    active: true,
    assistantPhase: undefined,
    nativeWindow: false,
    initialDisplayMode: 'tabs',
    sidebarCollapsed: false,
  }
)
const emit = defineEmits<{ close: []; openMini: [] }>()
type SystemSection = 'resources' | 'localmodel' | 'memory' | 'network' | 'details'
type IndicatorState = 'ok' | 'active' | 'warning' | 'unknown'
type SystemIndicators = Record<Exclude<SystemSection, 'localmodel'>, IndicatorState>
const tabs: ReadonlyArray<{ id: SystemSection; label: string }> = [
  { id: 'resources', label: 'Ressourcen' },
  { id: 'localmodel', label: 'LocalModel' },
  { id: 'memory', label: 'Gedächtnis' },
  { id: 'network', label: 'Netzwerk' },
  { id: 'details', label: 'Details' },
]
const displayMode = ref<DisplayMode>(props.initialDisplayMode)
function applyDisplayMode(mode: DisplayMode) {
  displayMode.value = mode
  if (mode === 'mini') activeSection.value = 'resources'
  if (content.value) content.value.scrollTop = 0
}
async function setDisplayMode(mode: DisplayMode) {
  if (mode === 'mini') {
    applyDisplayMode(mode)
    return
  }
  if (props.nativeWindow) {
    applyDisplayMode(mode)
    try {
      await invoke('system_status_window_set_mode', { mode })
    } catch {
      // Browser previews keep the selected responsive view without a native bridge.
    }
    return
  }
  try {
    await invoke('system_status_window_open', { mode })
    emit('close')
  } catch {
    // Synthetic previews do not have a native window manager.
    applyDisplayMode(mode)
  }
}
watch(
  () => props.initialDisplayMode,
  mode => {
    if (props.nativeWindow) applyDisplayMode(mode)
  }
)
const activeSection = ref<SystemSection>('resources')
const indicators = ref<SystemIndicators>({
  resources: 'unknown',
  memory: 'unknown',
  network: 'unknown',
  details: 'unknown',
})
const panel = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const modelOpen = ref(false)
const profileOpen = ref(false)
let previousFocus: HTMLElement | null = null

function statusFor(section: SystemSection): IndicatorState {
  switch (section) {
    case 'localmodel': {
      const latest = localModelDiagnostics.state.runs[0]
      return !latest ? 'unknown' : latest.state === 'error' ? 'warning' : latest.endedAt === null ? 'active' : 'ok'
    }
    case 'resources':
      return indicators.value.resources
    case 'memory':
      return indicators.value.memory
    case 'network':
      return indicators.value.network
    case 'details':
      return indicators.value.details
  }
}
function statusLabel(status: IndicatorState): string {
  switch (status) {
    case 'ok':
      return 'Aktuell'
    case 'active':
      return 'Aktiv'
    case 'warning':
      return 'Hinweis'
    case 'unknown':
      return 'Status unbekannt'
  }
}
function statusIcon(status: IndicatorState): string {
  switch (status) {
    case 'ok':
      return 'm5 12 4 4L19 6'
    case 'active':
      return 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
    case 'warning':
      return 'M12 3 2 21h20ZM12 9v5m0 3v.1'
    case 'unknown':
      return 'M8 12h8M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0'
  }
}
async function selectSection(section: SystemSection, focus = false) {
  activeSection.value = section
  await nextTick()
  if (content.value) content.value.scrollTop = 0
  if (focus && props.active) panel.value?.querySelector<HTMLButtonElement>(`#system-tab-${section}`)?.focus()
}
function onTabKeydown(event: KeyboardEvent, section: SystemSection) {
  const index = tabs.findIndex(tab => tab.id === section)
  let nextIndex: number
  switch (event.key) {
    case 'ArrowRight':
      nextIndex = (index + 1) % tabs.length
      break
    case 'ArrowLeft':
      nextIndex = (index + tabs.length - 1) % tabs.length
      break
    case 'Home':
      nextIndex = 0
      break
    case 'End':
      nextIndex = tabs.length - 1
      break
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
  const next = tabs.at(nextIndex)
  if (next) void selectSection(next.id, true)
}
function restoreFocus() {
  if (panel.value?.contains(document.activeElement) || document.activeElement === document.body)
    previousFocus?.focus({ preventScroll: true })
}
watch(
  () => props.active,
  async active => {
    if (!active) {
      restoreFocus()
      return
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    if (props.active) panel.value?.focus({ preventScroll: true })
  },
  { immediate: true }
)
onBeforeUnmount(restoreFocus)
</script>

<template>
  <section
    v-show="active"
    id="system-panel"
    ref="panel"
    class="system-status-panel"
    :data-mode="displayMode"
    :data-native-window="nativeWindow"
    :data-sidebar-collapsed="sidebarCollapsed"
    role="dialog"
    aria-label="Systemstatus"
    tabindex="-1"
    @keydown.esc.stop="emit('close')"
  >
    <header class="system-status-panel__header">
      <div>
        <h2>Systemstatus</h2>
      </div>
      <div class="system-status-panel__actions">
        <SystemStopButton v-if="!nativeWindow" /><button
          type="button"
          class="panel-close"
          aria-label="Systembereich schließen"
          @click="emit('close')"
        >
          <AiIcon name="close" :size="18" />
        </button>
      </div>
    </header>
    <div class="system-view-switch" role="group" aria-label="Systemstatus-Anzeigemodus">
      <button v-if="!nativeWindow" type="button" :aria-pressed="displayMode === 'mini'" @click="setDisplayMode('mini')">
        Mini
      </button>
      <button type="button" :aria-pressed="displayMode === 'tabs'" @click="setDisplayMode('tabs')">Tabs</button>
      <button type="button" :aria-pressed="displayMode === 'dashboard'" @click="setDisplayMode('dashboard')">
        Vollbild
      </button>
    </div>
    <nav
      v-show="displayMode === 'tabs'"
      class="system-status-panel__tabs"
      role="tablist"
      aria-label="Systemstatus-Bereiche"
    >
      <button
        v-for="tab in tabs"
        :id="`system-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="activeSection === tab.id"
        :aria-controls="`system-tabpanel-${tab.id}`"
        :aria-label="`${tab.label}: ${statusLabel(statusFor(tab.id))}`"
        :title="`${tab.label}: ${statusLabel(statusFor(tab.id))}`"
        :tabindex="activeSection === tab.id ? 0 : -1"
        @click="selectSection(tab.id)"
        @keydown="onTabKeydown($event, tab.id)"
      >
        <svg
          class="section-indicator"
          :data-state="statusFor(tab.id)"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="tab.id === 'memory'">
            <path d="M7 3v16m-4-4 4 4 4-4"><title>Lesen</title></path>
            <path d="M17 21V5m-4 4 4-4 4 4"><title>Schreiben</title></path>
          </template>
          <path v-else :d="statusIcon(statusFor(tab.id))" />
        </svg>
        <span>{{ tab.label }}</span>
      </button>
    </nav>
    <div
      :id="`system-tabpanel-${activeSection}`"
      ref="content"
      class="system-status-panel__content"
      :role="displayMode === 'tabs' ? 'tabpanel' : 'region'"
      :aria-labelledby="displayMode === 'tabs' ? `system-tab-${activeSection}` : undefined"
      :aria-label="
        displayMode === 'dashboard'
          ? 'Systemstatus-Dashboard'
          : displayMode === 'mini'
            ? 'Kompakte Ressourcen'
            : undefined
      "
      tabindex="0"
    >
      <JarvisHud
        embedded
        :active="active"
        :section="displayMode === 'dashboard' ? 'all' : activeSection"
        :assistant-phase="assistantPhase"
        @indicators="indicators = $event"
      />
      <LocalModelAnalysis v-show="displayMode === 'dashboard' || activeSection === 'localmodel'" />
      <div
        v-show="displayMode === 'dashboard' || activeSection === 'localmodel' || activeSection === 'details'"
        class="system-status-panel__details"
      >
        <details
          v-show="displayMode === 'dashboard' || activeSection === 'localmodel'"
          :open="displayMode === 'dashboard'"
          @toggle="modelOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            <AiIcon name="grid" :size="15" /><span>Lokales Modell</span
            ><AiIcon class="disclosure-arrow" name="chevron" :size="13" />
          </summary>
          <LocalModelStatus
            :active="active && (displayMode === 'dashboard' || (activeSection === 'localmodel' && modelOpen))"
          />
        </details>
        <details
          v-show="displayMode === 'dashboard' || activeSection === 'details'"
          :open="displayMode === 'dashboard'"
          @toggle="profileOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            <AiIcon name="spark" :size="15" /><span>Persönlichkeit &amp; Skills</span
            ><AiIcon class="disclosure-arrow" name="chevron" :size="13" />
          </summary>
          <AssistantProfileStatus
            :active="active && (displayMode === 'dashboard' || (activeSection === 'details' && profileOpen))"
          />
        </details>
      </div>
    </div>
  </section>
</template>

<style scoped>
.system-status-panel {
  position: fixed;
  z-index: 35;
  top: 82px;
  right: 20px;
  width: min(780px, calc(100vw - 40px));
  min-width: min(300px, calc(100vw - 20px));
  max-width: calc(100vw - 40px);
  resize: horizontal;
  max-height: calc(100dvh - 102px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  color: var(--ai-ink);
  background: var(--ai-surface);
  border: 1px solid var(--ai-line-strong);
  border-radius: 14px;
  box-shadow: 0 20px 70px #0005;
  font: 12px/1.5 var(--ai-font);
  outline: none;
}
.system-status-panel__header {
  gap: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 46px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--ai-line);
  flex-shrink: 0;
}
.system-status-panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.system-status-panel h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.015em;
}
.system-status-panel button {
  font: inherit;
  cursor: pointer;
}
.panel-close {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 0;
  color: var(--ai-muted);
  background: transparent;
}
.panel-close:hover {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.system-status-panel :is(button, summary):focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 3px;
}
.system-status-panel__tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  flex-shrink: 0;
  padding: 0 16px;
  border-bottom: 1px solid var(--ai-line);
}
.system-status-panel__tabs button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-width: 0;
  padding: 14px 4px;
  border: 0;
  color: var(--ai-muted);
  background: transparent;
  font-size: 11px;
}
.system-status-panel__tabs button:hover,
.system-status-panel__tabs button[aria-selected='true'] {
  color: var(--ai-ink);
}
.system-status-panel__tabs button[aria-selected='true']::after {
  content: '';
  position: absolute;
  bottom: -1px;
  right: 12px;
  left: 12px;
  height: 2px;
  border-radius: 2px;
  background: var(--ai-accent);
}
.section-indicator {
  flex-shrink: 0;
  color: var(--ai-muted);
}
.section-indicator[data-state='ok'] {
  color: #77af94;
}
.section-indicator[data-state='active'] {
  color: #86aee1;
}
.section-indicator[data-state='warning'] {
  color: #d3ac70;
}
.system-status-panel__content {
  min-height: 0;
  padding: 8px 24px 12px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}
.system-status-panel__content:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: -3px;
}
.system-status-panel__details {
  margin-top: 12px;
}
.system-status-panel__details > details {
  border-top: 1px solid var(--ai-line);
}
.system-status-panel__details summary {
  list-style: none;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 0;
  cursor: pointer;
  color: var(--ai-muted);
}
.system-status-panel__details summary::-webkit-details-marker {
  display: none;
}
.system-status-panel__details summary > span {
  flex: 1;
}
.system-status-panel__details summary:hover {
  color: var(--ai-ink);
}
details[open] > summary .disclosure-arrow {
  transform: rotate(90deg);
}
.system-status-panel__details :deep(.local-model-status) {
  border: 0;
  padding-top: 0;
}
.system-status-panel__details :deep(.assistant-profile) {
  border: 0;
  border-radius: 0;
  padding: 0 0 16px;
}
@media (max-width: 480px) {
  .system-status-panel {
    top: 12px;
    right: 10px;
    width: calc(100vw - 20px);
    max-height: calc(100dvh - 24px);
  }
  .system-status-panel__header {
    padding: 16px;
  }
  .system-status-panel__content {
    padding: 8px 16px 0;
    scrollbar-gutter: auto;
  }
  .system-status-panel__tabs {
    padding: 0 8px;
  }
  .system-status-panel__tabs button {
    flex-direction: column;
    gap: 5px;
    padding: 11px 2px;
    font-size: 10px;
  }
}
</style>

<style scoped>
.system-view-switch {
  display: flex;
  gap: 4px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--ai-line);
  flex-shrink: 0;
}
.system-view-switch button {
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ai-muted);
  padding: 4px 8px;
  font: inherit;
}
.system-view-switch button[aria-pressed='true'] {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.system-status-panel[data-mode='mini'] {
  --system-sidebar-width: 232px;
  top: 82px;
  right: auto;
  bottom: 14px;
  left: calc(var(--system-sidebar-width) + 12px);
  width: 204px;
  min-width: 0;
  max-width: calc(100vw - var(--system-sidebar-width) - 24px);
  max-height: none;
  resize: none;
  border-radius: 10px;
}
.system-status-panel[data-mode='mini'][data-sidebar-collapsed='true'] {
  --system-sidebar-width: 62px;
}
.system-status-panel[data-mode='mini'] :deep(.resource-grid) {
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
.system-status-panel[data-mode='dashboard'] {
  inset: 0;
  width: 100vw;
  max-width: 100vw;
  height: 100dvh;
  max-height: 100dvh;
  border-radius: 0;
  resize: none;
}
[data-mode='dashboard'] .system-status-panel__content {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  gap: 20px 32px;
  align-content: start;
  padding: 20px 28px;
}
[data-mode='dashboard'] :deep(.status-dashboard),
[data-mode='dashboard'] :deep(.status-dashboard__body) {
  display: contents;
}
[data-mode='dashboard'] :deep(.resource-pane),
[data-mode='dashboard'] :deep(.activity-charts) {
  grid-column: 1 / -1;
}
[data-mode='dashboard'] :deep(.resource-grid) {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
[data-mode='dashboard'] :deep(.resource-dial-wrap) {
  max-width: 180px;
}
[data-mode='dashboard'] :deep(.status-overview) {
  grid-column: 1 / -1;
  min-height: 0;
}
[data-mode='dashboard'] :deep(.model-analysis) {
  grid-column: 1;
}
[data-mode='dashboard'] .system-status-panel__details {
  grid-column: 2;
}
@media (max-width: 700px) {
  [data-mode='dashboard'] .system-status-panel__content {
    grid-template-columns: minmax(0, 1fr);
    padding: 16px;
  }
  [data-mode='dashboard'] .system-status-panel__details {
    grid-column: 1;
  }
  [data-mode='dashboard'] :deep(.resource-grid) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

<style scoped>
[data-mode='mini'] :deep(.resource-dial-wrap) {
  max-width: 164px;
}
[data-mode='mini'] .system-status-panel__header {
  min-height: 38px;
  padding: 5px 9px;
}
[data-mode='mini'] .system-status-panel__content {
  padding: 7px 9px;
}
[data-mode='mini'] :deep(.resource-heading) {
  padding: 0 0 8px;
}
[data-mode='mini'] :deep(.resource-heading > span),
[data-mode='mini'] :deep(.resource-context),
[data-mode='mini'] :deep(.resource-explanation) {
  display: none;
}
[data-mode='mini'] :deep(.resource-storage-note) {
  padding-left: 5px;
}
[data-mode='dashboard'] :deep(.resource-pane) {
  grid-column: 1;
  grid-row: 2;
}
[data-mode='dashboard'] :deep(.resource-grid) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
[data-mode='dashboard'] :deep(.resource-dial-wrap) {
  max-width: 132px;
}
[data-mode='dashboard'] :deep(.activity-charts) {
  grid-column: 2;
  grid-row: 2;
}
[data-mode='dashboard'] :deep(.activity-charts__grid) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
[data-mode='dashboard'] :deep(.resource-note) {
  display: none;
}
[data-mode='dashboard'] :deep(.resource-heading) {
  padding-bottom: 10px;
}
[data-mode='dashboard'] :deep(.resource-explanation) {
  margin-bottom: 0;
}
[data-mode='dashboard'] :deep(.model-analysis) {
  grid-row: 3 / span 2;
}
[data-mode='dashboard'] :deep(.system-details-overview) {
  grid-column: 2;
  grid-row: 3;
}
[data-mode='dashboard'] .system-status-panel__details {
  grid-row: 4;
}
@media (min-width: 1600px) {
  [data-mode='dashboard'] .system-status-panel__content {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  }
  [data-mode='dashboard'] :deep(.model-analysis) {
    grid-column: 3;
    grid-row: 2 / span 3;
  }
  [data-mode='dashboard'] .system-status-panel__details {
    grid-column: 1;
    grid-row: 3;
  }
}
@media (max-width: 700px) {
  [data-mode='dashboard'] :deep(.resource-pane),
  [data-mode='dashboard'] :deep(.activity-charts),
  [data-mode='dashboard'] :deep(.model-analysis),
  [data-mode='dashboard'] :deep(.system-details-overview),
  [data-mode='dashboard'] .system-status-panel__details {
    grid-column: 1;
    grid-row: auto;
  }
  [data-mode='dashboard'] :deep(.activity-charts__grid) {
    grid-template-columns: 1fr;
  }
}
.system-status-panel[data-native-window='true'] {
  position: relative;
  inset: auto;
  width: 100%;
  max-width: none;
  min-width: 0;
  height: 100dvh;
  max-height: 100dvh;
  resize: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.system-status-panel[data-native-window='true'] .system-status-panel__content {
  padding-bottom: 20px;
}
@media (max-width: 900px) {
  .system-status-panel[data-mode='mini'] {
    --system-sidebar-width: 190px;
  }
  .system-status-panel[data-mode='mini'][data-sidebar-collapsed='true'] {
    --system-sidebar-width: 62px;
  }
}
@media (max-width: 700px) {
  .system-status-panel[data-mode='mini'] {
    --system-sidebar-width: 54px;
    left: calc(var(--system-sidebar-width) + 8px);
    width: min(192px, calc(100vw - var(--system-sidebar-width) - 16px));
  }
}
</style>
