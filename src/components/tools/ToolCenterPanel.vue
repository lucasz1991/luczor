<script setup lang="ts">
import { computed } from 'vue'
import type { LuczorMode } from '@/services/inference/types'
import { listTools } from '@/services/tools/registry'
import {
  clearToolSessions,
  listToolSessions,
  stopToolSession,
  toolSessionRevision,
} from '@/services/tools/toolSessionCoordinator'
import ToolApprovalDrawer from './ToolApprovalDrawer.vue'
import ToolArtifactPicker from './ToolArtifactPicker.vue'
import ToolCapabilityCard from './ToolCapabilityCard.vue'
import ToolRunInspector from './ToolRunInspector.vue'
import ModelControlPanel from './ModelControlPanel.vue'
import { listSavedToolArtifacts, saveToolArtifact } from '@/services/tools/toolArtifacts'

const props = withDefaults(
  defineProps<{ open: boolean; projectId: string; mode?: LuczorMode; killSwitch?: boolean }>(),
  { mode: 'observe', killSwitch: false }
)
const emit = defineEmits<{ (event: 'update:open', value: boolean): void }>()
const tools = computed(() => listTools().filter(tool => !!tool.capabilityKey))
const sessions = computed(() => {
  void toolSessionRevision.value
  return listToolSessions().filter(session => session.projectId === props.projectId)
})
const groups = computed(() => [...new Set(tools.value.map(tool => tool.capabilityKey?.split('.')[0] ?? 'tool'))])
const savedArtifacts = computed(() => listSavedToolArtifacts(props.projectId))
function stop(id: string) {
  stopToolSession(id)
}
async function saveArtifact() {
  await saveToolArtifact(props.projectId, {
    label: 'Tool-Center-Ergebnis',
    sourceSessionIds: sessions.value.map(session => session.id),
  })
}
function close() {
  emit('update:open', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="tool-center-backdrop" @click.self="close">
      <section class="tool-center-panel" role="dialog" aria-modal="true" aria-labelledby="tool-center-title">
        <header class="tool-center-header">
          <div>
            <span class="tool-center-kicker">LUCZOR / TOOLS</span>
            <h2 id="tool-center-title">Tool-Center</h2>
            <p>Browser, DOM, Vision, Modelle und Projekt-Terminal</p>
          </div>
          <button type="button" class="tool-center-close" aria-label="Tool-Center schließen" @click="close">×</button>
        </header>
        <ToolApprovalDrawer :mode="mode" :kill-switch="killSwitch" />
        <div class="tool-center-body">
          <ToolRunInspector :sessions="sessions" @stop="stop" />
          <ModelControlPanel />
          <ToolArtifactPicker :ephemeral="true" :saved-count="savedArtifacts.length" @save="saveArtifact" />
          <section class="tool-capabilities" aria-labelledby="tool-capabilities-title">
            <div class="tool-section-heading">
              <span id="tool-capabilities-title">Werkzeugkatalog</span
              ><small>{{ tools.length }} Fähigkeiten · {{ groups.length }} Gruppen</small>
            </div>
            <div class="tool-capabilities-grid">
              <ToolCapabilityCard
                v-for="tool in tools"
                :key="tool.name"
                :tool="tool"
                :mode="mode"
                :kill-switch="killSwitch"
              />
            </div>
          </section>
        </div>
        <footer class="tool-center-footer">
          <span>Temporäre Resultate werden nicht synchronisiert.</span
          ><button type="button" @click="clearToolSessions">Alle Sitzungen stoppen</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.tool-center-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(4, 6, 12, 0.64);
  backdrop-filter: blur(8px);
}
.tool-center-panel {
  display: flex;
  flex-direction: column;
  width: min(980px, calc(100vw - 32px));
  max-height: min(820px, calc(100vh - 32px));
  overflow: hidden;
  border: 1px solid var(--border-color, #384154);
  border-radius: 18px;
  background: var(--surface-1, #171a22);
  color: var(--text-primary, #eef2ff);
  box-shadow: 0 28px 100px #0009;
}
.tool-center-header {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 26px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.tool-center-kicker {
  font: 10px var(--font-mono, monospace);
  letter-spacing: 0.16em;
  color: var(--ai-accent, #a78bfa);
}
.tool-center-header h2 {
  margin: 5px 0 4px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.04em;
}
.tool-center-header p {
  margin: 0;
  color: var(--text-muted, #9aa5bb);
  font-size: 12px;
}
.tool-center-close {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-color, #384154);
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font-size: 21px;
  cursor: pointer;
}
.tool-center-body {
  overflow: auto;
  padding: 16px 20px 20px;
  display: grid;
  gap: 14px;
}
.tool-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: var(--text-muted, #aeb7ca);
  font: 11px var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.tool-section-heading span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.tool-section-heading small {
  font-size: 9px;
  color: var(--text-faint, #6f788d);
}
.tool-approval-drawer,
.tool-artifact-picker {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 11px;
  color: var(--text-muted, #aeb7ca);
}
.tool-approval-drawer span {
  color: var(--text-faint, #788298);
}
.tool-artifact-picker {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
}
.tool-artifact-picker small {
  margin-left: auto;
  color: var(--text-faint, #788298);
  font: 9px var(--font-mono, monospace);
}
.tool-artifact-picker button,
.tool-center-footer button,
.tool-stop {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 7px;
  padding: 5px 8px;
  background: transparent;
  color: inherit;
  font-size: 10px;
  cursor: pointer;
}
.tool-run-inspector,
.model-control-panel,
.tool-capabilities {
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.018);
}
.tool-run-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.tool-run-row div {
  display: grid;
  gap: 2px;
}
.tool-run-row small,
.tool-empty {
  font-size: 10px;
  color: var(--text-faint, #788298);
}
.tool-empty {
  margin: 0;
}
.tool-stop {
  color: #fca5a5;
}
.model-control-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
}
.model-control-grid label {
  display: grid;
  gap: 5px;
  font-size: 10px;
  color: var(--text-muted, #aeb7ca);
}
.model-control-grid input,
.model-control-grid select {
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  padding: 7px;
  background: rgba(0, 0, 0, 0.14);
  color: inherit;
  font: 11px var(--font-mono, monospace);
}
.model-control-wide {
  grid-column: span 2;
}
.tool-capabilities-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.tool-capability-card {
  display: flex;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.018);
}
.tool-capability-card__icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 8px;
  background: rgba(167, 139, 250, 0.12);
  color: var(--ai-accent, #a78bfa);
}
.tool-capability-card__body {
  min-width: 0;
}
.tool-capability-card__top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.tool-capability-card__top strong {
  font-size: 11px;
  font-weight: 600;
}
.tool-capability-card__top span {
  font-size: 9px;
  color: var(--text-faint, #788298);
  white-space: nowrap;
}
.tool-capability-card small {
  display: block;
  margin-top: 3px;
  color: var(--text-faint, #788298);
  font: 9px var(--font-mono, monospace);
}
.tool-capability-card p {
  margin: 6px 0 0;
  color: var(--text-muted, #aeb7ca);
  font-size: 10px;
  line-height: 1.45;
}
.tool-capability-card[data-access='stopped'] {
  opacity: 0.55;
}
.tool-center-footer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--text-faint, #788298);
  font-size: 10px;
}
@media (max-width: 700px) {
  .tool-center-backdrop {
    padding: 8px;
  }
  .tool-center-panel {
    width: 100%;
    max-height: calc(100vh - 16px);
  }
  .tool-capabilities-grid {
    grid-template-columns: 1fr;
  }
  .model-control-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .model-control-wide {
    grid-column: span 2;
  }
  .tool-center-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
