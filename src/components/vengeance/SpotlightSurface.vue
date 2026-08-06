<script setup lang="ts">
import { ref } from 'vue'

const root = ref<HTMLElement | null>(null)

function moveSpotlight(event: PointerEvent) {
  const element = root.value
  if (!element) return

  const bounds = element.getBoundingClientRect()
  element.style.setProperty('--vz-x', `${event.clientX - bounds.left}px`)
  element.style.setProperty('--vz-y', `${event.clientY - bounds.top}px`)
}

function resetSpotlight() {
  const element = root.value
  if (!element) return
  element.style.removeProperty('--vz-x')
  element.style.removeProperty('--vz-y')
}
</script>

<template>
  <div ref="root" class="vz-spotlight" @pointermove.passive="moveSpotlight" @pointerleave="resetSpotlight">
    <div class="vz-spotlight__wash" aria-hidden="true" />
    <div class="vz-spotlight__content">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.vz-spotlight {
  --vz-x: 50%;
  --vz-y: 22%;
  position: relative;
  isolation: isolate;
  overflow: hidden;
}

.vz-spotlight__wash {
  position: absolute;
  inset: 0;
  z-index: -1;
  opacity: 0;
  pointer-events: none;
  background: radial-gradient(460px circle at var(--vz-x) var(--vz-y), rgba(144, 127, 255, 0.12), transparent 48%);
  transition: opacity 260ms ease;
}

.vz-spotlight:hover .vz-spotlight__wash {
  opacity: 1;
}

.vz-spotlight__content {
  position: relative;
  min-width: 0;
  height: 100%;
}

@media (prefers-reduced-motion: reduce) {
  .vz-spotlight__wash {
    display: none;
  }
}
</style>
