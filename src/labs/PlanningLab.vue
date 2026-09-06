<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import PlanningWorkspace from '@/components/planning/PlanningWorkspace.vue'
import { AgentTeamOrchestrator, type AgentTeamExecutionRequest } from '@/services/agents/teams'
import type { AgentPermission, AgentProjectSnapshot, AgentRunResult } from '@/services/agents/types'
import {
  createPlanningHub,
  type PlanningController,
  type PlanningControllerDependencies,
  type PlanningPreparedJobInput,
} from '@/services/planning/controller'
import type { PlanningAnalysis, PlanningPlan } from '@/services/planning/types'

type LabScenario = 'success' | 'questions' | 'execution-failure'
type LabRuntime = Readonly<{ hub: PlanningController; dispose: () => void }>

const PROJECT: AgentProjectSnapshot = Object.freeze({
  principalId: 'planning-lab-principal',
  projectId: 'planning-lab-project',
  projectName: 'Synthetisches Planungsprojekt',
  rootPath: 'C:\\Luczor-Planning-Lab',
  workspaceUpdatedAt: 1,
})
const scenarioCopy: Record<LabScenario, { title: string; detail: string; objective: string }> = {
  success: {
    title: 'Vollständiger Lauf',
    detail: 'Analyse, editierbarer DAG, explizite Freigabe und Abschlussreview.',
    objective: 'Eine bestehende Projekteinstellung analysieren, kontrolliert anpassen und mit Nachweisen prüfen.',
  },
  questions: {
    title: 'Offene Frage',
    detail: 'Die Analyse fordert eine Entscheidung an und blockiert die Ausführung.',
    objective: 'Einen plattformabhängigen Projektablauf planen, dessen Zielplattform noch nicht festgelegt ist.',
  },
  'execution-failure': {
    title: 'Ausführungsfehler',
    detail: 'Der zweite DAG-Schritt schlägt kontrolliert fehl; abhängige Schritte bleiben gesperrt.',
    objective:
      'Eine zweistufige Projektänderung planen und einen Fehler im zweiten Ausführungsschritt sichtbar machen.',
  },
}

function abortError(): DOMException {
  return new DOMException('Laborlauf abgebrochen.', 'AbortError')
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }
    const timer = window.setTimeout(finish, milliseconds)
    const cancel = () => {
      window.clearTimeout(timer)
      reject(abortError())
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
  })
}

function promptObjective(prompt: string): string {
  const encoded = /Freigegebenes Ziel:\r?\n([^\r\n]+)/u.exec(prompt)?.[1]
  if (encoded) return String(JSON.parse(encoded))
  const analysis = /(?:^|\r?\n)Ziel:\r?\n([\s\S]*?)\r?\n\r?\nKlarstellungen des Benutzers/u.exec(prompt)?.[1]
  if (analysis) return analysis.trim()
  throw new Error('Das synthetische Labor konnte das Planungsziel nicht lesen.')
}

function promptAnalysis(prompt: string): PlanningAnalysis {
  const encoded = /Geprüfte Analyse:\r?\n([^\r\n]+)/u.exec(prompt)?.[1]
  if (!encoded) throw new Error('Das synthetische Labor konnte die Analyse nicht lesen.')
  return JSON.parse(encoded) as PlanningAnalysis
}

function analysisFor(scenario: LabScenario, clarified: boolean): PlanningAnalysis {
  return {
    summary: 'Der synthetische Projektkontext wurde lesend gegen Ziel, Grenzen und Prüfpfad ausgewertet.',
    findings: [
      'Der Ablauf lässt sich in Bestandsprüfung, gezielte Änderung und unabhängige Verifikation zerlegen.',
      'Jeder ausführende Schritt benötigt ein sichtbares Kriterium und einen eigenen Nachweis.',
    ],
    evidence: [
      'Laborbeleg: Das Fixture stellt ausschließlich einen synthetischen Projekt-Snapshot ohne Datei- oder Providerzugriff bereit.',
    ],
    assumptions: ['Die im Labor simulierte Projektschnittstelle bleibt während eines Laufs unverändert.'],
    risks: [
      scenario === 'execution-failure'
        ? 'Der zweite Ausführungsschritt ist für dieses Szenario absichtlich fehlerhaft.'
        : 'Fehlende reale Projektdateien begrenzen die Aussage auf den Steuerungsablauf.',
    ],
    openQuestions:
      scenario === 'questions' && !clarified ? ['Welche Zielplattform ist für den Ablauf verbindlich?'] : [],
  }
}

function planFor(objective: string, analysis: PlanningAnalysis): PlanningPlan {
  return {
    objective,
    analysis,
    steps: [
      {
        id: 'bestand-pruefen',
        title: 'Bestand und Grenzen prüfen',
        description: 'Den gebundenen Projektkontext lesen und die betroffene Schnittstelle abgrenzen.',
        dependencies: [],
        acceptanceCriteria: ['Betroffene Schnittstelle und Scope sind nachvollziehbar benannt.'],
        verification: ['Analysebeleg und Scope-Grenze im Schrittergebnis prüfen.'],
      },
      {
        id: 'aenderung-ausarbeiten',
        title: 'Gezielte Änderung ausarbeiten',
        description: 'Die freigegebene Änderung innerhalb des abgegrenzten Scopes umsetzen oder lesend beschreiben.',
        dependencies: ['bestand-pruefen'],
        acceptanceCriteria: ['Das Ergebnis erfüllt das Ziel ohne Punkte außerhalb des Scopes.'],
        verification: ['Ausgabe gegen Ziel und ersten Schrittnachweis vergleichen.'],
      },
      {
        id: 'ergebnis-pruefen',
        title: 'Ergebnis unabhängig prüfen',
        description: 'Ergebnis und Restgrenzen anhand der expliziten Kriterien prüfen.',
        dependencies: ['aenderung-ausarbeiten'],
        acceptanceCriteria: ['Jedes Kriterium ist als belegt, fehlgeschlagen oder unbekannt bewertet.'],
        verification: ['Abschlussreview auf konkrete Nachweise und offene Restgrenzen prüfen.'],
      },
    ],
    completionCriteria: ['Alle Planschritte und ihre Prüfungen besitzen einen ausgewiesenen Status.'],
    outOfScope: ['Reale Provideraufrufe', 'Änderungen an Dateien oder Betriebssystem'],
  }
}

function syntheticTeamOutput(request: AgentTeamExecutionRequest): string {
  if (request.nodeId === 'plan-final-review') {
    return [
      'Synthetisches Abschlussreview',
      'belegt · Ablauf: alle erreichten Knoten haben einen Labor-Nachweis geliefert.',
      'unbekannt · Produktwirkung: ohne reale Datei- und Provideraufrufe nicht bewertbar.',
      'Restgrenze · Dieses Ergebnis ist keine fachliche oder produktive Abnahme.',
    ].join('\n')
  }
  if (request.nodeId === 'plan-final-join') {
    return 'Laborergebnisse zusammengeführt. Belegte Punkte und Restgrenzen stehen im Abschlussreview.'
  }
  return `Synthetischer Nachweis für ${request.nodeId}: Auftrag im ${request.permission === 'workspace-write' ? 'Schreib' : 'Lese'}modus verarbeitet; keine reale Aktion ausgeführt.`
}

function createLabRuntime(scenario: LabScenario): LabRuntime {
  const rootController = new AbortController()
  const jobs = new Map<string, PlanningPreparedJobInput>()
  const cancelledJobs = new Set<string>()
  let sequence = 0
  const createId = () => `planning-lab-${++sequence}`

  const teams = new AgentTeamOrchestrator({
    maxConcurrent: 2,
    createId,
    async executor(request) {
      request.onPreparedPrompt(request.prompt.length)
      request.onPhase('running')
      await wait(320, request.signal)
      if (scenario === 'execution-failure' && request.nodeId === 'plan-step-2') {
        throw new Error('Simulierter Ausführungsfehler im zweiten Planschritt.')
      }
      const output = syntheticTeamOutput(request)
      request.onOutput(output)
      return { output }
    },
  })

  const dependencies: PlanningControllerDependencies = {
    async projectSnapshot(projectId) {
      if (projectId !== PROJECT.projectId) throw new Error('Unbekanntes Laborprojekt.')
      return PROJECT
    },
    validateScope(project, permission: AgentPermission) {
      if (project !== PROJECT && project.projectId !== PROJECT.projectId) throw new Error('Labor-Scope wurde geändert.')
      if (!['read-only', 'workspace-write'].includes(permission)) throw new Error('Unbekannte Laborberechtigung.')
    },
    async prepareAgentJob(input) {
      const id = createId()
      jobs.set(id, input)
      return { id }
    },
    cancelAgentJob(jobId) {
      if (!jobs.has(jobId)) return false
      cancelledJobs.add(jobId)
      return true
    },
    async executePreparedAgentJob(jobId, signal, observer): Promise<AgentRunResult> {
      const job = jobs.get(jobId)
      if (!job) throw new Error('Synthetischer Planungsauftrag fehlt.')
      const combined = signal ? AbortSignal.any([signal, rootController.signal]) : rootController.signal
      if (cancelledJobs.has(jobId) || combined.aborted) throw abortError()
      observer?.onPhase?.('running')
      await wait(260, combined)
      if (cancelledJobs.has(jobId) || combined.aborted) throw abortError()
      if (job.teamNodeId === 'analysis') {
        const clarified = job.prompt.includes('Klarstellungen des Benutzers:\n')
        const output = JSON.stringify(analysisFor(scenario, clarified))
        observer?.onOutput?.(output)
        return { output }
      }
      if (job.teamNodeId === 'plan') {
        const output = JSON.stringify(planFor(promptObjective(job.prompt), promptAnalysis(job.prompt)))
        observer?.onOutput?.(output)
        return { output }
      }
      throw new Error('Unbekannte synthetische Planungsphase.')
    },
    prepareAgentTeam: (definition, input) => teams.prepare(definition, input),
    approveAgentTeam: runId => teams.approveRun(runId),
    cancelAgentTeam: runId => teams.cancelRun(runId),
    getAgentTeam: runId => teams.getRun(runId),
    subscribeAgentTeams: listener => teams.subscribe(listener),
    captureExecution(signal) {
      return Object.freeze({
        sessionId: 'planning-lab-session',
        generation: 1,
        signal: signal ? AbortSignal.any([signal, rootController.signal]) : rootController.signal,
      })
    },
    assertExecution(ticket) {
      if (ticket.sessionId !== 'planning-lab-session' || ticket.generation !== 1 || ticket.signal.aborted) {
        throw new Error('Der synthetische Labor-Scope wurde verworfen.')
      }
    },
    createId,
  }
  const hub = createPlanningHub(dependencies)
  return {
    hub,
    dispose() {
      rootController.abort()
      hub.dispose()
      teams.dispose()
      jobs.clear()
    },
  }
}

const selectedScenario = ref<LabScenario>('success')
const open = ref(false)
const runtime = shallowRef(createLabRuntime(selectedScenario.value))
const revision = ref(0)
let unsubscribe = runtime.value.hub.subscribe(() => revision.value++)

const current = computed(() => {
  void revision.value
  return runtime.value.hub.get(PROJECT.projectId)
})

function startScenario(scenario: LabScenario): void {
  open.value = false
  unsubscribe()
  runtime.value.dispose()
  selectedScenario.value = scenario
  runtime.value = createLabRuntime(scenario)
  unsubscribe = runtime.value.hub.subscribe(() => revision.value++)
  revision.value++
  open.value = true
}

onBeforeUnmount(() => {
  unsubscribe()
  runtime.value.dispose()
})
</script>

<template>
  <main>
    <header>
      <span class="eyebrow">LUCZOR / ENTWICKLUNG</span>
      <span class="simulation">SIMULATION · KEINE MODELLE · KEINE DATEIAKTIONEN</span>
    </header>

    <section class="intro">
      <p class="eyebrow">PLANUNGSMODUS-TESTLABOR</p>
      <h1>Vom Befund zum kontrollierten Lauf.</h1>
      <p>
        Dieses Labor verwendet den produktiven PlanningController und AgentTeam-Scheduler. Nur Modellantworten,
        Projektkontext und Schrittausgaben sind synthetische Fixtures.
      </p>
    </section>

    <section class="scenarios" aria-label="Planungsszenarien">
      <article v-for="(copy, id) in scenarioCopy" :key="id">
        <span class="number">{{ id === 'success' ? '01' : id === 'questions' ? '02' : '03' }}</span>
        <h2>{{ copy.title }}</h2>
        <p>{{ copy.detail }}</p>
        <button type="button" class="primary" @click="startScenario(id)">Szenario öffnen</button>
      </article>
    </section>

    <section class="state" aria-live="polite">
      <div>
        <span class="eyebrow">AKTUELLE SITZUNG</span>
        <h2>{{ current ? `${scenarioCopy[selectedScenario].title} · ${current.status}` : 'Noch kein Lauf' }}</h2>
      </div>
      <button v-if="current" type="button" @click="open = true">Planungsdialog wieder öffnen</button>
    </section>

    <section class="expectations">
      <h2>Was hier geprüft wird</h2>
      <ul>
        <li>Zweistufige, ausschließlich lesende Analyse und Planung.</li>
        <li>Editierbarer DAG mit gespeicherter Revision vor der Ausführung.</li>
        <li>Blockierung durch offene Fragen und explizite Präzisierung.</li>
        <li>Echter Team-Scheduler mit Abschlussreview, Fehlerweitergabe und Abbruch.</li>
        <li>Import und Export ohne automatischen Neustart eines Laufs.</li>
      </ul>
    </section>

    <PlanningWorkspace
      v-model:open="open"
      :project-id="PROJECT.projectId"
      mode="act"
      :kill-switch="false"
      :busy="false"
      :initial-objective="scenarioCopy[selectedScenario].objective"
      :hub-prop="runtime.hub"
    />
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}
:global(body) {
  margin: 0;
  background: #0b121a;
  color: #e8eef5;
  font-family: 'Segoe UI', system-ui, sans-serif;
}
:global(button) {
  font: inherit;
}
main {
  width: min(1220px, calc(100% - 40px));
  margin: 0 auto;
  padding: 30px 0 60px;
}
header,
.state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
header {
  padding-bottom: 24px;
  border-bottom: 1px solid #ffffff18;
}
.eyebrow,
.number {
  color: #78b9dd;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.simulation {
  padding: 7px 10px;
  border: 1px solid #80caa755;
  border-radius: 999px;
  color: #98d8ba;
  font-size: 11px;
  font-weight: 700;
}
.intro {
  max-width: 850px;
  padding: 80px 0 52px;
}
.intro h1 {
  max-width: 760px;
  margin: 10px 0 20px;
  font-size: clamp(42px, 7vw, 86px);
  font-weight: 650;
  letter-spacing: -0.055em;
  line-height: 0.95;
}
.intro > p:last-child {
  max-width: 720px;
  color: #aab8c8;
  font-size: 18px;
  line-height: 1.65;
}
.scenarios {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid #ffffff1d;
  border-radius: 18px;
  overflow: hidden;
}
.scenarios article {
  min-height: 280px;
  padding: 28px;
  background: #111b26;
}
.scenarios article + article {
  border-left: 1px solid #ffffff1d;
}
.scenarios h2 {
  margin: 42px 0 12px;
  font-size: 24px;
}
.scenarios p {
  min-height: 70px;
  color: #aab8c8;
  line-height: 1.55;
}
button {
  padding: 10px 14px;
  border: 1px solid #ffffff25;
  border-radius: 8px;
  background: #182533;
  color: inherit;
  cursor: pointer;
}
button:hover {
  border-color: #78b9dd99;
}
.primary {
  border-color: #78b9dd;
  background: #78b9dd;
  color: #07111a;
  font-weight: 700;
}
.state,
.expectations {
  margin-top: 28px;
  padding: 24px 28px;
  border: 1px solid #ffffff1d;
  border-radius: 14px;
  background: #0f1822;
}
.state h2 {
  margin: 6px 0 0;
  font-size: 20px;
}
.expectations h2 {
  margin: 0 0 16px;
}
.expectations ul {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 32px;
  margin: 0;
  padding-left: 20px;
  color: #b8c5d3;
  line-height: 1.5;
}
@media (max-width: 800px) {
  .scenarios,
  .expectations ul {
    grid-template-columns: 1fr;
  }
  .scenarios article + article {
    border-top: 1px solid #ffffff1d;
    border-left: 0;
  }
  header,
  .state {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
