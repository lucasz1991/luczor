<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { OrbPhase } from '@/services/miniChat/presentation'
import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'
import LocalModelAnalysis from './LocalModelAnalysis.vue'
import JarvisHud from './JarvisHud.vue'
import LocalModelStatus from './LocalModelStatus.vue'
import AssistantProfileStatus from './AssistantProfileStatus.vue'
import AiIcon from './ai/AiIcon.vue'
import SystemStopButton from './SystemStopButton.vue'

const props = withDefaults(defineProps<{ projectName?: string; active?: boolean; assistantPhase?: OrbPhase }>(), {
  projectName: '',
  active: true,
  assistantPhase: undefined,
})
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
        <SystemStopButton /><button
          type="button"
          class="panel-close"
          aria-label="Systembereich schließen"
          @click="emit('close')"
        >
          <AiIcon name="close" :size="18" />
        </button>
      </div>
    </header>
    <nav class="system-status-panel__tabs" role="tablist" aria-label="Systemstatus-Bereiche">
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
      role="tabpanel"
      :aria-labelledby="`system-tab-${activeSection}`"
      tabindex="0"
    >
      <JarvisHud
        embedded
        :active="active"
        :section="activeSection"
        :assistant-phase="assistantPhase"
        @indicators="indicators = $event"
      />
      <LocalModelAnalysis v-show="activeSection === 'localmodel'" />
      <div v-show="activeSection === 'localmodel' || activeSection === 'details'" class="system-status-panel__details">
        <details
          v-show="activeSection === 'localmodel'"
          @toggle="modelOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            <AiIcon name="grid" :size="15" /><span>Lokales Modell</span
            ><AiIcon class="disclosure-arrow" name="chevron" :size="13" />
          </summary>
          <LocalModelStatus :active="active && activeSection === 'localmodel' && modelOpen" />
        </details>
        <details
          v-show="activeSection === 'details'"
          @toggle="profileOpen = ($event.target as HTMLDetailsElement).open"
        >
          <summary>
            <AiIcon name="spark" :size="15" /><span>Persönlichkeit &amp; Skills</span
            ><AiIcon class="disclosure-arrow" name="chevron" :size="13" />
          </summary>
          <AssistantProfileStatus :active="active && activeSection === 'details' && profileOpen" />
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
  padding: 20px 24px 16px;
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
  font-size: 17px;
  font-weight: 500;
  letter-spacing: -0.025em;
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
