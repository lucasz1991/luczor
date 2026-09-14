<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  localModelDiagnostics,
  localModelDiagnosticCopy,
  LOCAL_FAILURE_STAGE_LABELS,
} from '@/services/inference/localModelDiagnostics'
import { describeLocalFailureDiagnostic } from '@/services/inference/localFailure'
import { useClipboard } from '@/composables/useClipboard'

const { copy, copied, error: clipboardError } = useClipboard()
const canCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'

function clearObservations() {
  localModelDiagnostics.clear()
  selected.value = null
}
const selected = ref<number | null>(null)
const runs = localModelDiagnostics.state.runs
const run = computed(() => runs.find(item => item.id === selected.value) ?? runs[0])
const copiedRunId = ref<number | null>(null)
async function copyDiagnostic() {
  if (!run.value) return
  copiedRunId.value = run.value.id
  copied.value = false
  await copy(localModelDiagnosticCopy(run.value))
}
const number = (value: number | null | undefined, suffix = '') =>
  value == null ? '—' : `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })}${suffix}`
const failureValue = (value: number | string | undefined) =>
  value === undefined ? 'nicht ermittelt' : typeof value === 'number' ? number(value) : value
const labels = {
  preparing: 'Vorbereitung',
  responding: 'Antwortstream',
  done: 'Abgeschlossen',
  cancelled: 'Abgebrochen',
  error: 'Fehlgeschlagen',
}
const roles: Record<string, string> = {
  system: 'System',
  user: 'Nachrichten',
  assistant: 'Antworten',
  tool: 'Werkzeugergebnisse',
}
const roleTotal = computed(() => run.value?.roles.reduce((sum, item) => sum + item.characters, 0) || 1)
const contextPercent = computed(() => {
  const context = run.value?.context
  return context && context.contextTokens > 0
    ? Math.min(100, (context.inputTokens / context.contextTokens) * 100)
    : null
})
const contextTrend = computed(() => {
  let path = ''
  let connected = false
  const values = [...runs].reverse()
  values.forEach((item, index) => {
    if (!item.context?.contextTokens) {
      connected = false
      return
    }
    const used = Math.min(1, item.context.inputTokens / item.context.contextTokens)
    path += `${connected ? 'L' : 'M'}${8 + (index / Math.max(1, values.length - 1)) * 584},${76 - used * 68} `
    connected = true
  })
  return path
})
</script>

<template>
  <section class="model-analysis" aria-label="Lokale Modellanalyse">
    <div class="analysis-heading">
      <label
        >Inferenz
        <select v-model="selected" aria-label="Inferenz auswählen" :disabled="!runs.length">
          <option :value="null">Neueste Anfrage</option>
          <option v-for="item in runs" :key="item.id" :value="item.id">
            {{ new Date(item.startedAt).toLocaleTimeString('de-DE') }} · {{ labels[item.state] }}
          </option>
        </select>
      </label>
      <button type="button" :disabled="!runs.length || run?.remote" @click="clearObservations">Anzeige leeren</button>
    </div>
    <p v-if="!run" class="empty">
      Noch keine Inferenzmesswerte empfangen. Ein geladenes Modell kann auch ohne aktive Anfrage laufen; seine CPU-,
      RAM- und GPU-Werte stehen oben.
    </p>
    <template v-else>
      <div class="run-title">
        <strong>{{ run.model }}</strong
        ><span>{{ labels[run.state] }}</span>
      </div>
      <section v-if="run.state === 'error'" class="analysis-section failure-section" aria-label="Fehlerdiagnose">
        <div class="section-heading">
          <h4>Fehlerdiagnose</h4>
          <button v-if="canCopy" type="button" @click="copyDiagnostic">
            {{ copied && copiedRunId === run.id ? 'Diagnose kopiert' : 'Diagnose kopieren' }}
          </button>
        </div>
        <p class="failure-message">
          {{
            run.failure
              ? describeLocalFailureDiagnostic(run.failure)
              : 'Für diese Anfrage hat die Runtime keine geprüften Fehlerdetails gemeldet.'
          }}
        </p>
        <dl class="diagnostic-list">
          <div>
            <dt>Phase</dt>
            <dd>{{ run.failure ? LOCAL_FAILURE_STAGE_LABELS[run.failure.stage] : 'nicht ermittelt' }}</dd>
          </div>
          <div>
            <dt>HTTP-Status</dt>
            <dd>{{ failureValue(run.failure?.httpStatus) }}</dd>
          </div>
          <div>
            <dt>Fehlercode</dt>
            <dd>{{ failureValue(run.failure?.code) }}</dd>
          </div>
          <div>
            <dt>Parameter</dt>
            <dd>{{ failureValue(run.failure?.parameter) }}</dd>
          </div>
          <div>
            <dt>Eingabetokens</dt>
            <dd>{{ failureValue(run.failure?.inputTokens) }}</dd>
          </div>
          <div>
            <dt>Kontextfenster</dt>
            <dd>{{ failureValue(run.failure?.contextTokens) }}</dd>
          </div>
          <div>
            <dt>Ausgabelimit (Tokens)</dt>
            <dd>{{ failureValue(run.failure?.outputTokens) }}</dd>
          </div>
        </dl>
        <p>
          Erfasste Runtime-Werte. Fehlende Werte bleiben „nicht ermittelt“; sie werden nicht aus Textlängen geschätzt.
        </p>
        <p v-if="clipboardError && copiedRunId === run.id" role="status">{{ clipboardError }}</p>
      </section>
      <dl class="token-grid">
        <div>
          <dt>Eingabe</dt>
          <dd>{{ number(run.usage?.inputTokens) }}</dd>
        </div>
        <div>
          <dt>Ausgabe</dt>
          <dd>{{ number(run.usage?.outputTokens) }}</dd>
        </div>
        <div>
          <dt>Gesamt</dt>
          <dd>{{ number(run.usage?.totalTokens) }}</dd>
        </div>
        <div>
          <dt>Tokens / s</dt>
          <dd>{{ number(run.runtime.outputTokensPerSecond) }}</dd>
        </div>
      </dl>
      <section class="analysis-section" aria-label="Kontextanalyse">
        <div class="section-heading">
          <h4>Kontextfenster</h4>
          <span
            >{{ number(contextPercent, ' %') }} · {{ number(run.context?.inputTokens) }} /
            {{ number(run.context?.contextTokens) }}</span
          >
        </div>
        <div
          class="context-bar"
          role="meter"
          aria-label="Belegter Eingabekontext"
          :aria-valuenow="contextPercent ?? undefined"
          :aria-valuetext="contextPercent === null ? 'Nicht gemeldet' : number(contextPercent, ' Prozent')"
          :aria-valuemin="0"
          :aria-valuemax="100"
        >
          <i :style="{ width: `${contextPercent ?? 0}%` }" />
        </div>
        <p>
          Ausgabe reserviert: {{ number(run.context?.outputTokens) }} Tokens ·
          {{ number(run.context?.omittedMessages) }} Nachrichten ausgelassen ·
          {{ number(run.context?.shortenedToolResults) }} Werkzeugergebnisse gekürzt
        </p>
        <details v-if="run.budget">
          <summary>Kontextzusammenstellung · Schätzung vor Tokenprüfung</summary>
          <dl>
            <dt>Grundregeln</dt><dd>{{ number(run.budget.categories.rules) }} Tokens</dd>
            <dt>Persönlichkeit und passende Skills</dt><dd>{{ number(run.budget.categories.profile) }} Tokens</dd>
            <dt>Projektwissen und Erinnerungen</dt><dd>{{ number(run.budget.categories.knowledge) }} Tokens</dd>
            <dt>Verlauf und Werkzeugergebnisse</dt><dd>{{ number(run.budget.categories.history) }} Tokens</dd>
            <dt>Werkzeugdefinitionen</dt><dd>{{ number(run.budget.categories.tools) }} Tokens</dd>
          </dl>
          <p>{{ number(run.budget.estimatedInputTokens) }} / {{ number(run.budget.targetTokens) }} Tokens Planungsbudget · {{ run.budget.summarizedMessages }} Nachrichten verdichtet · {{ run.budget.shortenedToolResults }} Ergebnisse gekürzt.</p>
          <p v-if="run.budget.overTarget">Pflichtkontext überschreitet das Planungsbudget. Die native Tokenprüfung entscheidet über Anpassung und Fenstererweiterung.</p>
          <p>Schätzwerte einschließlich Nachrichtentext und Tools; die gemessene Tokenzahl und Cache-Wiederverwendung stehen separat oben.</p>
        </details>
        <svg
          v-if="runs.filter(item => item.context).length > 1"
          class="context-trend"
          viewBox="0 0 600 84"
          preserveAspectRatio="none"
          role="img"
          aria-label="Eingabekontext je Inferenz, älteste links, Skala 0 bis 100 Prozent"
        >
          <path class="baseline" d="M8 8H592M8 76H592" />
          <path :d="contextTrend" />
        </svg>
        <details v-if="!run.remote">
          <summary>Zusammensetzung der gesendeten Nachrichten</summary>
          <div v-for="part in run.roles" :key="part.role" class="context-role">
            <span>{{ roles[part.role] }}</span>
            <div><i :style="{ width: `${(part.characters / roleTotal) * 100}%` }" /></div>
            <span>{{ part.messages }} · {{ number(part.characters) }} Zeichen</span>
          </div>
          <p>Vor der nativen Kontextanpassung gezählt. Zeichenanteile sind keine Tokenanteile.</p>
        </details>
      </section>
      <section class="analysis-section">
        <div class="section-heading"><h4>Zwischenspeicher &amp; Laufzeit</h4></div>
        <dl class="diagnostic-list">
          <div>
            <dt>Wiederverwendete Prompt-Tokens</dt>
            <dd>{{ number(run.runtime.cachedTokens) }}</dd>
          </div>
          <div>
            <dt>Gemeldete Reasoning-Tokens</dt>
            <dd>{{ number(run.runtime.reasoningTokens) }}</dd>
          </div>
          <div>
            <dt>Kontextverarbeitung</dt>
            <dd>
              {{ number(run.runtime.promptMs, ' ms') }} · {{ number(run.runtime.promptTokensPerSecond, ' tok/s') }}
            </dd>
          </div>
          <div>
            <dt>Antwortgenerierung</dt>
            <dd>{{ number(run.runtime.predictedMs, ' ms') }}</dd>
          </div>
          <div>
            <dt>Abschluss / Werkzeuganforderungen</dt>
            <dd>{{ run.finishReason || '—' }} / {{ run.toolCount }}</dd>
          </div>
        </dl>
      </section>
      <p v-if="run.remote" class="empty">
        Messwerte aus einem anderen lokalen Chatfenster. Antworttexte und Nachrichten bleiben dort.
      </p>
      <details v-if="!run.remote" class="analysis-section" open>
        <summary>Öffentliche Ausgabe</summary>
        <pre v-if="run.output">{{ run.output }}</pre>
        <p v-else>Noch kein öffentlicher Antworttext empfangen.</p>
        <p v-if="run.outputTruncated">Vorschau auf 24.000 Zeichen begrenzt. Der vollständige Text bleibt im Chat.</p>
      </details>
      <details v-if="!run.remote" class="analysis-section">
        <summary>Ablauf</summary>
        <ol>
          <li v-for="(event, index) in run.events" :key="index">
            <time>{{ new Date(event.at).toLocaleTimeString('de-DE') }}</time> {{ event.label }}
          </li>
        </ol>
      </details>
    </template>
    <p class="measurement-note">
      Bis zu 12 lokale Anfragen, nur in dieser Sitzung. „—“ bedeutet nicht gemeldet. Cachewerte sind gemeldete
      Wiederverwendung, kein Abbild des KV-Speichers. Interne Denktexte und versteckte Prompts werden nicht
      aufgezeichnet.
    </p>
  </section>
</template>

<style scoped>
.model-analysis {
  font-size: 11px;
  padding-bottom: 20px;
}
.analysis-heading,
.run-title,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.analysis-heading {
  margin: 12px 0 22px;
}
.analysis-heading label {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--ai-muted);
}
select,
button {
  font: inherit;
  color: var(--ai-ink);
  background: var(--ai-surface);
  border: 1px solid var(--ai-line);
  border-radius: 5px;
  padding: 6px 8px;
  max-width: 100%;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
:is(button, select, summary):focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 2px;
}
.run-title strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.run-title span,
dt,
p {
  color: var(--ai-muted);
}
.token-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 22px 0;
}
dd {
  margin: 4px 0 0;
  font-variant-numeric: tabular-nums;
}
.token-grid dd {
  font-size: clamp(16px, 2vw, 23px);
}
.analysis-section {
  border-top: 1px solid var(--ai-line);
  padding: 16px 0;
}
.failure-section {
  margin-top: 18px;
}
.failure-message {
  color: var(--ai-ink);
}
h4 {
  font-size: 12px;
  font-weight: 500;
  margin: 0;
}
.section-heading span {
  color: var(--ai-muted);
  font-variant-numeric: tabular-nums;
}
.context-bar {
  height: 5px;
  margin-top: 16px;
  border-radius: 3px;
  background: var(--ai-line);
  overflow: hidden;
}
.context-bar i,
.context-role i {
  display: block;
  height: 100%;
  background: var(--ai-accent);
}
.context-trend {
  width: 100%;
  height: 72px;
  margin: 8px 0;
}
.context-trend path {
  stroke: var(--ai-accent);
  stroke-width: 1.5;
  fill: none;
  vector-effect: non-scaling-stroke;
}
.context-trend .baseline {
  stroke: var(--ai-line);
  stroke-dasharray: 3 4;
}
.context-role {
  display: grid;
  grid-template-columns: 110px 1fr auto;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}
.context-role > div {
  height: 3px;
  background: var(--ai-line);
}
.diagnostic-list {
  display: grid;
  gap: 10px;
  margin-bottom: 0;
}
.diagnostic-list > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.diagnostic-list dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.7 var(--ai-font);
  max-height: 280px;
  overflow: auto;
  margin: 14px 0 0;
}
ol {
  padding-left: 18px;
  line-height: 2;
}
time {
  color: var(--ai-muted);
  margin-right: 8px;
}
p {
  line-height: 1.6;
}
.measurement-note {
  font-size: 10px;
  margin-bottom: 0;
}
.empty {
  padding: 20px 0;
}
@media (max-width: 480px) {
  .token-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .context-role {
    grid-template-columns: 1fr auto;
  }
  .context-role > div {
    grid-column: 1 / -1;
    grid-row: 2;
  }
  .analysis-heading label {
    width: 100%;
  }
  select {
    min-width: 0;
    flex: 1;
  }
}
</style>
