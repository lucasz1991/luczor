<script setup lang="ts">
import { computed, reactive, readonly, watchEffect } from 'vue'
import SystemMiniModelUsage from '@/features/system-status/components/SystemMiniModelUsage.vue'
import SystemResourceMeter from '@/features/system-status/components/SystemResourceMeter.vue'
import { useSystemResourceModel } from '@/features/system-status/resourceModel'
import type { MiniSystemSnapshot } from '@/services/miniChat/types'
import type { SystemMetrics } from '@/services/systemMetrics'
import type { SystemStatusPoint, SystemStatusState } from '@/services/systemStatusMonitor'

/**
 * The nudge's Systemstatus pane: the same model card and layered ring tiles as the main window's
 * mini system column, fed from the display snapshot the main window publishes while this pane
 * is visible. Nothing is measured here; the mini webview has no metrics permission.
 */
const props = defineProps<{ system: MiniSystemSnapshot | null }>()
const metrics = reactive<SystemStatusState>({ sample: null, history: [], availability: 'idle', lastUpdatedAt: null })
watchEffect(() => {
  const system = props.system
  metrics.sample = (system?.sample ?? null) as SystemMetrics | null
  metrics.history = [...(system?.history ?? [])] as SystemStatusPoint[]
  metrics.availability = system?.availability ?? 'idle'
  metrics.lastUpdatedAt = system?.lastUpdatedAt ?? null
})
const { hardware, compactModelUsage, modelStatus } = useSystemResourceModel(readonly(metrics))
const tiles = computed(() => hardware.value.filter(meter => !meter.disk))
const stale = computed(() => metrics.availability === 'stale')
const modelLabel = computed(() => props.system?.model.label ?? modelStatus.value)
const freshness = computed(() => {
  if (!metrics.lastUpdatedAt) return 'Messwerte werden angefordert …'
  return `Stand ${new Date(metrics.lastUpdatedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
})
</script>
<template>
  <div class="mini-system" :data-availability="metrics.availability">
    <SystemMiniModelUsage
      :metrics="compactModelUsage"
      :model-status="modelLabel"
      :running="metrics.sample?.model_running === true"
    />
    <div v-if="metrics.sample" class="mini-system__grid" :class="{ 'is-stale': stale }">
      <SystemResourceMeter
        v-for="meter in tiles"
        :key="meter.key"
        :meter="meter"
        view="circles"
        compact
        :stale="stale"
      />
    </div>
    <p v-else class="mini-grip-panel__empty">{{ freshness }}</p>
    <p v-if="metrics.sample" class="mini-system__foot">
      <span>{{ system?.model.name ?? 'Lokales Modell' }}</span
      ><span>{{ freshness }}</span>
    </p>
  </div>
</template>
<style scoped>
.mini-system {
  display: grid;
  gap: 8px;
}
.mini-system :deep(.compact-model-usage) {
  margin-top: 0;
}
.mini-system__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 5px;
  transition: opacity 300ms var(--ease, ease);
}
.mini-system__grid.is-stale {
  opacity: 0.6;
}
.mini-system__foot {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  font: 10px var(--font-mono, monospace);
  color: var(--ai-faint, #6f788d);
}
.mini-system__foot span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
