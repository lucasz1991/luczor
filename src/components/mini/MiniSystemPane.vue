<script setup lang="ts">
import { computed, reactive, readonly, ref, watch, watchEffect } from 'vue'
import SystemMiniModelUsage from '@/features/system-status/components/SystemMiniModelUsage.vue'
import { meterTile, meterUsage, useSystemResourceModel } from '@/features/system-status/resourceModel'
import type { MiniSystemSnapshot } from '@/services/miniChat/types'
import type { SystemMetrics } from '@/services/systemMetrics'
import type { SystemStatusPoint, SystemStatusState } from '@/services/systemStatusMonitor'

/**
 * The nudge's Systemstatus pane: the main window's mini column — CPU/RAM/GPU rings, memory and
 * network flows, the model card and the tool channels — as one narrow column of single-line rows.
 * Everything is fed from the display snapshot the main window publishes while this pane is
 * visible; nothing is measured here, the mini webview has no metrics permission.
 */
const props = defineProps<{
  system: MiniSystemSnapshot | null
  /** Assistant phase from the nudge status line; the tools row mirrors it like the main window. */
  phase?: { label: string; moving: boolean; locked: boolean }
}>()
const metrics = reactive<SystemStatusState>({ sample: null, history: [], availability: 'idle', lastUpdatedAt: null })
watchEffect(() => {
  const system = props.system
  metrics.sample = (system?.sample ?? null) as SystemMetrics | null
  metrics.history = [...(system?.history ?? [])] as SystemStatusPoint[]
  metrics.availability = system?.availability ?? 'idle'
  metrics.lastUpdatedAt = system?.lastUpdatedAt ?? null
})
const { hardware, compactModelUsage, modelStatus } = useSystemResourceModel(readonly(metrics))
const rows = computed(() =>
  hardware.value
    .filter(meter => !meter.disk)
    .map(meter => {
      const tile = meterTile(meter)
      let offset = 0
      const segments = meterUsage(meter).map(segment => {
        const start = offset
        offset += segment.width * 0.75
        return { key: segment.key, label: segment.label, dash: segment.width * 0.75, offset: -start }
      })
      return { key: meter.key, label: meter.label, detail: meter.detail, tile, segments }
    })
)
const stale = computed(() => metrics.availability === 'stale')
const modelLabel = computed(() => props.system?.model.label ?? modelStatus.value)
const freshness = computed(() => {
  if (!metrics.lastUpdatedAt) return 'Messwerte werden angefordert …'
  return `Stand ${new Date(metrics.lastUpdatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
})

/* Flow rates come from consecutive cumulative snapshots, as the main window's charts derive them. */
type FlowPoint = {
  read: number | null
  write: number | null
  externalIn: number | null
  externalOut: number | null
  localIn: number | null
  localOut: number | null
}
type FlowKey = keyof FlowPoint
const flows = ref<FlowPoint[]>([])
let previous: MiniSystemSnapshot['activity'] | undefined
watch(
  () => props.system?.activity,
  next => {
    if (!next) {
      previous = undefined
      flows.value = []
      return
    }
    const before = previous
    previous = next
    if (!before || next.at <= before.at) return
    const seconds = (next.at - before.at) / 1000
    const rate = (now: number | undefined, old: number | undefined) =>
      typeof now === 'number' && typeof old === 'number' && now >= old ? (now - old) / seconds : null
    flows.value = [
      ...flows.value.slice(-23),
      {
        read: rate(next.memory?.reads, before.memory?.reads),
        write: rate(next.memory?.writes, before.memory?.writes),
        externalIn: rate(next.external.receivedBytes, before.external.receivedBytes),
        externalOut: rate(next.external.sentBytes, before.external.sentBytes),
        localIn: rate(next.local?.receivedBytes, before.local?.receivedBytes),
        localOut: rate(next.local?.sentBytes, before.local?.sentBytes),
      },
    ]
  }
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
function sparkline(keys: [FlowKey, FlowKey]) {
  // Keys are the closed flow series above; no external property names enter this lookup.
  // eslint-disable-next-line security/detect-object-injection
  const value = (point: FlowPoint, key: FlowKey) => point[key]
  const points = flows.value
  const maximum = Math.max(1, ...points.flatMap(point => keys.map(key => value(point, key) ?? 0)))
  return keys.map(key => {
    let connected = false
    let path = ''
    points.forEach((point, index) => {
      const reading = value(point, key)
      if (reading === null) {
        connected = false
        return
      }
      const position = 1 + (index / Math.max(1, points.length - 1)) * 58
      path += `${connected ? 'L' : 'M'}${position.toFixed(1)},${(15 - (reading / maximum) * 13).toFixed(1)} `
      connected = true
    })
    return { key, path }
  })
}
const latest = computed(() => flows.value.at(-1))
const flowRows = computed(() => {
  const activity = props.system?.activity
  return [
    {
      id: 'memory',
      label: 'Gedächtnis',
      hint: activity?.memory ? `${activity.memory.activeReads + activity.memory.activeWrites} aktiv` : '—',
      values: [operations(latest.value?.read), operations(latest.value?.write)],
      titles: ['Lesen', 'Schreiben'],
      paths: sparkline(['read', 'write']),
    },
    {
      id: 'external',
      label: 'Extern',
      hint: activity ? `${activity.external.activeRequests} aktiv` : '—',
      values: [bytes(latest.value?.externalIn), bytes(latest.value?.externalOut)],
      titles: ['Empfangen', 'Senden'],
      paths: sparkline(['externalIn', 'externalOut']),
    },
    {
      id: 'local',
      label: 'Lokal',
      hint: activity?.local ? `${activity.local.activeRequests} aktiv` : 'nicht messbar',
      values: [bytes(latest.value?.localIn), bytes(latest.value?.localOut)],
      titles: ['Empfangen', 'Senden'],
      paths: sparkline(['localIn', 'localOut']),
    },
  ]
})
const toolState = computed(() => (props.phase?.locked ? 'locked' : props.phase?.moving ? 'active' : 'idle'))
const toolLabel = computed(() => (props.phase?.locked ? 'Not-Aus' : props.phase?.moving ? props.phase.label : 'Bereit'))
</script>
<template>
  <div class="mini-system" :data-availability="metrics.availability" :class="{ 'is-stale': stale }">
    <template v-if="system">
      <ul class="mini-system__meters" aria-label="Geräteauslastung">
        <li v-for="row in rows" :key="row.key" :data-lvl="row.tile.level" :title="row.detail">
          <svg class="mini-system__dial" viewBox="0 0 40 34" aria-hidden="true">
            <g transform="rotate(135 20 20)">
              <circle class="mini-system__track" cx="20" cy="20" r="16" pathLength="100" stroke-dasharray="75 100" />
              <circle
                v-for="segment in row.segments"
                :key="segment.key"
                class="mini-system__value"
                :data-scope="segment.key"
                cx="20"
                cy="20"
                r="16"
                pathLength="100"
                :stroke-dasharray="`${segment.dash} 100`"
                :stroke-dashoffset="segment.offset"
              >
                <title>{{ segment.label }}</title>
              </circle>
            </g>
          </svg>
          <span class="mini-system__label">{{ row.label }}</span>
          <strong class="mini-system__reading"
            >{{ row.tile.value }}<small v-if="row.tile.unit">{{ row.tile.unit }}</small></strong
          >
          <span class="mini-system__sub" :data-tone="row.tile.subTone">{{ row.tile.sub }}</span>
        </li>
      </ul>
      <ul class="mini-system__flows" aria-label="Speicher- und Datenverkehr">
        <li v-for="flow in flowRows" :key="flow.id">
          <span class="mini-system__label">{{ flow.label }}</span>
          <svg viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden="true">
            <path
              v-for="(line, index) in flow.paths"
              :key="line.key"
              class="mini-system__line"
              :data-line="index"
              :d="line.path"
            />
          </svg>
          <span class="mini-system__pair">
            <b
              v-for="(value, index) in flow.values"
              :key="flow.titles[index]"
              :data-line="index"
              :title="flow.titles[index]"
              >{{ value }}</b
            >
          </span>
          <span class="mini-system__hint">{{ flow.hint }}</span>
        </li>
      </ul>
      <SystemMiniModelUsage
        :metrics="compactModelUsage"
        :model-status="modelLabel"
        :running="metrics.sample?.model_running === true"
      />
      <section class="mini-system__tools" aria-label="Werkzeuge">
        <div class="mini-system__tools-head">
          <span class="mini-system__label">Werkzeuge</span><strong :data-state="toolState">{{ toolLabel }}</strong>
        </div>
        <div v-if="system.tools" class="mini-system__channels">
          <div v-for="channel in system.tools.channels" :key="channel.key" :title="channel.label">
            <span>{{ channel.label }}</span>
            <i><b :style="{ width: `${Math.round(channel.level * 100)}%` }" /></i>
          </div>
        </div>
        <p class="mini-system__last" :title="system.tools?.lastTool || undefined">
          {{ system.tools?.lastTool || 'Noch kein Tool ausgeführt' }}
        </p>
      </section>
      <p class="mini-system__foot">
        <span>{{ system.model.name }}</span
        ><span>{{ freshness }}</span>
      </p>
    </template>
    <template v-else>
      <SystemMiniModelUsage :metrics="compactModelUsage" :model-status="modelLabel" :running="false" />
      <p class="mini-grip-panel__empty">{{ freshness }}</p>
    </template>
  </div>
</template>
<style scoped>
.mini-system {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 7px;
  max-height: min(560px, calc(100vh - 120px));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--ai-line-strong) transparent;
  transition: opacity 300ms var(--ease, ease);
}
.mini-system.is-stale > :not(.mini-system__foot) {
  opacity: 0.6;
}
.mini-system ul {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.mini-system li {
  display: grid;
  align-items: center;
  min-height: 26px;
  padding: 3px 8px 3px 6px;
  border: 1px solid var(--ai-line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ai-ink) 3.5%, transparent);
}
.mini-system__meters li {
  grid-template-columns: 28px 1fr auto;
  grid-template-areas:
    'dial label reading'
    'dial sub reading';
  column-gap: 8px;
}
.mini-system__dial {
  grid-area: dial;
  width: 28px;
  overflow: visible;
}
.mini-system__dial circle {
  fill: none;
  stroke-width: 5;
  transition:
    stroke-dasharray 0.7s var(--ease, ease),
    stroke-dashoffset 0.7s var(--ease, ease);
}
.mini-system__track {
  stroke: var(--ai-line-strong);
  opacity: 0.55;
}
.mini-system__value {
  stroke: var(--scope-color);
}
[data-scope='system'] {
  --scope-color: var(--ai-green);
}
[data-scope='app'] {
  --scope-color: var(--ai-accent);
}
[data-scope='model'] {
  --scope-color: var(--ai-orange);
}
.mini-system__label {
  grid-area: label;
  color: var(--ai-faint);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.1em;
  line-height: 1.2;
  text-transform: uppercase;
}
.mini-system__reading {
  grid-area: reading;
  color: var(--ai-ink);
  font: 600 14px var(--font-mono, monospace);
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.mini-system__reading small {
  margin-left: 1px;
  color: var(--ai-muted);
  font-size: 9px;
  font-weight: 400;
}
[data-lvl='warn'] .mini-system__reading {
  color: var(--ai-orange);
}
[data-lvl='bad'] .mini-system__reading {
  color: var(--ai-red);
}
.mini-system__sub {
  grid-area: sub;
  min-height: 11px;
  color: var(--ai-accent);
  font: 400 8.5px var(--font-mono, monospace);
  line-height: 1.3;
}
.mini-system__sub[data-tone='warning'] {
  color: var(--ai-orange);
}
.mini-system__sub[data-tone='danger'] {
  color: var(--ai-red);
}
.mini-system__flows li {
  grid-template-columns: 52px 1fr auto;
  grid-template-areas:
    'label chart pair'
    'hint chart pair';
  column-gap: 8px;
}
.mini-system__flows .mini-system__label {
  grid-area: label;
}
.mini-system__flows svg {
  grid-area: chart;
  width: 100%;
  height: 18px;
  overflow: visible;
}
.mini-system__line {
  fill: none;
  stroke: var(--line-color);
  stroke-width: 1.4;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
[data-line='0'] {
  --line-color: var(--ai-green);
}
[data-line='1'] {
  --line-color: var(--ai-accent);
}
.mini-system__pair {
  grid-area: pair;
  display: grid;
  justify-items: end;
  gap: 1px;
}
.mini-system__pair b {
  color: var(--line-color);
  font: 500 9.5px var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.mini-system__hint {
  grid-area: hint;
  color: var(--ai-faint);
  font: 8.5px var(--font-mono, monospace);
  white-space: nowrap;
}
.mini-system :deep(.compact-model-usage) {
  margin-top: 0;
  gap: 4px;
  padding: 6px 8px 7px;
  border-radius: 9px;
}
.mini-system :deep(.compact-model-usage__heading) {
  font-size: 9px;
}
.mini-system :deep(.compact-model-usage dl) {
  gap: 2px 6px;
  font-size: 9.5px;
}
.mini-system__tools {
  display: grid;
  gap: 5px;
  padding: 6px 8px 7px;
  border: 1px solid var(--ai-line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ai-ink) 3.5%, transparent);
}
.mini-system__tools-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.mini-system__tools-head strong {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--ai-line);
  color: var(--ai-muted);
  font-size: 9px;
  font-weight: 500;
}
.mini-system__tools-head strong[data-state='active'] {
  color: var(--ai-accent);
  border-color: color-mix(in srgb, var(--ai-accent) 45%, transparent);
}
.mini-system__tools-head strong[data-state='locked'] {
  color: var(--ai-red);
  border-color: color-mix(in srgb, var(--ai-red) 45%, transparent);
}
.mini-system__channels {
  display: grid;
  gap: 3px;
}
.mini-system__channels > div {
  display: grid;
  grid-template-columns: 34px 1fr;
  align-items: center;
  gap: 6px;
  color: var(--ai-muted);
  font-size: 9px;
}
.mini-system__channels i {
  display: block;
  height: 3px;
  border-radius: 2px;
  background: var(--ai-line);
  overflow: hidden;
}
.mini-system__channels b {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--ai-accent);
  transition: width 220ms var(--ease, ease);
}
.mini-system__last {
  margin: 0;
  color: var(--ai-faint);
  font: 9px var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-system__foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  font: 9px var(--font-mono, monospace);
  color: var(--ai-faint);
}
.mini-system__foot span {
  white-space: nowrap;
}
.mini-system__foot span:first-child {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mini-system__foot span:last-child {
  flex: none;
}
</style>
