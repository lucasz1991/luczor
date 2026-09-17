<script setup lang="ts">
import { computed, ref } from 'vue'
import AiIcon from './ai/AiIcon.vue'
import type { ActivityStep as ToolChip } from './ai/types'
import { statusLabels } from './ai/types'
import { estimatePromptTokens, type PromptFragment } from '@/services/prompt/promptContextAssembler'
import {
  CONTEXT_EGRESS_LABELS,
  CONTEXT_OMISSION_LABELS,
  CONTEXT_SOURCE_LABELS,
  CONTEXT_SOURCE_ORDER,
  CONTEXT_TRUST_LABELS,
  fragmentTitle,
  type ContextSnapshot,
} from '@/services/contextInspector'

const props = withDefaults(
  defineProps<{
    snapshot: ContextSnapshot | null
    busy?: boolean
    error?: string
    /** Tool calls of the run this snapshot belongs to (run mode only). */
    tools?: ToolChip[]
    emptyHint: string
  }>(),
  { busy: false, error: '', tools: () => [] }
)

// Which egress view to inspect: what the local model receives vs. what an external provider would.
const target = ref<'local' | 'external'>('local')
const pkg = computed(() => (props.snapshot ? props.snapshot[target.value] : null))
const selectedIds = computed(() => new Set(pkg.value?.selected.map(item => item.id) ?? []))
const omittedById = computed(() => new Map(pkg.value?.omitted.map(item => [item.id, item.reason]) ?? []))
const groups = computed(() => {
  const snapshot = props.snapshot
  if (!snapshot) return []
  return CONTEXT_SOURCE_ORDER.map(source => ({
    source,
    // `source` iterates the closed PromptFragmentSource union, not user input.
    // eslint-disable-next-line security/detect-object-injection
    label: CONTEXT_SOURCE_LABELS[source],
    fragments: snapshot.fragments
      .filter(fragment => fragment.source === source)
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0)),
  })).filter(group => group.fragments.length)
})
const includedCount = computed(() => pkg.value?.selected.length ?? 0)
const tokens = computed(() => (pkg.value ? estimatePromptTokens(pkg.value.text) : 0))
const stamp = computed(() =>
  props.snapshot
    ? new Date(props.snapshot.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : ''
)
function state(fragment: PromptFragment): { label: string; tone: 'in' | 'out' } {
  if (selectedIds.value.has(fragment.id)) return { label: 'enthalten', tone: 'in' }
  const reason = omittedById.value.get(fragment.id)
  // `reason` is one of the broker's fixed ContextOmissionReason values.
  // eslint-disable-next-line security/detect-object-injection
  return { label: reason ? (CONTEXT_OMISSION_LABELS[reason] ?? reason) : 'nicht enthalten', tone: 'out' }
}
const showRaw = ref(false)
</script>

<template>
  <section class="context-inspector" aria-live="polite">
    <div class="context-inspector__bar">
      <div class="context-inspector__target" role="group" aria-label="Ziel">
        <button type="button" :aria-pressed="target === 'local'" @click="target = 'local'">Lokales Modell</button>
        <button type="button" :aria-pressed="target === 'external'" @click="target = 'external'">Extern</button>
      </div>
      <span v-if="busy" class="context-inspector__busy">wird zusammengestellt …</span>
      <span v-else-if="snapshot" class="context-inspector__stamp">{{ stamp }}</span>
    </div>

    <p v-if="error" class="context-inspector__error" role="alert">{{ error }}</p>
    <p v-else-if="!snapshot" class="context-inspector__empty">{{ emptyHint }}</p>

    <template v-else>
      <dl class="context-inspector__stats">
        <div>
          <dt>Fragmente</dt>
          <dd>{{ includedCount }} / {{ snapshot.fragments.length }}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>≈ {{ tokens.toLocaleString('de-DE') }}</dd>
        </div>
        <div>
          <dt>Zeichen</dt>
          <dd>{{ pkg?.charCount.toLocaleString('de-DE') }} / {{ pkg?.budget.maxChars.toLocaleString('de-DE') }}</dd>
        </div>
        <div>
          <dt>Aufgabe</dt>
          <dd>{{ snapshot.taskType }}</dd>
        </div>
      </dl>
      <p v-if="snapshot.kind === 'preview' && !snapshot.prompt" class="context-inspector__hint">
        Noch keine Eingabe – das ist der Grundkontext. Treffer zur Anfrage kommen mit dem Entwurf dazu.
      </p>

      <div v-for="group in groups" :key="group.source" class="context-inspector__group">
        <h4>
          <span>{{ group.label }}</span>
          <small
            >{{ group.fragments.filter(fragment => selectedIds.has(fragment.id)).length }}/{{
              group.fragments.length
            }}</small
          >
        </h4>
        <details
          v-for="fragment in group.fragments"
          :key="fragment.id"
          class="context-fragment"
          :data-state="state(fragment).tone"
        >
          <summary>
            <AiIcon name="chevron" :size="11" class="context-fragment__chevron" />
            <span class="context-fragment__title">{{ fragmentTitle(fragment) }}</span>
            <span class="context-fragment__badge" :data-tone="state(fragment).tone">{{ state(fragment).label }}</span>
          </summary>
          <div class="context-fragment__meta">
            <span>{{ CONTEXT_TRUST_LABELS[fragment.trust] }}</span>
            <span>{{ CONTEXT_EGRESS_LABELS[fragment.egress] }}</span>
            <span v-if="fragment.priority !== undefined">Priorität {{ fragment.priority }}</span>
            <span v-if="fragment.provenance?.staleness">{{ fragment.provenance.staleness }}</span>
            <span v-if="fragment.provenance?.confidence !== undefined"
              >Konfidenz {{ Math.round((fragment.provenance.confidence ?? 0) * 100) }} %</span
            >
          </div>
          <pre class="context-fragment__body">{{ fragment.content }}</pre>
        </details>
      </div>

      <div v-if="snapshot.kind === 'run'" class="context-inspector__group">
        <h4>
          <span>Werkzeuge in diesem Lauf</span>
          <small>{{ tools.length }}</small>
        </h4>
        <p v-if="!tools.length" class="context-inspector__empty">Keine Werkzeugaufrufe.</p>
        <details v-for="tool in tools" :key="tool.id" class="context-fragment" :data-status="tool.status">
          <summary>
            <AiIcon name="chevron" :size="11" class="context-fragment__chevron" />
            <span class="context-fragment__title">{{ tool.label }}</span>
            <span class="context-fragment__badge" :data-tone="tool.status === 'failed' ? 'out' : 'in'">{{
              statusLabels[tool.status]
            }}</span>
          </summary>
          <div v-if="tool.summary || tool.provider || tool.model" class="context-fragment__meta">
            <span v-if="tool.summary">{{ tool.summary }}</span>
            <span v-if="tool.provider">{{ tool.provider }}</span>
            <span v-if="tool.model">{{ tool.model }}</span>
          </div>
          <pre class="context-fragment__body">{{ tool.detail || 'Kein Ergebnis hinterlegt.' }}</pre>
        </details>
      </div>

      <details
        class="context-inspector__raw"
        :open="showRaw"
        @toggle="showRaw = ($event.target as HTMLDetailsElement).open"
      >
        <summary>Übergebener Kontextblock ({{ target === 'local' ? 'lokal' : 'extern' }})</summary>
        <pre>{{ pkg?.text || '— leer —' }}</pre>
      </details>
    </template>
  </section>
</template>

<style scoped>
.context-inspector {
  display: grid;
  gap: 12px;
  min-width: 0;
  font: 12px/1.5 var(--ai-font);
  color: var(--ai-ink);
}
.context-inspector__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.context-inspector__target {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ai-line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ai-canvas) 70%, transparent);
}
.context-inspector__target button {
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ai-faint);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.context-inspector__target button[aria-pressed='true'] {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.context-inspector__busy,
.context-inspector__stamp {
  color: var(--ai-faint);
  font: 10.5px var(--font-mono, monospace);
}
.context-inspector__error {
  margin: 0;
  color: var(--ai-orange);
}
.context-inspector__empty,
.context-inspector__hint {
  margin: 0;
  color: var(--ai-muted);
  font-size: 11.5px;
  line-height: 1.55;
}
.context-inspector__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
  margin: 0;
}
.context-inspector__stats div {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}
.context-inspector__stats dt {
  color: var(--ai-muted);
  font-size: 10.5px;
}
.context-inspector__stats dd {
  margin: 0;
  overflow: hidden;
  font: 500 10.5px var(--font-mono, monospace);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.context-inspector__group {
  display: grid;
  gap: 4px;
}
.context-inspector__group h4 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 0 2px;
  color: var(--ai-muted);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.context-inspector__group h4 small {
  font: 10px var(--font-mono, monospace);
  color: var(--ai-faint);
  letter-spacing: 0;
}
.context-fragment {
  min-width: 0;
  border: 1px solid var(--ai-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ai-ink) 3%, transparent);
}
.context-fragment[data-state='out'] {
  opacity: 0.6;
}
.context-fragment summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
  list-style: none;
  cursor: pointer;
}
.context-fragment summary::-webkit-details-marker {
  display: none;
}
.context-fragment__chevron {
  color: var(--ai-faint);
  transition: transform 200ms var(--ease, ease);
}
.context-fragment[open] .context-fragment__chevron {
  transform: rotate(90deg);
}
.context-fragment__title {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.context-fragment__badge {
  padding: 1px 7px;
  border-radius: 999px;
  font: 9.5px var(--font-mono, monospace);
  white-space: nowrap;
}
.context-fragment__badge[data-tone='in'] {
  color: var(--ai-green);
  background: color-mix(in srgb, var(--ai-green) 14%, transparent);
}
.context-fragment__badge[data-tone='out'] {
  color: var(--ai-orange);
  background: color-mix(in srgb, var(--ai-orange) 14%, transparent);
}
.context-fragment__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 0 9px 6px;
  color: var(--ai-faint);
  font: 10px var(--font-mono, monospace);
}
.context-fragment__body,
.context-inspector__raw pre {
  max-height: 260px;
  margin: 0;
  padding: 8px 9px 9px;
  overflow: auto;
  border-top: 1px solid var(--ai-line);
  color: var(--ai-muted);
  font: 11px/1.6 var(--font-mono, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.context-inspector__raw {
  border-top: 1px solid var(--ai-line);
  padding-top: 8px;
  color: var(--ai-muted);
}
.context-inspector__raw summary {
  cursor: pointer;
  font-size: 11px;
}
.context-inspector__raw pre {
  margin-top: 8px;
  border: 1px solid var(--ai-line);
  border-radius: 10px;
  max-height: 360px;
}
</style>
