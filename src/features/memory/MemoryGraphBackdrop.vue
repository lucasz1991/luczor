<script setup lang="ts">
import MemoryGraphView from './MemoryGraphView.vue'
import { memoryGraphDisplay } from './graphDisplay'
import { useMemoryGraphData } from './useMemoryGraphData'

/** Render layer owned exclusively by MemoryExplorerPage; never mounted behind chats. */
const data = useMemoryGraphData()
</script>
<template>
  <div class="graph-backdrop">
    <MemoryGraphView
      :graph="data.graph.value"
      :selected="data.selected.value"
      :dream="data.dream.value"
      :display="memoryGraphDisplay"
      :offloading="!!data.dreamTrace.value.offload?.active"
      :links="data.links.value"
      :phase="data.phase.value"
      @select="data.selected.value = $event"
    />
  </div>
</template>
<style scoped>
.graph-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: auto;
  overflow: hidden;
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
.graph-backdrop :deep(.memory-graph__tools) {
  top: auto;
  bottom: 52px;
  right: 50%;
  transform: translateX(50%);
}
.graph-backdrop :deep(.memory-graph__dream) {
  top: auto;
  bottom: 96px;
  left: 50%;
  transform: translateX(-50%);
}
</style>
