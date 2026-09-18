<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { snapshotMemoryActivity } from '@/services/memory/activity'
import { memoryStatus } from '@/features/memory/observatory'
import { snapshotNetworkActivity } from '@/services/networkActivity'
import type { LocalNetworkCounters } from '@/services/systemMetrics'

const props = withDefaults(
  defineProps<{
    active: boolean
    nativeNetwork?: LocalNetworkCounters
    nativeLive: boolean
    view?: 'all' | 'memory' | 'network'
    compact?: boolean
  }>(),
  { view: 'memory', nativeNetwork: undefined, compact: false }
)
type Indicator = 'ok' | 'active' | 'warning' | 'unknown'
const emit = defineEmits<{ indicators: [value: { memory: Indicator; network: Indicator }] }>()
function snapshot() {
  const network = snapshotNetworkActivity()
  const native = props.nativeLive ? props.nativeNetwork : undefined
  return {
    at: Date.now(),
    memory: window.location.hash.startsWith('#system-status')
      ? memoryStatus.value && Date.now() - memoryStatus.value.at < 7000
        ? memoryStatus.value.activity
        : null
      : snapshotMemoryActivity(),
    external: network.external,
    unknown: network.unknown,
    local: native
      ? {
          sentBytes: network.local.sentBytes + native.sent_bytes,
          receivedBytes: network.local.receivedBytes + native.received_bytes,
          requests: network.local.requests + native.requests,
          activeRequests: network.local.activeRequests + native.active_requests,
          failedRequests: network.local.failedRequests + native.failed_requests,
        }
      : null,
  }
}
type Point = {
  at: number
  read: number | null
  write: number | null
  externalIn: number | null
  externalOut: number | null
  localIn: number | null
  localOut: number | null
}
type SeriesKey = Exclude<keyof Point, 'at'>
const current = ref(snapshot())
const history = ref<Point[]>([])
let previous: ReturnType<typeof snapshot> | null = null
let timer: ReturnType<typeof setInterval> | undefined
function sample() {
  const next = snapshot()
  const before = previous
  const seconds = before ? (next.at - before.at) / 1000 : 0
  const rate = (now: number | undefined, old: number | undefined) =>
    seconds > 0 && typeof now === 'number' && typeof old === 'number' && now >= old ? (now - old) / seconds : null
  if (before) {
    history.value.push({
      at: next.at,
      read: rate(next.memory?.reads, before.memory?.reads),
      write: rate(next.memory?.writes, before.memory?.writes),
      externalIn: rate(next.external.receivedBytes, before.external.receivedBytes),
      externalOut: rate(next.external.sentBytes, before.external.sentBytes),
      localIn: rate(next.local?.receivedBytes, before.local?.receivedBytes),
      localOut: rate(next.local?.sentBytes, before.local?.sentBytes),
    })
    if (history.value.length > 40) history.value.shift()
  }
  current.value = next
  previous = next
}
watch(
  () => props.active,
  active => {
    if (timer) clearInterval(timer)
    timer = undefined
    previous = null
    if (active) {
      sample()
      timer = setInterval(sample, 1000)
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
const latest = computed(() => history.value.at(-1))
watchEffect(() =>
  emit('indicators', {
    memory:
      (current.value.memory?.activeReads ?? 0) + (current.value.memory?.activeWrites ?? 0) > 0 ||
      (latest.value?.read ?? 0) + (latest.value?.write ?? 0) > 0
        ? 'active'
        : (current.value.memory?.failedReads ?? 0) + (current.value.memory?.failedWrites ?? 0) > 0
          ? 'warning'
          : (current.value.memory?.reads ?? 0) + (current.value.memory?.writes ?? 0) > 0
            ? 'ok'
            : 'unknown',
    network:
      current.value.external.activeRequests + (current.value.local?.activeRequests ?? 0) > 0
        ? 'active'
        : current.value.external.failedRequests + (current.value.local?.failedRequests ?? 0) > 0
          ? 'warning'
          : current.value.external.requests + (current.value.local?.requests ?? 0) > 0
            ? 'ok'
            : 'unknown',
  })
)
function bytes(value: number | null | undefined) {
  if (value == null) return '—'
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MiB/s`
  if (value >= 1024) return `${(value / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KiB/s`
  return `${Math.round(value)} B/s`
}
function operations(value: number | null | undefined) {
  return value == null ? '—' : `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })}/s`
}
function plot(keys: [SeriesKey, SeriesKey]) {
  // Keys are the closed, statically defined chart series below; no external property names enter this lookup.
  // eslint-disable-next-line security/detect-object-injection
  const value = (point: Point, key: SeriesKey) => point[key]
  const maximum = Math.max(1, ...history.value.flatMap(point => keys.map(key => value(point, key) ?? 0)))
  return keys.map(key => {
    let connected = false
    let path = ''
    history.value.forEach((point, index) => {
      const reading = value(point, key)
      if (reading === null) {
        connected = false
        return
      }
      const position = 3 + (index / Math.max(1, history.value.length - 1)) * 314
      path += `${connected ? 'L' : 'M'}${position.toFixed(1)},${(76 - (reading / maximum) * 64).toFixed(1)} `
      connected = true
    })
    return { key, path }
  })
}
const cards = computed(() => [
  {
    id: 'memory',
    label: 'Gedächtnis · Speicherzugriffe',
    hint: current.value.memory
      ? `${current.value.memory.activeReads + current.value.memory.activeWrites} Zugriffe aktiv`
      : 'Hauptfenster nicht verbunden',
    values: [
      { label: 'Lesen', value: operations(latest.value?.read) },
      { label: 'Schreiben', value: operations(latest.value?.write) },
    ],
    paths: plot(['read', 'write']),
    detail: current.value.memory
      ? `${current.value.memory.reads} gelesen · ${current.value.memory.writes} geschrieben · ${current.value.memory.failedReads + current.value.memory.failedWrites} fehlgeschlagen`
      : 'Keine aktuellen Messwerte',
  },
  {
    id: 'external',
    label: 'Externes Netzwerk',
    hint: `${current.value.external.activeRequests} Anfragen aktiv`,
    values: [
      { label: 'Empfangen', value: bytes(latest.value?.externalIn) },
      { label: 'Senden', value: bytes(latest.value?.externalOut) },
    ],
    paths: plot(['externalIn', 'externalOut']),
    detail: `${current.value.external.requests} Anfragen · ${current.value.external.failedRequests} fehlgeschlagen`,
  },
  {
    id: 'local',
    label: 'Lokale Verbindungen',
    hint: current.value.local
      ? `${current.value.local.activeRequests} Anfragen aktiv`
      : 'Modelltransport nicht messbar',
    values: [
      { label: 'Empfangen', value: bytes(latest.value?.localIn) },
      { label: 'Senden', value: bytes(latest.value?.localOut) },
    ],
    paths: plot(['localIn', 'localOut']),
    detail: current.value.local
      ? `${current.value.local.requests} Anfragen · Loopback und private Ziele`
      : 'Keine vollständige lokale Messung verfügbar',
  },
])
const visibleCards = computed(() =>
  cards.value.filter(
    card => props.view === 'all' || (props.view === 'memory' ? card.id === 'memory' : card.id !== 'memory')
  )
)
</script>
<template>
  <section class="activity-charts" :class="{ 'is-compact': compact }" aria-label="Speicher- und Datenverkehr">
    <div class="activity-charts__grid">
      <article v-for="card in visibleCards" :key="card.id" :class="`activity-chart activity-chart--${card.id}`">
        <header>
          <h5>{{ card.label }}</h5>
          <span>{{ card.hint }}</span>
        </header>
        <dl>
          <div v-for="(value, index) in card.values" :key="value.label" :data-line="index">
            <dt><i />{{ value.label }}</dt>
            <dd>{{ value.value }}</dd>
          </div>
        </dl>
        <svg viewBox="0 0 320 84" preserveAspectRatio="none" aria-hidden="true">
          <path class="activity-gridline" d="M3 12H317M3 44H317M3 76H317" />
          <path
            v-for="(line, index) in card.paths"
            :key="line.key"
            class="activity-line"
            :data-line="index"
            :d="line.path"
          />
        </svg>
        <small>{{ card.detail }}</small>
      </article>
    </div>
    <details v-if="!compact" class="activity-chart-info">
      <summary>Zur Messung</summary>
      <p class="activity-chart-note">
        Messabstand ca. 1 s · Skalen je Diagramm automatisch. Gezählt werden instrumentierte Speicherzugriffe und
        HTTP-Nutzdaten der API- und Modellverbindungen. Senden zählt übergebene Anfragebytes; Empfang zählt gelesene
        Antwortbytes. Lokale Zuordnung nach Zieladresse, ohne DNS-Auflösung. Andere Programme, Protokoll-Overhead und
        Downloads sind nicht enthalten. Die Gedächtniskurve ist keine KI-Auslastung: Ein einmal geladener Kontext kann
        während der gesamten Antwort genutzt werden, ohne weitere Lesezugriffe. Chat- und Pflegequellen stehen getrennt
        in „Gedächtnis &amp; Graph“; interne Pflegejournal- und Inspektionszugriffe erhöhen diese Kurve nicht.
      </p>
      <p v-if="current.unknown.requests" class="activity-chart-note">
        {{ current.unknown.requests }} Anfragen ohne eindeutige lokale/externe Zuordnung.
      </p>
    </details>
  </section>
</template>
<style scoped>
.activity-charts {
  padding: 20px 0;
}
.activity-chart-info {
  margin-top: 16px;
  color: var(--ai-muted);
  font-size: 10px;
}
.activity-chart-info summary {
  cursor: pointer;
}
.activity-charts__heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 18px;
}
.activity-charts h4,
.activity-charts h5 {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
}
.activity-charts__heading > span,
.activity-chart header > span {
  color: var(--ai-muted);
  font-size: 10px;
}
.activity-charts__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.activity-chart--memory {
  grid-column: 1 / -1;
}
.activity-chart {
  min-width: 0;
}
.activity-chart header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 5px;
}
.activity-chart dl {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 12px 0 4px;
}
.activity-chart dl > div {
  display: grid;
  gap: 3px;
}
.activity-chart dt {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ai-muted);
  font-size: 10px;
}
[data-line='0'] {
  --line-color: var(--ai-green);
}
[data-line='1'] {
  --line-color: var(--ai-accent);
}
.activity-chart dt i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--line-color);
}
.activity-chart dd {
  margin: 0;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--line-color);
}
.activity-chart svg {
  display: block;
  width: 100%;
  height: 84px;
  margin: 8px 0;
  overflow: visible;
}
.activity-gridline {
  stroke: var(--ai-line);
  stroke-dasharray: 2 4;
  fill: none;
}
.activity-line {
  stroke: var(--line-color);
  stroke-width: 1.5;
  fill: none;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
}
.activity-line[data-line='1'] {
  stroke-dasharray: 5 3;
}
.activity-chart small,
.activity-chart-note {
  color: var(--ai-muted);
  font-size: 10px;
  line-height: 1.6;
}
.activity-chart-note {
  margin: 14px 0 0;
}
/* Sidebar column: one card per row, tile look, small sparkline charts. */
.activity-charts.is-compact {
  padding: 6px 0 0;
}
.is-compact .activity-charts__grid {
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
}
.is-compact .activity-chart {
  padding: 8px 10px 8px;
  border: 1px solid var(--ai-line);
  border-radius: 12px;
  background: color-mix(in srgb, var(--ai-ink) 3.5%, transparent);
  transition:
    border-color 200ms var(--ease, ease),
    background 200ms var(--ease, ease);
}
.is-compact .activity-chart:hover {
  border-color: var(--ai-line-strong);
  background: color-mix(in srgb, var(--ai-ink) 5.5%, transparent);
}
.is-compact .activity-chart h5 {
  color: var(--ai-muted);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.is-compact .activity-chart header {
  flex-wrap: nowrap;
}
.is-compact .activity-chart header > span {
  min-width: 0;
  overflow: hidden;
  font: 400 9px var(--font-mono, monospace);
  color: var(--ai-accent);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.is-compact .activity-chart dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px 8px;
  margin: 6px 0 0;
}
.is-compact .activity-chart dl > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px;
  min-width: 0;
}
.is-compact .activity-chart dt {
  font-size: 9px;
}
.is-compact .activity-chart dd {
  overflow: hidden;
  font: 500 10px var(--font-mono, monospace);
  color: var(--ai-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.is-compact .activity-chart svg {
  height: 30px;
  margin: 5px 0 0;
}
.is-compact .activity-chart small {
  display: none;
}
@media (max-width: 480px) {
  .activity-charts__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
