<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import {
  AgentTeamOrchestrator,
  createStandardAgentTeamDefinition,
  type AgentTeamRun,
  type AgentTeamNodeStatus,
} from '@/services/agents/teams'

const scenario = ref('success')
const approvals = ref<'team' | 'per-node'>('team')
const objective = ref('Eine Projektfunktion planen, in zwei Arbeitssträngen prüfen und gemeinsam abnehmen.')
const run = shallowRef<AgentTeamRun>()
const prompts = ref<Record<string, string>>({})
const events = ref<Array<{ time: string; text: string }>>([])
const error = ref('')
let active = 0
const maxObserved = ref(0)
let runningScenario = 'success'
const engine = new AgentTeamOrchestrator({
  maxConcurrent: 2,
  async executor(request) {
    request.onPhase('running')
    active++
    maxObserved.value = Math.max(maxObserved.value, active)
    prompts.value[request.nodeId] = request.prompt
    events.value.push({
      time: new Date().toLocaleTimeString('de-DE'),
      text: `${request.nodeId} gestartet · ${active} aktiv`,
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer)
          // Simulates confirmed native process termination, not immediate slot release.
          setTimeout(() => reject(new DOMException('Abgebrochen', 'AbortError')), 250)
        }
        const timer = setTimeout(() => {
          request.signal.removeEventListener('abort', cancel)
          resolve()
        }, 1100)
        if (request.signal.aborted) cancel()
        else request.signal.addEventListener('abort', cancel, { once: true })
      })
      if (runningScenario === 'review-fail' && request.nodeId === 'reviewer')
        throw new Error('Simulierter Reviewfehler: Akzeptanzkriterium nicht erfüllt.')
      const output = `Simulation · ${request.role}: ${request.nodeId === 'planner' ? 'Plan freigegeben: Hauptpfad und Randfälle getrennt prüfen.' : request.nodeId === 'join' ? 'Ergebnisse und Review zusammengeführt. Alle Simulationsschritte abgeschlossen.' : `Ergebnis von ${request.nodeId}. Vorgänger wurden als begrenzte Daten übernommen.`}`
      request.onOutput(output)
      return { output }
    } finally {
      active--
      events.value.push({
        time: new Date().toLocaleTimeString('de-DE'),
        text: `${request.nodeId} beendet · ${active} aktiv`,
      })
    }
  },
})
const unsubscribe = engine.subscribe(() => {
  if (run.value) run.value = engine.getRun(run.value.id)
})
const terminal = computed(() => !run.value || ['completed', 'failed', 'cancelled'].includes(run.value.status))
const completed = computed(() => run.value?.nodes.filter(node => node.status === 'completed').length ?? 0)
const labels: Record<AgentTeamNodeStatus | 'cancelling', string> = {
  blocked: 'Wartet auf Vorgänger',
  awaiting_approval: 'Freigabe erforderlich',
  queued: 'Warteschlange',
  running: 'Läuft',
  awaiting_external_approval: 'Externe Freigabe',
  cancelling: 'Wird beendet',
  completed: 'Abgeschlossen',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
  skipped: 'Übersprungen',
}
const runStatus = computed(() =>
  run.value?.status === 'completed'
    ? 'Team abgeschlossen'
    : run.value?.status === 'failed'
      ? 'Team fehlgeschlagen'
      : run.value?.status === 'cancelled'
        ? 'Team abgebrochen'
        : run.value?.status === 'awaiting_approval'
          ? 'Bereit zur Teamfreigabe'
          : run.value?.status === 'cancelling'
            ? 'Lauf wird beendet'
            : 'Team arbeitet'
)

function prepare() {
  error.value = ''
  try {
    runningScenario = scenario.value
    prompts.value = {}
    events.value = []
    maxObserved.value = 0
    const adapter = scenario.value === 'local-queue' ? 'local' : 'codex'
    const definition = createStandardAgentTeamDefinition({ planner: adapter, implementer: adapter, reviewer: adapter })
    run.value = engine.prepare(definition, {
      project: {
        principalId: 'simulation',
        projectId: 'demo',
        projectName: 'Testprojekt',
        rootPath: 'C:/Luczor-Simulation',
        workspaceUpdatedAt: 1,
      },
      objective: objective.value,
      approvalMode: approvals.value,
    })
  } catch (cause) {
    error.value = String(cause)
  }
}
function exportRun() {
  if (!run.value) return
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          { simulation: true, run: run.value, maxObserved: maxObserved.value, events: events.value },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    )
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'luczor-team-test.json'
  anchor.click()
  URL.revokeObjectURL(url)
}
onBeforeUnmount(() => {
  unsubscribe()
  engine.dispose()
})
</script>

<template>
  <main>
    <header>
      <span class="eyebrow">LUCZOR / ENTWICKLUNG</span
      ><span class="simulation">SIMULATION · KEINE EXTERNEN AUFRUFE</span>
    </header>
    <div class="intro">
      <h1>Ein Ziel. Ein Agententeam.</h1>
      <p>
        Prüfe Abhängigkeiten, parallele Arbeit, Freigaben und Fehlerbehandlung mit der produktiven Teamsteuerung und
        simulierten Agenten.
      </p>
    </div>
    <section class="setup" aria-label="Testkonfiguration">
      <label class="objective">Teamziel<textarea v-model="objective" :disabled="!terminal" rows="2" /></label>
      <label
        >Testszenario<select v-model="scenario" :disabled="!terminal">
          <option value="success">Erfolg · zwei Arbeitsstränge</option>
          <option value="review-fail">Fehler im Review</option>
          <option value="local-queue">Lokales Modell · eine Ressource</option>
        </select></label
      >
      <label
        >Freigabemodus<select v-model="approvals" :disabled="!terminal">
          <option value="team">Gesamtes Team</option>
          <option value="per-node">Jeden Knoten einzeln</option>
        </select></label
      >
      <button class="primary" :disabled="!terminal || !objective.trim()" @click="prepare">Testlauf vorbereiten</button>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <section v-if="run" class="run" aria-label="Teamlauf">
      <div class="run-heading">
        <div>
          <span class="eyebrow">{{ run.id.slice(0, 8) }} · {{ run.nodes.length }} KNOTEN</span>
          <h2 role="status">{{ runStatus }}</h2>
        </div>
        <div class="actions">
          <button v-if="run.status === 'awaiting_approval'" class="primary" @click="engine.approveRun(run.id)">
            Team freigeben und starten</button
          ><button v-if="!terminal" class="danger" @click="engine.cancelRun(run.id)">Lauf abbrechen</button
          ><button v-if="terminal" @click="exportRun">Testprotokoll exportieren</button>
        </div>
      </div>
      <div class="metrics">
        <span
          ><b>{{ completed }}/{{ run.nodes.length }}</b> abgeschlossen</span
        ><span
          ><b>{{ maxObserved }}</b> maximal gleichzeitig aktiv</span
        ><span
          ><b>{{ run.promptCharactersUsed.toLocaleString('de-DE') }}</b> /
          {{ run.maxPromptCharacters.toLocaleString('de-DE') }} Promptzeichen</span
        >
      </div>
      <ol class="nodes">
        <li v-for="(node, index) in run.nodes" :key="node.id" :data-status="node.status">
          <div class="node-top">
            <span class="number">0{{ index + 1 }}</span
            ><span class="adapter">{{ node.adapterId }} · simuliert</span>
          </div>
          <h3>{{ node.label }}</h3>
          <p class="status">{{ labels[node.status] }}</p>
          <p class="dependency">
            {{ node.dependencies.length ? `Nach: ${node.dependencies.join(', ')}` : 'Startknoten' }}
          </p>
          <p class="resource">
            Projekt: {{ node.resources.workspace === 'write' ? 'schreiben' : 'lesen' }}<br />{{
              node.resources.exclusive?.join(', ') || 'Keine exklusive Modellressource'
            }}
          </p>
          <button v-if="node.status === 'awaiting_approval'" @click="engine.approveNode(run.id, node.id)">
            {{ node.label }} freigeben
          </button>
          <p v-if="node.errorCode" class="error">{{ node.errorCode }}</p>
          <details v-if="node.output">
            <summary>Ergebnis</summary>
            <pre>{{ node.output }}</pre>
          </details>
          <details v-if="prompts[node.id]">
            <summary>Übergebenen Auftrag prüfen</summary>
            <pre>{{ prompts[node.id] }}</pre>
          </details>
        </li>
      </ol>
      <details class="event-log">
        <summary>Ablaufprotokoll ({{ events.length }})</summary>
        <p v-for="(event, index) in events" :key="index">
          <time>{{ event.time }}</time> {{ event.text }}
        </p>
      </details>
    </section>
    <section v-else class="empty">
      <span>01 → 02 + 03 → 04 → 05</span>
      <p>Planung → zwei Arbeitsstränge → unabhängiges Review → gemeinsamer Abschluss</p>
    </section>
    <footer>
      Dieses Labor verändert keine Projektdateien und startet keine Modelle. Echte Aufträge starten in Luczor unter
      „Agenten & Erinnerungen“ → Agententeams.
    </footer>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}
:global(body) {
  margin: 0;
  font-family: 'Segoe UI', sans-serif;
  background: #0c131d;
  color: #e8eef6;
}
:global(button),
:global(select),
:global(textarea) {
  font: inherit;
}
main {
  max-width: 1560px;
  margin: auto;
  padding: 30px 40px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  padding-bottom: 28px;
  border-bottom: 1px solid #2e3b4c;
}
.eyebrow {
  color: #90a4bb;
  font-size: 11px;
  letter-spacing: 0.13em;
  font-weight: 650;
}
.simulation {
  color: #9ed9c0;
  font-size: 11px;
  letter-spacing: 0.06em;
}
.intro {
  max-width: 800px;
  margin: 36px 0;
}
h1 {
  margin: 0 0 14px;
  font-size: clamp(30px, 3.3vw, 48px);
  letter-spacing: -0.04em;
  font-weight: 600;
}
.intro p {
  color: #adbdcf;
  font-size: 16px;
  line-height: 1.6;
}
.setup {
  display: grid;
  grid-template-columns: 1.7fr 1fr 1fr;
  gap: 18px;
  padding: 24px;
  background: #151f2c;
  border-radius: 12px;
  border: 1px solid #2e3b4c;
}
label {
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: #c8d5e4;
  font-size: 13px;
}
.objective {
  grid-column: 1 / -1;
}
textarea,
select {
  width: 100%;
  padding: 12px;
  color: #f3f6fb;
  background: #0e1723;
  border: 1px solid #455770;
  border-radius: 6px;
}
textarea {
  resize: vertical;
  line-height: 1.5;
}
button {
  cursor: pointer;
  border-radius: 6px;
  padding: 12px 17px;
  background: transparent;
  color: #d8e7f8;
  border: 1px solid #61738b;
  font-weight: 600;
}
.primary {
  background: #a6d8c1;
  color: #0c251b;
  border-color: #a6d8c1;
}
.setup > button {
  align-self: end;
}
button:disabled {
  cursor: default;
  opacity: 0.4;
}
.danger {
  color: #f8b2a9;
  border-color: #af625a;
}
.run {
  margin-top: 36px;
}
.run-heading,
.actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
}
h2 {
  font-size: 24px;
  margin: 8px 0 18px;
  font-weight: 600;
}
.metrics {
  display: flex;
  gap: 32px;
  flex-wrap: wrap;
  border-block: 1px solid #2e3b4c;
  padding: 18px 0;
  color: #9eafc4;
  font-size: 13px;
}
b {
  color: #f2f6fc;
  font-size: 19px;
  margin-right: 4px;
}
.nodes {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  padding: 0;
  gap: 12px;
  margin: 22px 0;
}
.nodes li {
  border: 1px solid #36465a;
  border-top: 3px solid #4b5b70;
  border-radius: 8px;
  background: #151f2c;
  padding: 17px;
  min-height: 275px;
}
.nodes li[data-status='running'] {
  border-top-color: #ddc884;
  background: #23271f;
}
.nodes li[data-status='completed'] {
  border-top-color: #9bd7b8;
}
.nodes li[data-status='failed'] {
  border-top-color: #ee877d;
}
.node-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.number {
  color: #89a0bd;
  font-size: 20px;
}
.adapter {
  font-size: 10px;
  color: #9eafc4;
}
h3 {
  font-size: 16px;
  font-weight: 600;
  min-height: 38px;
  margin: 20px 0 12px;
}
.status {
  font-size: 13px;
  color: #c2dfd3;
}
.dependency,
.resource {
  font-size: 11px;
  color: #9cacc1;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
details {
  margin-top: 15px;
  font-size: 12px;
}
summary {
  cursor: pointer;
  color: #bbcee5;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: Consolas, monospace;
  line-height: 1.5;
  max-height: 320px;
  overflow: auto;
}
.error {
  color: #ffb0a9;
  overflow-wrap: anywhere;
}
.event-log {
  padding: 20px;
  background: #121d2b;
  border: 1px solid #2e3b4c;
  border-radius: 8px;
}
time {
  color: #90a4bb;
  margin-right: 12px;
}
.empty {
  padding: 68px 20px;
  text-align: center;
  color: #9eafc4;
}
.empty span {
  font-size: 27px;
  color: #c4dccf;
  letter-spacing: 0.1em;
}
.empty p {
  font-size: 13px;
  margin-top: 20px;
}
footer {
  margin-top: 30px;
  color: #90a4bb;
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 1100px) {
  main {
    padding: 24px;
  }
  .nodes {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 650px) {
  main {
    padding: 18px;
  }
  header,
  .run-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .setup,
  .nodes {
    grid-template-columns: 1fr;
  }
  .metrics {
    gap: 15px;
  }
  .nodes li {
    min-height: 0;
  }
}
</style>
