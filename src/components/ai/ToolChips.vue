<script setup lang="ts">
import AiIcon from './AiIcon.vue'
import { statusLabels, type ActivityStep } from './types'
import { toolDisplayIcon, toolDisplayLabel } from './toolPresentation'

defineProps<{ tools: ActivityStep[] }>()
</script>

<template>
  <div v-if="tools.length" class="ai-tool-chips" aria-label="Tool-Aufrufe">
    <details v-for="tool in tools" :key="tool.id" class="ai-tool" :data-status="tool.status">
      <summary>
        <AiIcon :name="toolDisplayIcon(tool)" :size="15" class="ai-tool__icon" />
        <span class="ai-tool__identity">
          <span class="ai-tool__label">{{ toolDisplayLabel(tool.label) }}</span>
          <small v-if="tool.summary" class="ai-tool__args" :title="tool.summary">{{ tool.summary }}</small>
          <small v-if="tool.provider || tool.model" class="ai-tool__route">
            {{ [tool.provider, tool.model].filter(Boolean).join(' · ') }}
          </small>
        </span>
        <span class="ai-tool__status"><i aria-hidden="true" />{{ statusLabels[tool.status] }}</span>
        <AiIcon name="chevron" :size="12" class="ai-tool__chevron" />
      </summary>
      <div class="ai-tool__body">
        <p v-if="tool.detail" class="ai-tool__detail">{{ tool.detail }}</p>
        <dl class="ai-tool__metadata">
          <div>
            <dt>Tool</dt>
            <dd>
              <code>{{ tool.label }}</code>
            </dd>
          </div>
          <div v-if="tool.capability">
            <dt>Bereich</dt>
            <dd>{{ tool.capability }}</dd>
          </div>
          <div v-if="tool.provider">
            <dt>Provider</dt>
            <dd>{{ tool.provider }}</dd>
          </div>
          <div v-if="tool.model">
            <dt>Modell</dt>
            <dd>{{ tool.model }}</dd>
          </div>
          <div v-if="tool.dataHandling">
            <dt>Ablage</dt>
            <dd>{{ tool.dataHandling === 'ephemeral' ? 'Temporär' : 'Synchronisierbar' }}</dd>
          </div>
        </dl>
      </div>
    </details>
  </div>
</template>

<style scoped>
.ai-tool-chips {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  min-width: 0;
  margin: 10px 0 16px;
  font-family: var(--ai-font);
  container-type: inline-size;
}
.ai-tool {
  --tool-tone: var(--ai-faint);
  width: 100%;
  border: 0;
  border-radius: 8px;
  background: transparent;
}
.ai-tool[data-status='running'] {
  --tool-tone: var(--ai-accent);
}
.ai-tool[data-status='waiting'] {
  --tool-tone: var(--ai-orange);
}
.ai-tool[data-status='failed'] {
  --tool-tone: var(--ai-red);
}
.ai-tool[data-status='done'] {
  --tool-tone: var(--ai-green);
}
.ai-tool summary {
  position: relative;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto 12px;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 8px 10px;
  list-style: none;
  border-radius: 8px;
  color: var(--ai-muted);
  font-size: 12px;
  line-height: 1.5;
}
.ai-tool[data-status='running'] summary {
  overflow: hidden;
  background: color-mix(in srgb, var(--ai-accent) 7%, transparent);
}
.ai-tool[data-status='running'] summary::after {
  position: absolute;
  right: 10px;
  bottom: 4px;
  left: 10px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--ai-accent), transparent);
  background-size: 42% 100%;
  background-repeat: no-repeat;
  background-position-x: -42%;
  content: '';
  animation: tool-progress-sweep 1.45s ease-in-out infinite;
}
.ai-tool summary::-webkit-details-marker {
  display: none;
}
.ai-tool summary:hover,
.ai-tool[open] summary {
  background: var(--ai-canvas);
}
.ai-tool summary:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 2px;
}
.ai-tool__identity {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.ai-tool__label {
  overflow-wrap: anywhere;
  font-weight: 500;
}
.ai-tool:is([data-status='running'], [data-status='waiting'], [data-status='failed']) .ai-tool__label {
  color: var(--ai-ink);
}
.ai-tool__route {
  color: var(--ai-faint);
  overflow-wrap: anywhere;
  font-size: 10px;
  font-weight: 400;
}
.ai-tool__icon {
  color: var(--ai-faint);
}
.ai-tool:is([data-status='running'], [data-status='waiting'], [data-status='failed']) .ai-tool__icon {
  color: var(--tool-tone);
}
.ai-tool .ai-tool__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--tool-tone);
  font-size: 10px;
  white-space: nowrap;
}
.ai-tool__status i {
  width: 4px;
  height: 4px;
  flex: 0 0 4px;
  border-radius: 50%;
  background: currentColor;
}
.ai-tool[data-status='running'] .ai-tool__status i {
  animation: tool-status-pulse 1.25s ease-out infinite;
}
.ai-tool__chevron {
  color: var(--ai-faint);
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ai-tool[open] .ai-tool__chevron {
  transform: rotate(90deg);
}
.ai-tool__body {
  padding: 8px 12px 14px 38px;
}
.ai-tool__detail {
  max-height: 180px;
  overflow: auto;
  margin: 0 0 10px;
  color: var(--ai-muted);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ai-tool__metadata {
  display: grid;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}
.ai-tool__metadata > div {
  display: grid;
  grid-template-columns: 66px minmax(0, 1fr);
  gap: 12px;
}
.ai-tool__metadata dt {
  color: var(--ai-faint);
}
.ai-tool__metadata dd {
  margin: 0;
  color: var(--ai-muted);
  overflow-wrap: anywhere;
}
.ai-tool__metadata code {
  font: 10px var(--font-mono, monospace);
}
@container (max-width: 340px) {
  .ai-tool summary {
    gap: 7px;
    padding-inline: 6px;
  }
  .ai-tool .ai-tool__status {
    font-size: 9px;
  }
  .ai-tool__status i {
    display: none;
  }
  .ai-tool__body {
    padding-left: 31px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-tool[data-status='running'] summary::after,
  .ai-tool[data-status='running'] .ai-tool__status i {
    animation: none;
  }
  .ai-tool__chevron {
    transition: none;
  }
}
:global(html[data-reduce-motion='1']) .ai-tool__chevron {
  transition: none;
}
:global(html[data-reduce-motion='1']) .ai-tool[data-status='running'] summary::after,
:global(html[data-reduce-motion='1']) .ai-tool[data-status='running'] .ai-tool__status i {
  animation: none;
}
@keyframes tool-progress-sweep {
  to {
    background-position-x: 142%;
  }
}
@keyframes tool-status-pulse {
  70% {
    box-shadow: 0 0 0 6px color-mix(in srgb, currentColor 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 0%, transparent);
  }
}
</style>
