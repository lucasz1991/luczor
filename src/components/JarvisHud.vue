<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { hud, type ConnState } from '@/state/hud'
import type { OrbPhase } from '@/services/miniChat/presentation'
import { lastScreenshot } from '@/services/tools/registry'
import { syncNow } from '@/services/status'
import { appearance } from '@/services/appearance'
import { createSystemStatusMonitor } from '@/services/systemStatusMonitor'
import type { SystemStatusIndicator as Indicator } from '@/features/system-status/model'
import { useSystemResourceModel, type ResourceView } from '@/features/system-status/resourceModel'
import SystemMiniModelUsage from '@/features/system-status/components/SystemMiniModelUsage.vue'
import SystemResourceMeter from '@/features/system-status/components/SystemResourceMeter.vue'
import AiIcon from './ai/AiIcon.vue'
import SystemStopButton from './SystemStopButton.vue'
import SystemActivityCharts from './SystemActivityCharts.vue'

const props = withDefaults(
  defineProps<{
    embedded?: boolean
    active?: boolean
    assistantPhase?: OrbPhase
    section?: 'all' | 'resources' | 'localmodel' | 'memory' | 'network' | 'details'
    compact?: boolean
  }>(),
  {
    embedded: false,
    active: true,
    assistantPhase: undefined,
    section: 'resources',
    compact: false,
  }
)
const emit = defineEmits<{
  indicators: [value: { resources: Indicator; memory: Indicator; network: Indicator; details: Indicator }]
}>()
const flowIndicators = ref<{ memory: Indicator; network: Indicator }>({ memory: 'unknown', network: 'unknown' })
const resourceView = ref<ResourceView>('circles')
const collapsed = ref(false)
const monitor = createSystemStatusMonitor()
const metrics = monitor.state
const { compactModelUsage, gpuProcessUnavailable, hardware, modelStatus } = useSystemResourceModel(metrics)
watchEffect(() =>
  emit('indicators', {
    resources: metrics.availability === 'live' ? 'ok' : metrics.availability === 'stale' ? 'warning' : 'unknown',
    memory: flowIndicators.value.memory,
    network:
      flowIndicators.value.network === 'active'
        ? 'active'
        : hud.sync.server === 'offline'
          ? 'warning'
          : flowIndicators.value.network,
    details: hud.killSwitch ? 'warning' : metrics.sample?.model_running === true ? 'ok' : 'unknown',
  })
)
watch(
  () => props.active && !collapsed.value,
  active => monitor.setActive(active),
  { immediate: true }
)
onBeforeUnmount(() => monitor.dispose())
const phase = computed(() => {
  if (hud.killSwitch) return { label: 'Tools gesperrt', detail: 'Not-Aus ist aktiv.', tone: 'danger', moving: false }
  switch (props.assistantPhase ?? hud.status) {
    case 'waiting':
      return {
        label: 'Deine Entscheidung',
        detail: 'Eine Freigabe oder Auswahl wartet im Chat.',
        tone: 'warning',
        moving: false,
      }
    case 'stopped':
      return { label: 'Angehalten', detail: 'Die aktuelle Arbeit wurde gestoppt.', tone: 'neutral', moving: false }
    case 'done':
      return { label: 'Antwort bereit', detail: 'Eine neue Antwort steht im Chat.', tone: 'success', moving: false }
    case 'listening':
      return { label: 'Hört zu', detail: 'Spracheingabe ist aktiv.', tone: 'accent', moving: true }
    case 'thinking':
      return { label: 'Verarbeitet', detail: 'Luczor bereitet die Antwort vor.', tone: 'accent', moving: true }
    case 'executing':
      return { label: 'Arbeitet', detail: 'Eine Aktion wird ausgeführt.', tone: 'accent', moving: true }
    case 'speaking':
      return { label: 'Spricht', detail: 'Die Antwort wird vorgelesen.', tone: 'success', moving: true }
    case 'error':
      return {
        label: 'Fehler gemeldet',
        detail: 'Weitere Informationen stehen im Chat.',
        tone: 'danger',
        moving: false,
      }
    default:
      return { label: 'Bereit', detail: 'Im Moment keine aktive Unterhaltung.', tone: 'neutral', moving: false }
  }
})
const stamp = computed(() =>
  metrics.lastUpdatedAt
    ? new Date(metrics.lastUpdatedAt).toLocaleTimeString('de-DE', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : ''
)
const freshness = computed(() => {
  switch (metrics.availability) {
    case 'live':
      return `Stand ${stamp.value}`
    case 'stale':
      return `Veraltet · letzter Stand ${stamp.value}`
    case 'unavailable':
      return 'Gerätemessung nicht verfügbar'
    default:
      return 'Messwerte werden gelesen …'
  }
})
const connectionLabels: Record<ConnState, string> = {
  online: 'Verbunden',
  offline: 'Nicht erreichbar',
  configured: 'Eingerichtet',
  disabled: 'Deaktiviert',
  unknown: 'Unbekannt',
}
const connections = computed(() => [
  { label: 'Server', state: hud.sync.server },
  { label: 'Gedächtnis', state: hud.sync.cognee },
])
const syncing = ref(false)
const syncMessage = ref('')
async function doSync() {
  if (syncing.value || hud.sync.server !== 'online') return
  syncing.value = true
  syncMessage.value = ''
  try {
    await syncNow()
    syncMessage.value = 'Synchronisierung abgeschlossen.'
  } catch {
    syncMessage.value = 'Synchronisierung fehlgeschlagen. Bitte erneut versuchen.'
  } finally {
    syncing.value = false
  }
}
const position = computed(() =>
  props.embedded
    ? {}
    : {
        top: appearance.hudPosition.startsWith('t') ? '16px' : 'auto',
        bottom: appearance.hudPosition.startsWith('b') ? '16px' : 'auto',
        left: appearance.hudPosition.endsWith('l') ? '16px' : 'auto',
        right: appearance.hudPosition.endsWith('r') ? '16px' : 'auto',
      }
)
</script>

<template>
  <section
    class="status-dashboard"
    :class="{ embedded, 'reduce-motion': appearance.reduceMotion, 'is-compact': compact }"
    :style="position"
    aria-label="Gerät und Verbindungen"
  >
    <button
      v-if="!embedded"
      type="button"
      class="status-toggle"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <AiIcon name="spark" /> Systemstatus <AiIcon :name="collapsed ? 'plus' : 'close'" />
    </button>
    <div v-if="!collapsed" class="status-dashboard__body">
      <div v-show="section === 'all' || section === 'localmodel'" class="status-overview" :data-tone="phase.tone">
        <div class="status-overview__text">
          <h3 role="status"><i class="phase-dot" />{{ phase.label }}</h3>
          <p>{{ phase.detail }}</p>
          <div
            v-if="hud.status === 'listening' && !hud.killSwitch"
            class="microphone-level"
            aria-label="Mikrofonpegel"
            role="meter"
            :aria-valuenow="Math.round(hud.micLevel * 100)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <AiIcon name="mic" :size="13" /><span><i :style="{ width: `${hud.micLevel * 100}%` }" /></span>
          </div>
        </div>
      </div>
      <div v-show="section === 'all' || section === 'resources'" class="resource-pane">
        <div v-if="!compact" class="resource-heading">
          <div class="resource-mode" role="group" aria-label="Ressourcendarstellung">
            <button type="button" :aria-pressed="resourceView === 'circles'" @click="resourceView = 'circles'">
              Kreise</button
            ><button type="button" :aria-pressed="resourceView === 'history'" @click="resourceView = 'history'">
              Verlauf
            </button>
          </div>
          <span :data-stale="metrics.availability === 'stale'">{{ freshness }}</span>
        </div>
        <div class="resource-grid" :class="{ 'is-stale': metrics.availability === 'stale' }">
          <SystemResourceMeter
            v-for="meter in hardware"
            :key="meter.key"
            :meter="meter"
            :view="resourceView"
            :compact="compact"
            :stale="metrics.availability === 'stale'"
          />
        </div>
        <p v-if="resourceView === 'history'" class="resource-note">
          {{
            metrics.history.length > 1
              ? 'Letzte Messungen · ca. 3,5 s Abstand · Skala 0–100 %'
              : 'Der Verlauf entsteht aus den Messungen während dieser Ansicht.'
          }}
        </p>
        <SystemMiniModelUsage
          v-if="compact"
          :metrics="compactModelUsage"
          :model-status="modelStatus"
          :running="metrics.sample?.model_running === true"
        />
        <div class="resource-context">
          <span v-if="gpuProcessUnavailable">GPU-Prozessmessung teilweise nicht verfügbar.</span>
        </div>
        <details class="resource-explanation">
          <summary>Zuordnung der Werte</summary>
          <p>
            Rechner umfasst alle Anwendungen. App zeigt Luczor und seine Unterprozesse ohne den verwalteten
            Modellprozess. Modell zeigt den zugehörigen lokalen Prozess und seine Unterprozesse. RAM-Werte enthalten
            gemeinsam genutzte Speicherseiten und sind nicht addierbar.
          </p>
          <p>
            GPU zeigt pro Bereich die höchste Windows-GPU-Engine-Auslastung. Fehlt diese Messung, kann für den Rechner
            die höchste Geräteauslastung einer NVIDIA-Karte angezeigt werden. Die Kurven werden nicht addiert. Ein
            Strich bedeutet nicht verfügbar oder nicht aktiv. CPU und GPU ergänzen die drei Auslastungsringe um die
            gemeldete Temperatur; ab 75 °C wird sie amber, ab 85 °C rot. Jedes Volume gehört zur Luczor-App oder zum
            konfigurierten Modellordner. Die drei Aktivitätsringe und die Belegung sind Volume-Werte, keine
            Prozessanteile.
          </p>
        </details>
      </div>
      <p v-show="section === 'all' || section === 'localmodel'" class="resource-note">{{ modelStatus }}</p>
      <SystemActivityCharts
        v-show="section === 'all' || section === 'memory' || section === 'network'"
        :view="section === 'all' ? 'all' : section === 'memory' ? 'memory' : 'network'"
        :active="active && !collapsed"
        :native-network="metrics.sample?.network_local"
        :native-live="metrics.availability === 'live'"
        @indicators="flowIndicators = $event"
      />
      <div v-show="section === 'all' || section === 'details'" class="system-details-overview">
        <div class="connection-grid">
          <div v-for="connection in connections" :key="connection.label" class="connection">
            <span>{{ connection.label }}</span
            ><strong
              ><i class="connection-dot" :data-state="connection.state" />{{
                connectionLabels[connection.state]
              }}</strong
            >
          </div>
        </div>
        <div class="sync-line">
          <span>{{ hud.sync.pending }} zur Synchronisierung ausstehend</span
          ><button
            type="button"
            class="quiet-button"
            :disabled="syncing || hud.sync.server !== 'online'"
            @click="doSync"
          >
            {{ syncing ? 'Synchronisiert …' : 'Synchronisieren' }}
          </button>
        </div>
        <p v-if="syncMessage" class="sync-result" role="status">{{ syncMessage }}</p>
        <div class="status-controls">
          <div class="last-tool">
            <span class="status-caption">Letztes Tool</span
            ><span :title="hud.lastTool || undefined">{{ hud.lastTool || 'Noch kein Tool ausgeführt' }}</span>
          </div>
          <SystemStopButton v-if="!embedded" />
        </div>
        <details v-if="lastScreenshot" class="last-capture">
          <summary>Letzte Bildschirmaufnahme</summary>
          <img :src="lastScreenshot" alt="Zuletzt vom Bildschirm-Tool aufgenommener Bildschirm" />
        </details>
        <slot name="details" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.status-dashboard {
  --status-color: var(--ai-muted);
  position: fixed;
  z-index: 50;
  width: min(680px, calc(100vw - 32px));
  color: var(--ai-ink);
  font: 12px/1.5 var(--ai-font);
}
.status-dashboard.embedded {
  position: relative;
  width: 100%;
  z-index: auto;
}
.status-dashboard__body {
  padding: 20px;
  border: 1px solid var(--ai-line);
  border-radius: 14px;
  background: var(--ai-surface);
}
.embedded .status-dashboard__body {
  padding: 0;
  border: 0;
  background: transparent;
}
.status-dashboard :is(button, summary):focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 3px;
}
.status-dashboard button {
  font: inherit;
  cursor: pointer;
}
.status-dashboard button:disabled {
  opacity: 0.5;
  cursor: default;
}
.status-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 12px;
  color: var(--ai-ink);
  background: var(--ai-surface);
  border: 1px solid var(--ai-line);
  border-radius: 8px;
}
.status-overview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 72px;
  padding-bottom: 8px;
}
[data-tone='accent'] {
  --status-color: var(--ai-accent);
}
[data-tone='success'] {
  --status-color: var(--ai-green);
}
[data-tone='danger'] {
  --status-color: var(--ai-red);
}
[data-tone='warning'] {
  --status-color: var(--ai-orange);
}
.status-overview__text {
  min-width: 0;
}
.status-caption {
  color: var(--ai-muted);
  font-size: 11px;
}
.status-overview h3 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 7px 0;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: -0.04em;
  line-height: 1.2;
}
.status-overview p {
  margin: 0;
  color: var(--ai-muted);
  font-size: 11px;
}
.phase-dot,
.connection-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--status-color);
}
.microphone-level {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: var(--ai-muted);
}
.microphone-level > span {
  width: 80px;
  height: 3px;
  background: var(--ai-line);
}
.microphone-level i {
  display: block;
  height: 100%;
  background: var(--ai-accent);
}
.status-map {
  width: 166px;
  height: 120px;
  flex-shrink: 0;
  overflow: visible;
}
.map-guide {
  stroke: var(--ai-line-strong);
  stroke-dasharray: 2 4;
}
.map-layer {
  stroke: var(--ai-line-strong);
  fill: var(--ai-canvas);
}
.map-layer--back {
  opacity: 0.45;
}
.map-layer--middle {
  opacity: 0.75;
}
.map-layer--front {
  stroke: var(--status-color);
}
.map-spark {
  stroke: var(--status-color);
  stroke-linejoin: round;
}
.map-node {
  fill: var(--ai-faint);
}
.map-node[data-state='online'] {
  fill: var(--ai-green);
}
.map-node[data-state='offline'] {
  fill: var(--ai-red);
}
.map-node[data-state='configured'] {
  fill: var(--ai-accent);
}
.is-working .map-layer--front,
.is-working .map-spark {
  animation: status-lift 3s ease-in-out infinite;
}
.resource-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0 22px;
}
.resource-mode {
  display: flex;
  padding: 3px;
  border-radius: 7px;
  background: var(--ai-canvas);
}
.resource-mode button {
  border: 0;
  border-radius: 5px;
  padding: 5px 10px;
  background: transparent;
  color: var(--ai-muted);
  font-size: 11px;
}
.resource-mode button[aria-pressed='true'] {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.resource-heading h4 {
  font-size: 12px;
  font-weight: 500;
  margin: 0;
}
.resource-heading > span,
.resource-note {
  color: var(--ai-muted);
  font-size: 10px;
}
.resource-heading [data-stale='true'] {
  color: var(--ai-orange);
}
.resource-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
  gap: 18px;
}
.resource-note {
  margin: 12px 0 8px;
}
.resource-context {
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--ai-muted);
  font-size: 10px;
}
.resource-explanation {
  color: var(--ai-muted);
  font-size: 10px;
  margin: 8px 0 18px;
}
.resource-explanation summary {
  cursor: pointer;
}
.resource-explanation p {
  line-height: 1.6;
  margin: 8px 0;
}
.status-dashboard.is-compact .resource-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 5px;
}
.connection-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  padding-top: 17px;
  border-top: 1px solid var(--ai-line);
}
.connection {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.connection > span {
  color: var(--ai-muted);
}
.connection strong {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 400;
  font-size: 11px;
}
.connection-dot {
  background: var(--ai-faint);
}
.connection-dot[data-state='online'] {
  background: var(--ai-green);
}
.connection-dot[data-state='offline'] {
  background: var(--ai-red);
}
.connection-dot[data-state='configured'] {
  background: var(--ai-accent);
}
.sync-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  color: var(--ai-muted);
  font-size: 11px;
}
.quiet-button {
  border: 1px solid var(--ai-line);
  background: transparent;
  color: var(--ai-ink);
  padding: 6px 10px;
  border-radius: 6px;
  white-space: nowrap;
}
.quiet-button:hover:not(:disabled) {
  background: var(--ai-hover);
}
.sync-result {
  margin: 0 0 12px;
  font-size: 11px;
}
.status-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--ai-line);
  padding: 16px 0 8px;
}
.last-tool {
  display: grid;
  gap: 3px;
  min-width: 0;
  font-size: 11px;
}
.last-tool > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.last-capture {
  border-top: 1px solid var(--ai-line);
  margin-top: 12px;
  padding-top: 12px;
  color: var(--ai-muted);
}
.last-capture summary {
  cursor: pointer;
}
.last-capture img {
  display: block;
  width: 100%;
  border-radius: 6px;
  margin-top: 10px;
}
@keyframes status-lift {
  50% {
    transform: translateY(-4px);
  }
}
.reduce-motion *,
:global([data-reduce-motion='1']) .status-map * {
  animation: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .status-map * {
    animation: none !important;
  }
}
@media (max-width: 480px) {
  .status-overview {
    min-height: 65px;
    gap: 4px;
  }
  .status-overview h3 {
    font-size: 15px;
  }
  .status-overview p {
    font-size: 11px;
  }
  .status-map {
    width: 98px;
    height: 96px;
  }
  .resource-heading {
    gap: 5px;
  }
  .connection-grid {
    gap: 12px;
  }
  .sync-line {
    align-items: flex-start;
  }
}
</style>
