<script setup lang="ts">
import { hud, setKillSwitch } from '@/state/hud'
import AiIcon from './ai/AiIcon.vue'
</script>
<template>
  <button
    type="button"
    class="system-stop"
    :class="{ 'is-stopped': hud.killSwitch }"
    :aria-pressed="hud.killSwitch"
    :aria-label="hud.killSwitch ? 'Tools freigeben' : 'Not-Aus'"
    @click="setKillSwitch(!hud.killSwitch)"
  >
    <AiIcon :name="hud.killSwitch ? 'shield' : 'stop'" :size="14" />{{ hud.killSwitch ? 'Freigeben' : 'Not-Aus' }}
  </button>
</template>
<style scoped>
.system-stop {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  flex-shrink: 0;
  border: 1px solid var(--ai-line-strong);
  color: var(--ai-red);
  background: transparent;
  padding: 8px 10px;
  border-radius: 6px;
  font: 11px/1.4 var(--ai-font);
  cursor: pointer;
}
.system-stop:hover,
.system-stop.is-stopped {
  border-color: var(--ai-red);
  background: color-mix(in srgb, var(--ai-red) 9%, transparent);
}
.system-stop:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 3px;
}
</style>
