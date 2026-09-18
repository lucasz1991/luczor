<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import MemoryGraphView from './MemoryGraphView.vue'
import { loadMemoryGraphDisplay, memoryGraphDisplay } from './graphDisplay'
import { useMemoryGraphData } from './useMemoryGraphData'

/**
 * The knowledge space as the app's living background: slowly turning and softly blurred behind
 * the chat, sharp and interactive while the memory page is open (`focused`). One instance, one
 * shared data source, so the dream animations are visible from everywhere.
 */
const props = defineProps<{ projectId: string; focused: boolean }>()
const data = useMemoryGraphData()
const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
// Pause the ambient orbit while the window is hidden; a blurred, unseen canvas should not burn cycles.
const hidden = ref(typeof document !== 'undefined' && document.visibilityState === 'hidden')
onMounted(() => {
  void loadMemoryGraphDisplay()
  data.ensureLoaded(props.projectId)
  document.addEventListener('visibilitychange', () => {
    hidden.value = document.visibilityState === 'hidden'
  })
})
watch(
  () => props.projectId,
  id => data.ensureLoaded(id)
)
watch(
  () => props.focused,
  focused => {
    if (focused) data.ensureLoaded(props.projectId, 30_000)
  }
)
const visible = computed(() => props.focused || memoryGraphDisplay.value.ambientBackdrop)
const display = computed(() => ({
  ...memoryGraphDisplay.value,
  // Ambient mode: always a slow orbit, hub labels only, edges kept light.
  autoRotate: props.focused ? memoryGraphDisplay.value.autoRotate : !hidden.value && !reducedMotion,
  labels: props.focused ? memoryGraphDisplay.value.labels : 'hubs',
}))
</script>
<template>
  <div
    v-if="visible"
    class="graph-backdrop"
    :class="{ 'is-focused': focused, 'is-dreaming': data.dream.value.active }"
    :aria-hidden="!focused"
    :inert="!focused"
  >
    <MemoryGraphView
      :graph="data.graph.value"
      :selected="data.selected.value"
      :dream="data.dream.value"
      :display="display"
      :offloading="!!data.dreamTrace.value.offload?.active"
      :links="data.links.value"
      :phase="data.phase.value"
      :ambient="!focused"
      @select="data.selected.value = $event"
    />
  </div>
</template>
<style scoped>
.graph-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
  opacity: 0.38;
  filter: blur(5px) saturate(115%);
  transform: scale(1.03);
  transition:
    opacity 700ms var(--ease, ease),
    filter 700ms var(--ease, ease),
    transform 900ms var(--ease, ease);
  will-change: filter, opacity;
}
.graph-backdrop.is-dreaming {
  opacity: 0.5;
}
.graph-backdrop.is-focused {
  opacity: 1;
  filter: none;
  transform: none;
  pointer-events: auto;
}
.graph-backdrop :deep(.memory-graph) {
  height: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.graph-backdrop :deep(.memory-graph > svg) {
  width: 100%;
  height: 100%;
  min-height: 0;
  max-height: none;
}
.graph-backdrop :deep(.memory-graph > p) {
  display: none;
}
/* Ambient: no controls, no chip – just the space. Focused: the page overlay carries the controls. */
.graph-backdrop:not(.is-focused) :deep(.memory-graph__tools),
.graph-backdrop:not(.is-focused) :deep(.memory-graph__dream) {
  display: none;
}
.graph-backdrop.is-focused :deep(.memory-graph__tools) {
  top: auto;
  bottom: 52px;
  right: 50%;
  transform: translateX(50%);
}
.graph-backdrop.is-focused :deep(.memory-graph__dream) {
  top: auto;
  bottom: 96px;
  left: 50%;
  transform: translateX(-50%);
}
@media (prefers-reduced-motion: reduce) {
  .graph-backdrop {
    transition: none;
  }
}
</style>
