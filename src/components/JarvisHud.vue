<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { hud, type ConnState } from '@/state/hud'
import type { OrbPhase } from '@/services/miniChat/presentation'
import { lastScreenshot } from '@/services/tools/registry'
import { syncNow } from '@/services/status'
import { appearance } from '@/services/appearance'
import { createSystemStatusMonitor, percent } from '@/services/systemStatusMonitor'
import AiIcon from './ai/AiIcon.vue'
import SystemStopButton from './SystemStopButton.vue'

const props = withDefaults(defineProps<{ embedded?: boolean; active?: boolean; assistantPhase?: OrbPhase }>(), {
  embedded: false,
  active: true,
})
const collapsed = ref(false)
const monitor = createSystemStatusMonitor()
const metrics = monitor.state
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
type ResourceKey = 'cpu' | 'ram' | 'gpu'
type Scope = 'system' | 'app' | 'model'
const scopes = [
  { key: 'system' as const, label: 'Rechner', detail: 'Gesamter Rechner' },
  { key: 'app' as const, label: 'App', detail: 'Luczor-App ohne lokalen Modellprozess' },
  { key: 'model' as const, label: 'Modell', detail: 'Verwaltetes lokales Modell' },
]
const modelStatus = computed(() =>
  metrics.sample?.model_running === true
    ? 'Lokales Modell aktiv'
    : metrics.sample?.model_running === false
      ? 'Kein lokales Modell aktiv'
      : 'Modellprozess nicht bestätigt'
)
const gpuProcessUnavailable = computed(
  () =>
    metrics.sample &&
    (percent(metrics.sample.app_gpu_percent) === null ||
      (metrics.sample.model_running === true && percent(metrics.sample.model_gpu_percent) === null))
)
function chart(key: ResourceKey, scope: Scope) {
  let path = ''
  let connected = false
  let last: { x: number; y: number } | null = null
  metrics.history.forEach((point, index) => {
    const values = scope === 'system' ? point : scope === 'app' ? point.app : point.model
    const value = key === 'cpu' ? values.cpu : key === 'ram' ? values.ram : values.gpu
    if (value === null) {
      connected = false
      last = null
      return
    }
    const x = 4 + (index / Math.max(1, metrics.history.length - 1)) * 172
    const y = 68 - value * 0.6
    path += `${connected ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `
    connected = true
    last = { x, y }
  })
  return { path, last }
}
function resource(key: ResourceKey, label: string, detail: string, values: unknown[]) {
  return {
    key,
    label,
    detail,
    series: scopes.map((scope, index) => ({
      ...scope,
      value: scope.key === 'model' && metrics.sample?.model_running === false ? null : percent(values.at(index)),
      chart: chart(key, scope.key),
    })),
  }
}
const hardware = computed(() => {
  const s = metrics.sample
  return [
    resource('cpu', 'CPU', 'Anteil der gesamten CPU-Kapazität', [
      s?.cpu_percent,
      s?.app_cpu_percent,
      s?.model_cpu_percent,
    ]),
    resource('ram', 'RAM', 'Anteil am gesamten Arbeitsspeicher', [
      s?.ram_percent,
      s?.app_ram_percent,
      s?.model_ram_percent,
    ]),
    resource('gpu', 'GPU', s?.gpu_source === 'nvml' ? 'Geräteauslastung · NVIDIA' : 'Höchste GPU-Engine-Auslastung', [
      s?.gpu_percent,
      s?.app_gpu_percent,
      s?.model_gpu_percent,
    ]),
  ]
})
const formatPercent = (value: number) => value.toLocaleString('de-DE', { maximumFractionDigits: 1 })
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
    :class="{ embedded, 'reduce-motion': appearance.reduceMotion }"
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
      <div class="status-overview" :data-tone="phase.tone">
        <div class="status-overview__text">
          <span class="status-caption">Luczor</span>
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
        <svg
          class="status-map"
          :class="{ 'is-working': active && phase.moving }"
          viewBox="0 0 180 130"
          fill="none"
          aria-hidden="true"
        >
          <path class="map-guide" d="M14 65h32m88 0h32M90 12v23m0 60v23" />
          <path class="map-layer map-layer--back" d="m90 42 45 25-45 25-45-25Z" />
          <path class="map-layer map-layer--middle" d="m90 29 45 25-45 25-45-25Z" />
          <path class="map-layer map-layer--front" d="m90 16 45 25-45 25-45-25Z" />
          <path class="map-spark" d="m90 28 4 9 11 4-11 4-4 9-4-9-11-4 11-4Z" />
          <circle class="map-node" :data-state="hud.sync.server" cx="14" cy="65" r="3" />
          <circle class="map-node" :data-state="hud.sync.cognee" cx="166" cy="65" r="3" />
          <circle class="map-node" :data-state="hud.killSwitch ? 'offline' : 'unknown'" cx="90" cy="118" r="3" />
        </svg>
      </div>
      <div class="resource-heading">
        <h4>Geräteressourcen</h4>
        <span :data-stale="metrics.availability === 'stale'">{{ freshness }}</span>
      </div>
      <div class="resource-grid" :class="{ 'is-stale': metrics.availability === 'stale' }">
        <article v-for="meter in hardware" :key="meter.key" class="resource">
          <h5>{{ meter.label }}</h5>
          <dl class="resource-values">
            <div v-for="series in meter.series" :key="series.key" :data-scope="series.key" :title="series.detail">
              <dt><i />{{ series.label }}</dt>
              <dd
                :aria-label="
                  series.value === null
                    ? series.key === 'model' && metrics.sample?.model_running === false
                      ? 'Nicht aktiv'
                      : 'Nicht verfügbar'
                    : undefined
                "
              >
                {{ series.value === null ? '—' : formatPercent(series.value)
                }}<small v-if="series.value !== null">%</small>
              </dd>
            </div>
          </dl>
          <svg class="resource__chart" viewBox="0 0 180 74" preserveAspectRatio="none" aria-hidden="true">
            <path class="chart-baseline" d="M4 8H176M4 68H176" />
            <g v-for="series in meter.series" :key="series.key" :data-scope="series.key">
              <path class="chart-line" :d="series.chart.path" />
              <circle v-if="series.chart.last" :cx="series.chart.last.x" :cy="series.chart.last.y" r="2.3" />
            </g>
          </svg>
          <span class="resource__detail">{{ meter.detail }}</span>
        </article>
      </div>
      <p class="resource-note">
        {{
          metrics.history.length > 1
            ? 'Letzte Messungen · ca. 3,5 s Abstand · Skala 0–100 %'
            : 'Der Verlauf entsteht aus den Messungen während dieser Ansicht.'
        }}
      </p>
      <div class="resource-context">
        <span>{{ modelStatus }}</span
        ><span v-if="gpuProcessUnavailable">GPU-Prozessmessung teilweise nicht verfügbar.</span>
      </div>
      <details class="resource-explanation">
        <summary>Zuordnung der Werte</summary>
        <p>
          Rechner umfasst alle Anwendungen. App zeigt Luczor und seine Unterprozesse ohne den verwalteten Modellprozess.
          Modell zeigt den zugehörigen lokalen Prozess und seine Unterprozesse. RAM-Werte enthalten gemeinsam genutzte
          Speicherseiten und sind nicht addierbar.
        </p>
        <p>
          GPU zeigt pro Bereich die höchste Windows-GPU-Engine-Auslastung. Fehlt diese Messung, kann für den
          Rechner die höchste Geräteauslastung einer NVIDIA-Karte angezeigt werden. Die Kurven werden nicht
          addiert. Ein Strich bedeutet nicht verfügbar oder nicht aktiv.
        </p>
      </details>
      <div class="connection-grid">
        <div v-for="connection in connections" :key="connection.label" class="connection">
          <span>{{ connection.label }}</span
          ><strong
            ><i class="connection-dot" :data-state="connection.state" />{{ connectionLabels[connection.state] }}</strong
          >
        </div>
      </div>
      <div class="sync-line">
        <span>{{ hud.sync.pending }} zur Synchronisierung ausstehend</span
        ><button type="button" class="quiet-button" :disabled="syncing || hud.sync.server !== 'online'" @click="doSync">
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
  min-height: 140px;
  padding-bottom: 16px;
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
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.04em;
  line-height: 1.2;
}
.status-overview p {
  margin: 0;
  color: var(--ai-muted);
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
  padding: 16px 0 14px;
  border-top: 1px solid var(--ai-line);
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.resource {
  min-width: 0;
  padding: 0 16px;
  border-left: 1px solid var(--ai-line);
}
.resource:first-child {
  padding-left: 0;
  border: 0;
}
.resource:last-child {
  padding-right: 0;
}
.resource h5 {
  margin: 0 0 13px;
  font-size: 12px;
  font-weight: 600;
}
[data-scope='system'] {
  --scope-color: var(--ai-green);
}
[data-scope='app'] {
  --scope-color: #b3a0f7;
}
[data-scope='model'] {
  --scope-color: var(--ai-orange);
}
.resource-values {
  display: grid;
  gap: 8px;
  margin: 0 0 14px;
}
.resource-values > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.resource-values dt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ai-muted);
  font-size: 11px;
}
.resource-values dt i {
  width: 5px;
  height: 5px;
  background: var(--scope-color);
  border-radius: 50%;
  flex-shrink: 0;
}
.resource-values dd {
  margin: 0;
  color: var(--scope-color);
  font-size: 19px;
  font-weight: 500;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.03em;
  white-space: nowrap;
}
.resource-values small {
  font-size: 10px;
  margin-left: 3px;
  color: var(--ai-muted);
}
.resource__detail {
  margin-top: 10px;
  overflow-wrap: anywhere;
  display: block;
  min-height: 30px;
  color: var(--ai-muted);
  font-size: 10px;
  line-height: 1.4;
}
.resource__chart {
  display: block;
  width: 100%;
  height: 74px;
  margin-top: 4px;
  overflow: visible;
}
.resource__chart g {
  fill: var(--scope-color);
}
.chart-baseline {
  stroke: var(--ai-line);
  fill: none;
  stroke-dasharray: 2 4;
}
.chart-line {
  fill: none;
  stroke: var(--scope-color);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
}
.is-stale .resource__chart {
  opacity: 0.55;
}
.resource__chart [data-scope='app'] .chart-line {
  stroke-dasharray: 3 2;
}
.resource__chart [data-scope='model'] .chart-line {
  stroke-dasharray: 7 2;
}
.resource-note {
  margin: 12px 0 8px;
}
.resource-context {
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
    min-height: 115px;
    gap: 4px;
  }
  .status-overview h3 {
    font-size: 22px;
  }
  .status-overview p {
    font-size: 11px;
  }
  .status-map {
    width: 98px;
    height: 96px;
  }
  .resource {
    padding: 0 10px;
  }
  .resource-values > div {
    display: grid;
    gap: 3px;
  }
  .resource-values dd {
    font-size: 18px;
  }
  .resource__detail {
    min-height: 42px;
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
