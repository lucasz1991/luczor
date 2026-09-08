<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { OrbPhase } from '@/services/miniChat/presentation'
import JarvisHud from './JarvisHud.vue'
import LocalModelStatus from './LocalModelStatus.vue'
import AssistantProfileStatus from './AssistantProfileStatus.vue'
import AiIcon from './ai/AiIcon.vue'
import SystemStopButton from './SystemStopButton.vue'

const props = withDefaults(defineProps<{ projectName?: string; active?: boolean; assistantPhase?: OrbPhase }>(), {
  active: true,
})
const emit = defineEmits<{ close: []; openMini: [] }>()
const panel = ref<HTMLElement | null>(null)
const modelOpen = ref(false)
const profileOpen = ref(false)
let previousFocus: HTMLElement | null = null
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
        <span>Dein Workspace</span>
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
    <div class="system-status-panel__content">
      <JarvisHud embedded :active="active" :assistant-phase="assistantPhase" />
      <div class="system-status-panel__details">
        <details @toggle="modelOpen = ($event.target as HTMLDetailsElement).open">
          <summary>
            <AiIcon name="grid" :size="15" /><span>Lokales Modell</span
            ><AiIcon class="disclosure-arrow" name="chevron" :size="13" />
          </summary>
          <LocalModelStatus :active="active && modelOpen" />
        </details>
        <details @toggle="profileOpen = ($event.target as HTMLDetailsElement).open">
          <summary>
            <AiIcon name="spark" :size="15" /><span>Persönlichkeit &amp; Skills</span
            ><AiIcon class="disclosure-arrow" name="chevron" :size="13" />
          </summary>
          <AssistantProfileStatus :active="active && profileOpen" />
        </details>
      </div>
    </div>
    <footer class="system-status-panel__footer">
      <span :title="projectName">{{ projectName || 'Luczor' }}</span
      ><button type="button" @click="emit('openMini')">
        <AiIcon name="panel" :size="14" />Luczor Mini öffnen<AiIcon name="arrow" :size="14" />
      </button>
    </footer>
  </section>
</template>

<style scoped>
.system-status-panel {
  position: fixed;
  z-index: 35;
  top: 82px;
  right: 20px;
  width: min(700px, calc(100vw - 40px));
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
.system-status-panel__header > div > span {
  color: var(--ai-muted);
  font-size: 10px;
}
.system-status-panel h2 {
  margin: 3px 0 0;
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
.system-status-panel__content {
  padding: 8px 24px 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
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
.system-status-panel__footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  border-top: 1px solid var(--ai-line);
  flex-shrink: 0;
}
.system-status-panel__footer > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ai-muted);
  font-size: 11px;
}
.system-status-panel__footer button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  padding: 5px 0;
  color: var(--ai-ink);
  background: transparent;
  border: 0;
  font-size: 11px;
}
.system-status-panel__footer button:hover {
  color: var(--ai-accent);
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
  .system-status-panel__footer {
    padding: 12px 16px;
  }
}
</style>
