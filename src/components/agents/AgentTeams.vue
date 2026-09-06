<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { agentTeams, agentTeamsRevision, prepareAgentTeam } from '@/services/agents/teamHub'
import {
  createStandardAgentTeamDefinition,
  type AgentTeamErrorCode,
  type AgentTeamNodeStatus,
  type AgentTeamRunStatus,
} from '@/services/agents/teams'
import type { AgentPermission, AgentProjectSnapshot } from '@/services/agents/types'
import type { ModelAgentId } from '@/services/agents/modelAgent'
import type { LuczorMode } from '@/services/inference/types'

type AdapterId = 'codex' | ModelAgentId
type ModelOption = Readonly<{ id: ModelAgentId; label: string; available: boolean }>

const props = defineProps<{
  project: AgentProjectSnapshot
  mode: LuczorMode
  killSwitch: boolean
  codexAvailable: boolean
  modelOptions: readonly ModelOption[]
}>()

const objective = ref('')
const planner = ref<AdapterId>('local')
const implementer = ref<AdapterId>('codex')
const reviewer = ref<AdapterId>('local')
const implementerPermission = ref<AgentPermission>('read-only')
const approvalMode = ref<'team' | 'per-node'>('team')
const error = ref('')
const notice = ref('')

const runs = computed(() => {
  void agentTeamsRevision.value
  return agentTeams.listRuns(props.project.principalId, props.project.projectId)
})
const adapterChoices = computed(() => [
  { id: 'codex' as const, label: 'Codex · Coding-Agent', available: props.codexAvailable },
  ...props.modelOptions,
])
const canPrepare = computed(
  () =>
    !!objective.value.trim() &&
    !props.killSwitch &&
    [planner.value, implementer.value, reviewer.value].every(
      id => adapterChoices.value.find(option => option.id === id)?.available
    ) &&
    (implementerPermission.value === 'read-only' || props.mode !== 'observe')
)

watch(implementer, value => {
  if (value !== 'codex') implementerPermission.value = 'read-only'
})

function prepare(): void {
  if (!canPrepare.value) return
  error.value = ''
  notice.value = ''
  try {
    const definition = createStandardAgentTeamDefinition({
      planner: planner.value,
      implementer: implementer.value,
      reviewer: reviewer.value,
      implementerPermission: implementerPermission.value,
    })
    prepareAgentTeam(definition, {
      project: props.project,
      objective: objective.value,
      approvalMode: approvalMode.value,
    })
    notice.value =
      approvalMode.value === 'team'
        ? 'Der vollständige Teamrahmen steht zur einmaligen Freigabe bereit.'
        : 'Der Teamrahmen steht bereit. Danach wird jeder ausführbare Knoten einzeln freigegeben.'
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Das Agententeam konnte nicht vorbereitet werden.'
  }
}

function statusLabel(status: AgentTeamNodeStatus | AgentTeamRunStatus): string {
  const labels = new Map<AgentTeamNodeStatus | AgentTeamRunStatus, string>([
    ['awaiting_approval', 'Freigabe ausstehend'],
    ['blocked', 'Wartet auf Vorgänger'],
    ['queued', 'In Warteschlange'],
    ['running', 'Läuft'],
    ['awaiting_external_approval', 'Externe Paketfreigabe'],
    ['cancelling', 'Wird beendet'],
    ['completed', 'Abgeschlossen'],
    ['failed', 'Fehlgeschlagen'],
    ['cancelled', 'Abgebrochen'],
    ['skipped', 'Übersprungen'],
  ])
  return labels.get(status) ?? status
}

function isLive(status: string): boolean {
  return !['completed', 'failed', 'cancelled', 'skipped'].includes(status)
}

function errorLabel(code: AgentTeamErrorCode): string {
  const labels = new Map<AgentTeamErrorCode, string>([
    ['approval_expired', 'Freigabezeit abgelaufen.'],
    ['dependency_failed', 'Ein erforderlicher Vorgänger ist fehlgeschlagen.'],
    ['dependency_cancelled', 'Ein erforderlicher Vorgänger wurde abgebrochen.'],
    ['execution_failed', 'Die Agentenausführung ist fehlgeschlagen.'],
    ['invalid_result', 'Der Agent lieferte kein gültiges Ergebnis.'],
    ['node_timeout', 'Das Zeitlimit dieses Knotens wurde erreicht.'],
    ['prompt_budget_exceeded', 'Das Promptbudget des Knotens oder Teams ist ausgeschöpft.'],
    ['run_timeout', 'Das Zeitbudget des Teamlaufs wurde erreicht.'],
    ['scope_changed', 'Konto, Projekt, Modus oder Workspace-Zuordnung hat sich geändert.'],
  ])
  return labels.get(code) ?? code
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString('de-DE') : 'unbekannt'
}
</script>

<template>
  <section class="agent-teams">
    <div class="agent-teams__heading">
      <div>
        <p class="agent-teams__eyebrow">DAG · kontrollierte Parallelität</p>
        <h3>Agententeam</h3>
      </div>
      <span>Plan → 2 Arbeitsstränge → Review → Abschluss</span>
    </div>
    <p class="agent-teams__muted">
      Vorgängerergebnisse werden strukturiert an abhängige Knoten übergeben. Lokale Modelle teilen sich eine
      GPU-Warteschlange; schreibende Knoten desselben Workspace laufen nacheinander.
    </p>
    <label
      >Teamziel<textarea
        v-model="objective"
        rows="4"
        maxlength="24000"
        placeholder="Zum Beispiel: Analysiere die Agentenarchitektur, setze die priorisierten Punkte um und prüfe sie."
      />
    </label>
    <div class="agent-teams__fields">
      <label
        >Planung<select v-model="planner">
          <option
            v-for="option in adapterChoices"
            :key="`planner-${option.id}`"
            :value="option.id"
            :disabled="!option.available"
          >
            {{ option.label }}{{ option.available ? '' : ' (nicht bereit)' }}
          </option>
        </select></label
      >
      <label
        >Arbeitsstränge<select v-model="implementer">
          <option
            v-for="option in adapterChoices"
            :key="`worker-${option.id}`"
            :value="option.id"
            :disabled="!option.available"
          >
            {{ option.label }}{{ option.available ? '' : ' (nicht bereit)' }}
          </option>
        </select></label
      >
      <label
        >Review und Abschluss<select v-model="reviewer">
          <option
            v-for="option in adapterChoices"
            :key="`review-${option.id}`"
            :value="option.id"
            :disabled="!option.available"
          >
            {{ option.label }}{{ option.available ? '' : ' (nicht bereit)' }}
          </option>
        </select></label
      >
      <label
        >Freigabemodus<select v-model="approvalMode">
          <option value="team">Team einmal vollständig freigeben</option>
          <option value="per-node">Jeden Knoten einzeln freigeben</option>
        </select></label
      >
      <label v-if="implementer === 'codex'"
        >Codex-Arbeitszugriff<select v-model="implementerPermission">
          <option value="read-only">Nur lesen / Patchvorschlag</option>
          <option value="workspace-write" :disabled="mode === 'observe'">Im Projekt schreiben</option>
        </select></label
      >
    </div>
    <p v-if="error" class="agent-teams__error" role="alert">{{ error }}</p>
    <p v-if="notice" class="agent-teams__notice">{{ notice }}</p>
    <button type="button" class="agent-teams__primary" :disabled="!canPrepare" @click="prepare">Teamlauf prüfen</button>

    <article v-for="run in runs" :key="run.id" class="agent-teams__run">
      <div class="agent-teams__row">
        <strong>{{ run.label }}</strong>
        <span>{{ statusLabel(run.status) }}</span>
      </div>
      <p>{{ run.objective }}</p>
      <p class="agent-teams__muted">
        {{ run.promptCharactersUsed.toLocaleString('de-DE') }} /
        {{ run.maxPromptCharacters.toLocaleString('de-DE') }} Promptzeichen · maximal
        {{ run.maxParallel }} parallel<span v-if="run.deadlineAt">
          · Zeitbudget bis {{ formatTime(run.deadlineAt) }}</span
        ><span v-else-if="run.approvalExpiresAt"> · Freigabe bis {{ formatTime(run.approvalExpiresAt) }}</span>
      </p>
      <p v-if="run.errorCode" class="agent-teams__error" role="alert">{{ errorLabel(run.errorCode) }}</p>
      <details v-if="run.status === 'awaiting_approval'" open>
        <summary>Vollständigen Teamrahmen prüfen</summary>
        <ol>
          <li v-for="node in run.nodes" :key="`preview-${node.id}`">
            <strong>{{ node.label }}</strong> · {{ node.adapterId }} ·
            {{ node.permission === 'workspace-write' ? 'Schreiben' : 'Lesen' }} · Vorgänger:
            {{ node.dependencies.join(', ') || 'keine' }}
          </li>
        </ol>
      </details>
      <div class="agent-teams__actions">
        <button
          v-if="run.status === 'awaiting_approval'"
          type="button"
          class="agent-teams__primary"
          :disabled="
            killSwitch || (run.nodes.some(node => node.permission === 'workspace-write') && mode === 'observe')
          "
          @click="agentTeams.approveRun(run.id)"
        >
          {{ run.approvalMode === 'team' ? 'Ganzes Team starten' : 'Teamrahmen starten' }}
        </button>
        <button v-if="isLive(run.status)" type="button" @click="agentTeams.cancelRun(run.id)">Team abbrechen</button>
      </div>

      <div class="agent-teams__nodes">
        <article v-for="node in run.nodes" :key="node.id" class="agent-teams__node">
          <div class="agent-teams__row">
            <strong>{{ node.label }}</strong
            ><span>{{ statusLabel(node.status) }}</span>
          </div>
          <p class="agent-teams__muted">
            {{ node.role }} · {{ node.adapterId }} ·
            {{ node.permission === 'workspace-write' ? 'Workspace schreiben' : 'Workspace lesen' }}
          </p>
          <p v-if="node.approvalExpiresAt" class="agent-teams__muted">
            Knotenfreigabe bis {{ formatTime(node.approvalExpiresAt) }}
          </p>
          <details v-if="node.status === 'awaiting_approval'" open>
            <summary>Exakten Knotenauftrag prüfen</summary>
            <pre>{{ agentTeams.getNodePrompt(run.id, node.id) }}</pre>
          </details>
          <p v-if="node.errorCode" class="agent-teams__error">{{ errorLabel(node.errorCode) }}</p>
          <details v-if="node.output" :open="node.status === 'completed'">
            <summary>Ausgabe</summary>
            <pre>{{ node.output }}</pre>
          </details>
          <div class="agent-teams__actions">
            <button
              v-if="node.status === 'awaiting_approval'"
              type="button"
              class="agent-teams__primary"
              :disabled="killSwitch || (node.permission === 'workspace-write' && mode === 'observe')"
              @click="agentTeams.approveNode(run.id, node.id)"
            >
              Diesen Knoten starten
            </button>
            <button
              v-if="isLive(node.status) && run.status !== 'awaiting_approval'"
              type="button"
              @click="agentTeams.cancelNode(run.id, node.id)"
            >
              Knoten abbrechen
            </button>
          </div>
        </article>
      </div>
    </article>
  </section>
</template>

<style scoped>
.agent-teams {
  padding: 24px 0;
  border-bottom: 1px solid #ffffff18;
}
.agent-teams__heading,
.agent-teams__row,
.agent-teams__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.agent-teams__heading h3,
.agent-teams__eyebrow {
  margin: 0;
}
.agent-teams__eyebrow,
.agent-teams__muted {
  color: #a7b0c0;
  font-size: 13px;
}
.agent-teams__fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
}
.agent-teams label {
  display: grid;
  gap: 7px;
  margin: 12px 0;
  font-size: 13px;
}
.agent-teams select,
.agent-teams textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  color: inherit;
  background: #0d1119;
  border: 1px solid #ffffff28;
  border-radius: 8px;
  font: inherit;
}
.agent-teams textarea {
  resize: vertical;
}
.agent-teams button {
  padding: 9px 14px;
  border: 1px solid #ffffff30;
  border-radius: 8px;
  background: #262e3c;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.agent-teams button:disabled {
  opacity: 0.45;
  cursor: default;
}
.agent-teams .agent-teams__primary {
  background: #b5d2f5;
  color: #111a27;
  border-color: transparent;
  font-weight: 600;
}
.agent-teams__actions {
  justify-content: flex-start;
  margin-top: 12px;
}
.agent-teams__run,
.agent-teams__node {
  margin: 14px 0;
  padding: 16px;
  border: 1px solid #ffffff24;
  border-radius: 10px;
}
.agent-teams__nodes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.agent-teams__node {
  margin: 0;
  background: #0d111966;
}
.agent-teams__error,
.agent-teams__notice {
  padding: 10px 12px;
  border-radius: 8px;
}
.agent-teams__error {
  color: #ffc0b6;
  background: #8f29262b;
}
.agent-teams__notice {
  color: #b8e6ce;
  background: #235f442b;
}
.agent-teams details {
  margin: 12px 0;
}
.agent-teams summary {
  cursor: pointer;
  font-size: 13px;
}
.agent-teams pre {
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #090c12;
  padding: 12px;
  border-radius: 8px;
  font:
    12px/1.6 ui-monospace,
    monospace;
}
@media (max-width: 720px) {
  .agent-teams__fields,
  .agent-teams__nodes {
    grid-template-columns: 1fr;
  }
}
</style>
