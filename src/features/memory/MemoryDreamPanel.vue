<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DreamView } from './MemoryGraphView.vue'
import {
  DREAM_OPERATION_LABELS,
  DREAM_SKIP_LABELS,
  DREAM_STAGE_LABELS,
  dreamTargetLabel,
  type DreamRun,
  type DreamStep,
  type DreamTarget,
  type DreamTrace,
} from '@/services/memory/dreamTrace'
import {
  idleOptimizationEnabled,
  idleOptimizationStatus,
  idleOptimizationBlocker,
  requestIdleOptimization,
  saveIdleOptimizationSetting,
} from '@/services/agents/idleOptimization'
import { maintenanceProgress } from '@/services/agents/idleMaintenanceWorker'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'

const props = defineProps<{ dream: DreamView; trace: DreamTrace; projectId: string }>()
const emit = defineEmits<{ focus: [target: DreamTarget] }>()

const PHASES: Record<string, string> = {
  stopped: 'Aus',
  waiting: 'Wartet auf Leerlauf',
  paused: 'Pausiert',
  running: 'Träumt',
  committing: 'Übernimmt',
  yielding: 'Macht Platz',
  cooldown: 'Ruht kurz',
}
const REASONS: Record<string, string> = {
  ...DREAM_SKIP_LABELS,
  gathering_sources: 'Quellen werden gesammelt',
  no_context: 'Nichts zu pflegen',
  invalid_context: 'Auftrag verworfen',
  unchanged_context: 'Unverändert seit dem letzten Lauf',
  candidate_ready: 'Ergebnis übernommen',
  failed: 'Lauf fehlgeschlagen',
  timeout: 'Zeitlimit erreicht',
  activity: 'Eingabe erkannt',
  interrupted: 'Unterbrochen',
  memory_changed: 'Gedächtnis hat sich geändert',
  settings_changed: 'Einstellungen geändert',
}

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const status = computed(() => idleOptimizationStatus.value)
const phaseLabel = computed(() => {
  if (!idleOptimizationEnabled.value) return 'Aus'
  return PHASES[status.value?.phase ?? ''] ?? 'Nicht verfügbar'
})
const reasonLabel = computed(() => {
  const reason = status.value?.reason ?? props.trace.lastSkip?.reason
  // `reason` comes from the optimizer's fixed reason codes, not from user input.
  // eslint-disable-next-line security/detect-object-injection
  return reason ? (REASONS[reason] ?? reason) : ''
})
const countdown = computed(() => {
  const next = status.value?.nextCheckAt
  if (!next || next <= now.value) return ''
  const seconds = Math.round((next - now.value) / 1000)
  return seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${seconds} s`
})
const run = computed<DreamRun | null>(() => props.dream.run)
const running = computed(() => props.dream.active)
const showHistory = ref(false)
const busy = ref(false)
const message = ref('')
const messageTone = ref<'info' | 'error'>('info')

/** Failure codes from the worker, the parsers and the local runtime, in plain language. */
const FAILURES: Record<string, string> = {
  output_truncated: 'Antwort am Ausgabelimit (768 Tokens) abgeschnitten – Quellen werden jetzt kleiner gebündelt',
  incomplete_candidate: 'Modell hat keine vollständige Antwort geliefert',
  invalid_candidate: 'Antwort leer oder zu lang',
  runtime_context_exceeded: 'Kontextfenster des Modells zu klein für die Quellen – Bündel werden ans Fenster angepasst',
  lost_reference: 'Belege (Pfad, ID oder Zahl) gingen beim Umschreiben verloren',
  fabricated_reference: 'Ergebnis nennt Pfade oder Bezeichner, die nicht in den Quellen stehen',
  verification_rejected: 'Gegenprüfung hat den Vorschlag abgelehnt',
  incomplete_verification: 'Gegenprüfung hat nicht alle Quellen bestätigt',
  invalid_verification: 'Gegenprüfung antwortete nicht im erwarteten JSON',
  invalid_maintenance_json: 'Antwort war kein gültiges JSON',
  invalid_operations: 'Änderungsliste leer oder zu lang',
  invalid_operation: 'Unbekannte Operation in der Änderungsliste',
  invalid_targets: 'Ziele der Operation passen nicht zur Art',
  invalid_content: 'Inhalt oder Begründung fehlt bzw. zu lang',
  missing_evidence: 'Operation ohne Quellenangabe',
  fabricated_source: 'Antwort verweist auf unbekannte Quell-IDs',
  overlapping_targets: 'Mehrere Operationen auf dieselbe Erinnerung',
  installed_model_required: 'Kein installiertes lokales Modell verfügbar',
  local_only_required: 'Nur ein lokales Modell darf träumen',
  idle_model_not_ready: 'Lokales Modell noch nicht bereit',
  scope_changed: 'Konto, Projekt oder Sitzung haben gewechselt',
  stale_source: 'Quellen haben sich während des Laufs geändert',
  stale_job: 'Auftrag wurde inzwischen ersetzt',
  quality_gate_required: 'Automatisches Umschreiben ist noch nicht freigegeben (Modelltest)',
  adapter_write_unsupported: 'Diese Erinnerungen dürfen lokal nicht umgeschrieben werden',
  sensitive_candidate: 'Ergebnis enthielt sensible Daten',
  memory_disabled: 'Automatisches Erinnern ist ausgeschaltet',
  timeout: 'Zeitlimit überschritten',
  resource_background_unavailable: 'Modell war belegt',
}
function failureLabel(code: string | undefined): string {
  if (!code) return 'Unbekannter Fehler'
  // `code` is a fixed identifier from our own parsers/runtime, not user input.
  // eslint-disable-next-line security/detect-object-injection
  return FAILURES[code] ?? code
}
const retrying = ref(false)
/** Failed jobs are parked after three attempts; after a fix the user can queue them again. */
async function retryBlocked() {
  retrying.value = true
  message.value = ''
  try {
    const account = await getVerifiedAccountSnapshot()
    if (!account) throw new Error('no_account')
    let released = 0
    await luczorMemory.updateMaintenance(account.principalId, journal => {
      for (const job of journal.jobs) {
        if (job.status !== 'blocked' || job.blockedReason === 'source_too_large') continue
        job.status = 'pending'
        job.attempts = 0
        job.nextAttemptAt = Date.now()
        job.updatedAt = Date.now()
        released++
      }
      if (journal.quality && !journal.quality.passed) journal.evaluationRequested = Date.now()
    })
    message.value = released
      ? `${released} blockierte Aufträge wieder eingereiht.`
      : 'Keine blockierten Aufträge vorhanden.'
    messageTone.value = 'info'
  } catch {
    message.value = 'Blockierte Aufträge konnten nicht freigegeben werden.'
    messageTone.value = 'error'
  } finally {
    retrying.value = false
  }
}

const TASKS: Record<DreamRun['task'], string> = {
  context: 'Kontextpaket',
  memory: 'Erinnerungen verdichten',
  repository: 'Repository-Wissen',
  evaluation: 'Modelltest',
  shared: 'Gemeinsame Pflege',
}

function time(at: number) {
  return new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function duration(item: DreamRun) {
  const end = item.endedAt ?? now.value
  const seconds = Math.max(0, Math.round((end - item.startedAt) / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`
}
/** Stage label plus detail, without repeating a title that already names the stage. */
function stepSubtitle(step: DreamStep): string {
  const stage = DREAM_STAGE_LABELS[step.stage]
  return [stage !== step.title ? stage : '', step.detail ?? ''].filter(Boolean).join(' · ')
}
/** Counts affected entries, not decision rows: one merge over two memories reads as two. */
function decisionCount(item: DreamRun, op: string) {
  return item.decisions
    .filter(decision => decision.op === op)
    .reduce((sum, decision) => sum + Math.max(1, decision.targets.length), 0)
}

const BLOCKERS: Record<string, string> = {
  unmounted: 'Die Leerlauf-Pflege ist in diesem Fenster nicht eingebunden.',
  disabled: 'Die Leerlauf-Pflege konnte nicht eingeschaltet werden.',
  active: 'Es läuft bereits eine Prüfung oder ein Traum.',
  foreground: 'Ein Auftrag im Vordergrund hält das Modell – bitte warten, bis er fertig ist.',
}
/** Set after a manual request; the next status change tells us whether the pass got admitted. */
const requestedAt = ref(0)
watch(
  () => [status.value?.phase, status.value?.reason] as const,
  ([phase, reason]) => {
    if (!requestedAt.value || Date.now() - requestedAt.value > 60_000) return
    if (phase === 'running' || phase === 'committing') {
      message.value = 'Der Traum läuft – Schritte und Entscheidungen erscheinen unten und in der Karte.'
      messageTone.value = 'info'
      requestedAt.value = 0
    } else if (phase === 'paused' || phase === 'cooldown') {
      // The pass was admitted and finished, or an eligibility gate declined it: show which one.
      // eslint-disable-next-line security/detect-object-injection
      const why = reason ? (REASONS[reason] ?? reason) : ''
      const ok = reason === 'candidate_ready'
      message.value = ok
        ? 'Traum abgeschlossen und übernommen.'
        : `Traum nicht gestartet: ${why || 'Voraussetzung fehlt'}.`
      messageTone.value = ok ? 'info' : 'error'
      requestedAt.value = 0
    }
  }
)
async function startDream() {
  message.value = ''
  busy.value = true
  try {
    if (!idleOptimizationEnabled.value) {
      await saveIdleOptimizationSetting(true)
      // The optimizer starts from a watcher; let that flush before asking it for a pass.
      await nextTick()
    }
    // The manual request goes through the same eligibility and local-only gates as scheduled runs,
    // but counts as consent to start the installed model and tolerates a busy CPU.
    if (requestIdleOptimization()) {
      requestedAt.value = Date.now()
      message.value = 'Traum angefordert – Voraussetzungen werden geprüft …'
      messageTone.value = 'info'
    } else {
      const blocker = idleOptimizationBlocker() ?? 'active'
      // eslint-disable-next-line security/detect-object-injection
      message.value = BLOCKERS[blocker] ?? 'Träumen ist gerade nicht möglich.'
      messageTone.value = 'error'
    }
  } catch {
    message.value = 'Die Einstellung konnte nicht gespeichert werden.'
    messageTone.value = 'error'
  } finally {
    busy.value = false
  }
}
async function stopDreaming() {
  busy.value = true
  message.value = ''
  try {
    await saveIdleOptimizationSetting(false)
    message.value = 'Leerlauf-Pflege ausgeschaltet.'
    messageTone.value = 'info'
  } catch {
    message.value = 'Die Einstellung konnte nicht gespeichert werden.'
    messageTone.value = 'error'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="dream-panel" :class="{ 'is-running': running }" aria-label="Träumen · Leerlauf-Pflege">
    <header class="dream-panel__head">
      <div class="dream-panel__title">
        <span class="dream-panel__orb" aria-hidden="true" />
        <div>
          <h3>Träumen</h3>
          <p>
            {{ phaseLabel }}<template v-if="reasonLabel"> · {{ reasonLabel }}</template
            ><template v-if="countdown && !running"> · nächste Prüfung in {{ countdown }}</template>
          </p>
        </div>
      </div>
      <div class="dream-panel__actions">
        <button
          type="button"
          class="ai-button ai-button--primary"
          :disabled="busy || running"
          :title="
            running
              ? 'Ein Traum läuft bereits'
              : 'Startet die Leerlauf-Pflege sofort – lokal, ohne Werkzeuge, mit denselben Schutzregeln'
          "
          @click="startDream"
        >
          {{ running ? 'Träumt …' : 'Jetzt träumen' }}
        </button>
        <button
          v-if="idleOptimizationEnabled"
          type="button"
          class="ai-button"
          :disabled="busy"
          title="Leerlauf-Pflege ausschalten"
          @click="stopDreaming"
        >
          Aus
        </button>
        <button
          v-if="maintenanceProgress.blocked > 0"
          type="button"
          class="ai-button"
          :disabled="retrying || running"
          title="Nach drei Fehlversuchen geparkte Aufträge wieder einreihen"
          @click="retryBlocked"
        >
          {{ maintenanceProgress.blocked }} blockierte erneut
        </button>
      </div>
    </header>
    <p v-if="message" role="status" class="dream-panel__message" :data-tone="messageTone">{{ message }}</p>

    <dl class="dream-panel__stats" aria-label="Pflegezustand">
      <div>
        <dt>Abgeschlossen</dt>
        <dd>{{ status?.completed ?? 0 }}</dd>
      </div>
      <div>
        <dt>Warteschlange</dt>
        <dd>{{ trace.scan?.queued ?? maintenanceProgress.queued }}</dd>
      </div>
      <div>
        <dt>Geprüft</dt>
        <dd>{{ maintenanceProgress.checked }}</dd>
      </div>
      <div>
        <dt>Geändert</dt>
        <dd>{{ maintenanceProgress.changed }}</dd>
      </div>
      <div>
        <dt>Modell</dt>
        <dd class="dream-panel__mono">{{ run?.modelId || maintenanceProgress.modelId || '—' }}</dd>
      </div>
    </dl>

    <div v-if="run" class="dream-panel__run">
      <div class="dream-panel__run-head">
        <strong>{{ TASKS[run.task] }}</strong>
        <span
          >{{ run.scope === 'project' ? 'Projekt' : 'Konto' }} · {{ time(run.startedAt) }} · {{ duration(run) }}
          <template v-if="run.outcome">
            · {{ run.outcome === 'success' ? 'übernommen' : run.outcome === 'failed' ? 'verworfen' : 'unterbrochen' }}
          </template></span
        >
      </div>
      <ol class="dream-panel__steps" aria-label="Schritte">
        <li
          v-for="(step, index) in run.steps"
          :key="index"
          :data-stage="step.stage"
          :class="{ 'is-current': running && index === run.steps.length - 1 }"
        >
          <span class="dream-panel__step-dot" aria-hidden="true" />
          <span class="dream-panel__step-title">{{ step.title }}</span>
          <small v-if="stepSubtitle(step)">{{ stepSubtitle(step) }}</small>
          <time>{{ time(step.at) }}</time>
        </li>
      </ol>
      <div v-if="run.decisions.length" class="dream-panel__decisions">
        <h4>
          Entscheidungen
          <small
            >{{ decisionCount(run, 'read') }} gelesen · {{ decisionCount(run, 'keep') }} behalten ·
            {{ decisionCount(run, 'merge') + decisionCount(run, 'rewrite') }} verdichtet ·
            {{ decisionCount(run, 'remove') }} ersetzt · {{ decisionCount(run, 'create') }} neu</small
          >
        </h4>
        <ul>
          <li v-for="(decision, index) in run.decisions" :key="index" :data-op="decision.op">
            <span class="dream-panel__op">{{ DREAM_OPERATION_LABELS[decision.op] }}</span>
            <span class="dream-panel__targets">
              <button
                v-for="target in decision.targets"
                :key="target.kind + target.id"
                type="button"
                :title="`${target.kind} · ${target.id}`"
                @click="emit('focus', target)"
              >
                {{ dreamTargetLabel(target) }}
              </button>
            </span>
            <small v-if="decision.reason">{{ decision.reason }}</small>
          </li>
        </ul>
      </div>
      <p v-if="run.outcome === 'failed'" class="dream-panel__error">
        Fehlgeschlagen: {{ failureLabel(run.error) }}<small v-if="run.error"> · {{ run.error }}</small>
      </p>
    </div>
    <p v-else class="dream-panel__empty">
      Noch kein Traum in dieser Sitzung. Im Leerlauf sichtet die lokale KI Erinnerungen, Kontextpakete und den
      Repository-Graphen, verdichtet Belegtes und ersetzt Doppeltes – jeder Schritt erscheint hier und in der Karte.
    </p>

    <details
      v-if="trace.history.length > (run && !run.endedAt ? 0 : 1)"
      class="dream-panel__history"
      :open="showHistory"
    >
      <summary @click.prevent="showHistory = !showHistory">Frühere Träume ({{ trace.history.length }})</summary>
      <ul>
        <li v-for="item in trace.history" :key="item.id">
          <span :data-outcome="item.outcome">{{
            item.outcome === 'success' ? 'übernommen' : item.outcome === 'failed' ? 'verworfen' : 'unterbrochen'
          }}</span>
          <strong>{{ TASKS[item.task] }}</strong>
          <small
            >{{ time(item.startedAt) }} · {{ duration(item) }} · {{ item.decisions.length }} Entscheidungen<template
              v-if="item.modelId"
            >
              · {{ item.modelId }}</template
            ></small
          >
        </li>
      </ul>
    </details>
  </section>
</template>
<style scoped>
.dream-panel {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--ai-line);
  border-radius: 12px;
  background: var(--ai-surface);
  display: grid;
  gap: 14px;
  transition: border-color 600ms var(--ease, ease);
}
.dream-panel.is-running {
  border-color: color-mix(in srgb, var(--ai-accent) 45%, var(--ai-line));
}
.dream-panel__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.dream-panel__title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dream-panel__title h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.dream-panel__title p {
  margin: 2px 0 0;
  color: var(--ai-muted);
  font-size: 11.5px;
}
.dream-panel__orb {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex-shrink: 0;
  background: radial-gradient(circle at 35% 35%, color-mix(in srgb, var(--ai-accent) 90%, white), var(--ai-accent) 70%);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--ai-accent) 40%, transparent);
  opacity: 0.55;
  transition: opacity 600ms var(--ease, ease);
}
.is-running .dream-panel__orb {
  opacity: 1;
  animation: dream-orb-pulse 2s ease-out infinite;
}
@keyframes dream-orb-pulse {
  to {
    box-shadow: 0 0 0 12px transparent;
  }
}
.dream-panel__actions {
  display: flex;
  gap: 8px;
}
.dream-panel__message {
  margin: 0;
  padding: 8px 12px;
  border-left: 2px solid var(--ai-accent);
  background: var(--ai-page);
  font-size: 12px;
}
.dream-panel__message[data-tone='error'] {
  border-left-color: var(--ai-orange, #e6a23c);
}
.dream-panel__stats {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 8px;
}
.dream-panel__stats > div {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--ai-page);
  min-width: 0;
}
.dream-panel__stats dt {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ai-faint);
}
.dream-panel__stats dd {
  margin: 2px 0 0;
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dream-panel__mono {
  font: 500 11px var(--font-mono, monospace) !important;
}
.dream-panel__run {
  display: grid;
  gap: 12px;
}
.dream-panel__run-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.dream-panel__run-head span {
  color: var(--ai-muted);
}
.dream-panel__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
  position: relative;
}
.dream-panel__steps li {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  grid-template-areas:
    'dot title time'
    'dot detail time';
  column-gap: 10px;
  align-items: center;
  padding: 5px 0;
  font-size: 12px;
  position: relative;
}
.dream-panel__steps li::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ai-line);
}
.dream-panel__steps li:first-child::before {
  top: 50%;
}
.dream-panel__steps li:last-child::before {
  bottom: 50%;
}
.dream-panel__step-dot {
  grid-area: dot;
  width: 9px;
  height: 9px;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--ai-accent);
  position: relative;
  z-index: 1;
}
li[data-stage='failed'] .dream-panel__step-dot,
li[data-stage='interrupted'] .dream-panel__step-dot {
  background: var(--ai-orange, #e6a23c);
}
li[data-stage='done'] .dream-panel__step-dot {
  background: var(--ai-green, #34c38f);
}
li.is-current .dream-panel__step-dot {
  animation: dream-step 1.4s ease-out infinite;
}
@keyframes dream-step {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ai-accent) 50%, transparent);
  }
  100% {
    box-shadow: 0 0 0 8px transparent;
  }
}
.dream-panel__step-title {
  grid-area: title;
  font-weight: 500;
}
.dream-panel__steps small {
  grid-area: detail;
  color: var(--ai-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dream-panel__steps time {
  grid-area: time;
  color: var(--ai-faint);
  font: 10.5px var(--font-mono, monospace);
}
.dream-panel__decisions h4 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.dream-panel__decisions h4 small {
  color: var(--ai-muted);
  font-weight: 400;
  font-size: 11px;
}
.dream-panel__decisions ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  max-height: 260px;
  overflow: auto;
}
.dream-panel__decisions li {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 2px 10px;
  align-items: start;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--ai-page);
  font-size: 11.5px;
}
.dream-panel__decisions li small {
  grid-column: 2;
  color: var(--ai-muted);
}
.dream-panel__op {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--ai-accent) 18%, transparent);
  color: var(--ai-ink);
  justify-self: start;
}
li[data-op='remove'] .dream-panel__op {
  background: color-mix(in srgb, var(--ai-muted) 30%, transparent);
}
li[data-op='create'] .dream-panel__op {
  background: color-mix(in srgb, var(--ai-green, #34c38f) 26%, transparent);
}
li[data-op='conflict'] .dream-panel__op {
  background: color-mix(in srgb, var(--ai-orange, #e6a23c) 30%, transparent);
}
li[data-op='keep'] .dream-panel__op,
li[data-op='read'] .dream-panel__op {
  background: var(--ai-hover);
}
.dream-panel__targets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.dream-panel__targets button {
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  background: transparent;
  color: var(--ai-ink);
  font: 11px var(--ai-font);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dream-panel__targets button:hover {
  border-color: var(--ai-accent);
}
.dream-panel__error,
.dream-panel__empty {
  margin: 0;
  color: var(--ai-muted);
  font-size: 12px;
  line-height: 1.55;
}
.dream-panel__error {
  color: var(--ai-orange, #e6a23c);
}
.dream-panel__history summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--ai-muted);
  min-height: 32px;
  display: flex;
  align-items: center;
}
.dream-panel__history ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.dream-panel__history li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0 10px;
  font-size: 11.5px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--ai-page);
}
.dream-panel__history li small {
  grid-column: 2;
  color: var(--ai-muted);
}
.dream-panel__history li span {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  align-self: start;
  background: var(--ai-hover);
}
.dream-panel__history li span[data-outcome='success'] {
  background: color-mix(in srgb, var(--ai-green, #34c38f) 26%, transparent);
}
.dream-panel__history li span[data-outcome='failed'] {
  background: color-mix(in srgb, var(--ai-orange, #e6a23c) 30%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .is-running .dream-panel__orb,
  li.is-current .dream-panel__step-dot {
    animation: none;
  }
}
</style>
