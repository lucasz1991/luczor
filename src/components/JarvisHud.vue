<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { hud, type ConnState } from '@/state/hud'
import type { OrbPhase } from '@/services/miniChat/presentation'
import { lastScreenshot } from '@/services/tools/registry'
import { syncNow } from '@/services/status'
import { appearance } from '@/services/appearance'
import { createSystemStatusMonitor, percent } from '@/services/systemStatusMonitor'
import AiIcon from './ai/AiIcon.vue'
import SystemStopButton from './SystemStopButton.vue'
import SystemActivityCharts from './SystemActivityCharts.vue'

const props = withDefaults(
  defineProps<{
    embedded?: boolean
    active?: boolean
    assistantPhase?: OrbPhase
    section?: 'all' | 'resources' | 'localmodel' | 'memory' | 'network' | 'details'
  }>(),
  {
    embedded: false,
    active: true,
    assistantPhase: undefined,
    section: 'resources',
  }
)
type Indicator = 'ok' | 'active' | 'warning' | 'unknown'
const emit = defineEmits<{
  indicators: [value: { resources: Indicator; memory: Indicator; network: Indicator; details: Indicator }]
}>()
const flowIndicators = ref<{ memory: Indicator; network: Indicator }>({ memory: 'unknown', network: 'unknown' })
const resourceView = ref<'circles' | 'history'>('circles')
const collapsed = ref(false)
const monitor = createSystemStatusMonitor()
const metrics = monitor.state
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
type ResourceKey = 'cpu' | 'ram' | 'gpu' | 'disk'
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
function chart(key: ResourceKey, scope: Scope): { path: string; last: { x: number; y: number } | null } {
  let path = ''
  let connected = false
  let last: { x: number; y: number } | null = null
  metrics.history.forEach((point, index) => {
    const values = scope === 'system' ? point : scope === 'app' ? point.app : point.model
    const value =
      key === 'disk'
        ? ((scope === 'system' ? point.disk?.busy : scope === 'app' ? point.disk?.read : point.disk?.write) ?? null)
        : key === 'cpu'
          ? values.cpu
          : key === 'ram'
            ? values.ram
            : values.gpu
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
      value:
        key !== 'disk' && scope.key === 'model' && metrics.sample?.model_running === false
          ? null
          : percent(values.at(index)),
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
    {
      ...resource('disk', s?.disk?.kind === 'ssd' ? 'SSD' : 'Disk', 'Aktivität des App-Laufwerks', [
        s?.disk?.busy_percent,
        s?.disk?.read_percent,
        s?.disk?.write_percent,
      ]),
      series: resource('disk', 'SSD', '', [
        s?.disk?.busy_percent,
        s?.disk?.read_percent,
        s?.disk?.write_percent,
      ]).series.map((series, index) => ({
        ...series,
        detail: ['Aktive Zeit des App-Laufwerks', 'Lesezeit des App-Laufwerks', 'Schreibzeit des App-Laufwerks'][
          index
        ]!,
      })),
    },
  ]
})
const storageUsed = computed(() =>
  metrics.sample?.disk?.total_bytes
    ? Math.min(100, (metrics.sample.disk.used_bytes / metrics.sample.disk.total_bytes) * 100)
    : null
)
const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })
function temperature(key: string) {
  const value = key === 'cpu' ? metrics.sample?.cpu_temp_c : metrics.sample?.gpu_temp_c
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} °C`
    : '— °C'
}
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
        <div class="resource-heading">
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
          <article v-for="meter in hardware" :key="meter.key" class="resource">
            <h5 :class="{ 'ai-sr-only': resourceView === 'circles' }">{{ meter.label }}</h5>
            <div v-if="resourceView === 'circles'" class="resource-dial-wrap">
              <svg class="resource-dial" viewBox="0 0 120 120" aria-hidden="true">
                <g
                  v-for="(series, index) in meter.series"
                  :key="series.key"
                  :data-scope="series.key"
                  transform="rotate(135 60 60)"
                >
                  <circle
                    class="dial-track"
                    cx="60"
                    cy="60"
                    :r="49 - index * 10"
                    pathLength="100"
                    stroke-dasharray="75 100"
                  />
                  <circle
                    v-if="series.value !== null"
                    class="dial-value"
                    cx="60"
                    cy="60"
                    :r="49 - index * 10"
                    pathLength="100"
                    :stroke-dasharray="`${series.value * 0.75} 100`"
                  />
                </g>
                <text x="60" y="63" text-anchor="middle">{{ meter.label }}</text>
              </svg>
              <span
                v-for="(series, index) in meter.series"
                :key="series.key"
                class="dial-badge"
                :data-scope="series.key"
                :style="{ top: `${15 + index * 21}%` }"
                tabindex="0"
                :aria-label="`${meter.label} · ${series.detail}: ${series.value === null ? 'nicht verfügbar oder nicht aktiv' : formatPercent(series.value) + ' Prozent'}`"
                :data-tip="series.detail"
                >{{ series.value === null ? '—' : formatPercent(series.value) + ' %' }}</span
              >
            </div>
            <div v-else class="resource-history">
              <div class="history-values">
                <span
                  v-for="series in meter.series"
                  :key="series.key"
                  :data-scope="series.key"
                  :title="series.detail"
                  >{{ series.value === null ? '—' : formatPercent(series.value) + ' %' }}</span
                >
              </div>
              <svg class="resource__chart" viewBox="0 0 180 74" preserveAspectRatio="none" aria-hidden="true">
                <path class="chart-baseline" d="M4 8H176M4 68H176" />
                <g v-for="series in meter.series" :key="series.key" :data-scope="series.key">
                  <path class="chart-line" :d="series.chart.path" />
                  <circle v-if="series.chart.last" :cx="series.chart.last.x" :cy="series.chart.last.y" r="2.3" />
                </g>
              </svg>
            </div>
            <div
              v-if="meter.key === 'cpu' || meter.key === 'gpu'"
              class="resource-temperature"
              :aria-label="`${meter.label}-Temperatur: ${temperature(meter.key)}`"
            >
              <svg width="13" height="16" viewBox="0 0 16 20" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M6 12V4a2 2 0 0 1 4 0v8a4 4 0 1 1-4 0Z" />
                <path d="M8 6v9" />
              </svg>
              <span>{{ temperature(meter.key) }}</span
              ><small v-if="temperature(meter.key) === '— °C'">Sensor nicht verfügbar</small>
            </div>
            <div v-if="meter.key === 'disk'" class="disk-capacity">
              <template v-if="metrics.sample?.disk && storageUsed !== null"
                ><span>{{ metrics.sample.disk.mount }} · {{ formatPercent(storageUsed) }} % belegt</span>
                <div
                  class="disk-capacity-bar"
                  role="meter"
                  aria-label="Datenträgerbelegung"
                  :aria-valuenow="storageUsed"
                  :aria-valuemin="0"
                  :aria-valuemax="100"
                >
                  <i :style="{ width: `${storageUsed}%` }" />
                </div>
                <span
                  >{{ gib(metrics.sample.disk.used_bytes) }} / {{ gib(metrics.sample.disk.total_bytes) }} GiB</span
                ></template
              ><span v-else>Belegung nicht verfügbar</span>
            </div>
          </article>
        </div>
        <p v-if="resourceView === 'history'" class="resource-note">
          {{
            metrics.history.length > 1
              ? 'Letzte Messungen · ca. 3,5 s Abstand · Skala 0–100 %'
              : 'Der Verlauf entsteht aus den Messungen während dieser Ansicht.'
          }}
        </p>
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
            Strich bedeutet nicht verfügbar oder nicht aktiv. SSD zeigt aktive Zeit, Lesezeit und Schreibzeit des
            App-Laufwerks (grün/violett/amber), darunter dessen Speicherbelegung. Diese Zeitanteile überlappen und sind
            keine App-/Modellanteile.
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
.resource-temperature {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--ai-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  margin-top: 8px;
}
.resource-temperature small {
  font-size: 10px;
}
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
.resource-dial-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 180 / 152;
  margin: auto;
}
.dial-badge {
  position: absolute;
  right: 0;
  min-width: 40px;
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb, var(--scope-color) 35%, transparent);
  border-radius: 5px;
  background: var(--ai-surface);
  color: var(--scope-color);
  font: 500 11px/1.4 var(--ai-font);
  font-variant-numeric: tabular-nums;
  text-align: center;
  cursor: default;
}
.dial-badge:focus-visible {
  outline: 2px solid var(--scope-color);
  outline-offset: 3px;
}
.dial-badge::after {
  content: attr(data-tip);
  display: none;
  position: absolute;
  bottom: calc(100% + 7px);
  right: 0;
  width: max-content;
  max-width: 165px;
  padding: 7px 9px;
  border-radius: 5px;
  background: var(--ai-hover);
  color: var(--ai-ink);
  font-weight: 400;
  z-index: 2;
  text-align: left;
}
.dial-badge:is(:hover, :focus-visible)::after {
  display: block;
}
.history-values {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.history-values span {
  color: var(--scope-color);
}
.resource-history {
  min-height: 152px;
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
.resource {
  min-width: 0;
  padding: 0;
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
.resource-dial {
  display: block;
  width: 82%;
  margin: 0;
  overflow: visible;
}
.resource-dial circle {
  fill: none;
  stroke-width: 5;
  stroke-linecap: round;
}
.dial-track {
  stroke: var(--ai-line);
}
.dial-value {
  stroke: var(--scope-color);
}
.resource-dial text {
  fill: var(--ai-ink);
  font: 500 12px var(--ai-font);
  letter-spacing: 0.06em;
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
  .resource {
    padding: 0 6px;
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
.disk-capacity {
  display: grid;
  gap: 6px;
  margin-top: 8px;
  font-size: 10px;
  color: var(--ai-muted);
  font-variant-numeric: tabular-nums;
}
.disk-capacity-bar {
  height: 3px;
  background: var(--ai-line);
  overflow: hidden;
  border-radius: 2px;
}
.disk-capacity-bar i {
  display: block;
  height: 100%;
  background: var(--ai-green);
}
@media (max-width: 480px) {
  .resource {
    padding: 0;
  }
  .resource-dial-wrap {
    max-width: 230px;
  }
}
</style>
