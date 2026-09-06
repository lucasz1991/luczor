<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  agentHub,
  agentHubRevision,
  agentExternalApprovals,
  agentProjectSnapshot,
  prepareAgentJob,
  resolveAgentExternalApproval,
} from '@/services/agents/hub'
import { getAgentProjectLink } from '@/services/agents/links'
import { listModelAgentOptions } from '@/services/agents/modelAgent'
import { parseAgentMemorySource, importAgentMemory, type AgentMemorySource } from '@/services/agents/memoryTransfer'
import { openCodexDesktopForProject, getCodexRuntimeStatus } from '@/services/agents/codexAgent'
import type { AgentJob, AgentPermission, AgentProjectSnapshot, AgentRole } from '@/services/agents/types'
import type { LuczorMode } from '@/services/inference/types'

const props = defineProps<{ open: boolean; projectId: string; mode: LuczorMode; killSwitch: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; 'memory-imported': [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const project = ref<AgentProjectSnapshot | null>(null)
const adapterId = ref<'codex' | 'local' | 'policy'>('codex')
const role = ref<AgentRole>('assistant')
const permission = ref<AgentPermission>('read-only')
const model = ref('')
const prompt = ref('')
const includeMemory = ref(false)
const resume = ref(true)
const linkedThread = ref('')
const codexAvailable = ref(false)
const modelOptions = ref(listModelAgentOptions())
const busy = ref(false)
const notice = ref('')
const error = ref('')
const source = ref<AgentMemorySource>('chatgpt')
const sourceRef = ref('')
const sourceText = ref('')
const memoryBody = ref('')
const syncMemory = ref(false)
const previews = ref<ReturnType<typeof parseAgentMemorySource>>([])
const selectedPreview = ref('')
let generation = 0

const jobs = computed(() => {
  void agentHubRevision.value
  return project.value ? agentHub.listJobs(project.value.principalId, project.value.projectId) : []
})
const approvals = computed(() =>
  agentExternalApprovals.value.filter(item => jobs.value.some(job => job.id === item.jobId))
)
const canPrepare = computed(
  () =>
    !busy.value &&
    !!project.value &&
    !!prompt.value.trim() &&
    !props.killSwitch &&
    (adapterId.value !== 'codex' || codexAvailable.value) &&
    (permission.value === 'read-only' || props.mode !== 'observe')
)

function label(status: AgentJob['status']) {
  const labels = {
    awaiting_approval: 'Bereit zur Prüfung',
    queued: 'In Warteschlange',
    running: 'Läuft',
    completed: 'Abgeschlossen',
    failed: 'Fehlgeschlagen',
    cancelled: 'Abgebrochen',
  }
  return Object.getOwnPropertyDescriptor(labels, status)?.value as string
}
function output(jobId: string) {
  void agentHubRevision.value
  return agentHub.getOutput(jobId)
}
function pending(job: AgentJob) {
  return ['awaiting_approval', 'queued', 'running'].includes(job.status)
}
function resetTransfer() {
  sourceText.value = ''
  memoryBody.value = ''
  sourceRef.value = ''
  previews.value = []
  selectedPreview.value = ''
  syncMemory.value = false
}
async function refresh() {
  const current = ++generation
  project.value = null
  linkedThread.value = ''
  error.value = ''
  try {
    const snapshot = await agentProjectSnapshot(props.projectId)
    const [link, runtime] = await Promise.all([
      getAgentProjectLink(snapshot),
      getCodexRuntimeStatus().catch(() => ({ available: false })),
    ])
    if (current !== generation || !props.open) return
    project.value = snapshot
    linkedThread.value = link?.externalThreadId ?? ''
    codexAvailable.value = runtime.available
    modelOptions.value = listModelAgentOptions()
  } catch (caught) {
    if (current === generation)
      error.value = caught instanceof Error ? caught.message : 'Agentenstatus konnte nicht geladen werden.'
  }
}
watch(
  () => [props.open, props.projectId] as const,
  async () => {
    generation++
    busy.value = false
    resetTransfer()
    prompt.value = ''
    notice.value = ''
    await nextTick()
    if (props.open) {
      if (!dialog.value?.open) dialog.value?.showModal()
      await refresh()
    } else dialog.value?.close()
  },
  { immediate: true }
)
watch(adapterId, () => {
  permission.value = 'read-only'
  model.value = ''
})
watch(selectedPreview, id => {
  const preview = previews.value.find(item => item.id === id)
  if (preview) {
    memoryBody.value = preview.content
    source.value = preview.source
    sourceRef.value = preview.sourceRef ?? ''
  }
})
watch(
  () =>
    jobs.value
      .filter(job => job.status === 'completed' && job.externalThreadId)
      .map(job => job.externalThreadId)
      .join(','),
  () => {
    const completed = jobs.value.find(job => job.status === 'completed' && job.externalThreadId)
    if (completed?.externalThreadId) linkedThread.value = completed.externalThreadId
  }
)
onBeforeUnmount(() => {
  generation++
  window.removeEventListener('luczor:api-identity-changing', resetIdentity)
  dialog.value?.close()
})
function resetIdentity() {
  generation++
  resetTransfer()
  prompt.value = ''
  project.value = null
  notice.value = ''
  error.value = ''
  busy.value = false
  emit('update:open', false)
}
onMounted(() => window.addEventListener('luczor:api-identity-changing', resetIdentity))

async function prepare() {
  if (!canPrepare.value) return
  const current = generation
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const job = await prepareAgentJob({
      projectId: props.projectId,
      adapterId: adapterId.value,
      role: role.value,
      permission: permission.value,
      prompt: prompt.value,
      model: model.value,
      includeMemory: includeMemory.value,
      resume: adapterId.value === 'codex' && resume.value && !!linkedThread.value,
    })
    if (current !== generation) {
      agentHub.cancel(job.id)
      return
    }
    notice.value = 'Der vollständige Auftrag steht unten zur Prüfung bereit.'
  } catch (caught) {
    if (current === generation)
      error.value = caught instanceof Error ? caught.message : 'Auftrag konnte nicht vorbereitet werden.'
  } finally {
    if (current === generation) busy.value = false
  }
}
async function copyTask(job: AgentJob) {
  try {
    await navigator.clipboard.writeText(agentHub.getPrompt(job.id))
    notice.value = 'Auftrag kopiert. Du kannst ihn in ChatGPT oder Codex einfügen.'
  } catch {
    error.value = 'Zwischenablage nicht verfügbar. Markiere und kopiere den sichtbaren Auftrag.'
  }
}
function useResult(job: AgentJob) {
  resetTransfer()
  source.value = job.adapterId === 'codex' ? 'codex' : 'agent'
  sourceRef.value = job.externalThreadId || `luczor-agent:${job.id}`
  memoryBody.value = output(job.id).slice(0, 16000)
  notice.value = 'Ergebnis als Entwurf übernommen. Bitte die dauerhaft relevanten Aussagen auswählen und prüfen.'
}
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const current = generation
  error.value = ''
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('Bitte eine Datei mit höchstens 4 MB auswählen.')
    const text = await file.text()
    if (current !== generation) return
    sourceText.value = text
    preview(file.name.toLowerCase().endsWith('.json'))
  } catch (caught) {
    if (current === generation)
      error.value = caught instanceof Error ? caught.message : 'Datei konnte nicht gelesen werden.'
  } finally {
    input.value = ''
  }
}
function preview(json = false) {
  error.value = ''
  try {
    previews.value = parseAgentMemorySource({
      text: sourceText.value,
      format: json || /^\s*[\[{]/u.test(sourceText.value) ? 'chatgpt-json' : 'markdown',
      source: source.value,
      sourceRef: sourceRef.value || undefined,
    })
    selectedPreview.value = ''
    selectedPreview.value = previews.value[0]?.id ?? ''
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Quelle konnte nicht gelesen werden.'
  }
}
async function importMemory() {
  if (!project.value || busy.value || props.killSwitch) return
  const snapshot = project.value
  const selected = {
    projectId: snapshot.projectId,
    principalId: snapshot.principalId,
    content: memoryBody.value,
    source: source.value,
    sourceRef: sourceRef.value || undefined,
    visibility: syncMemory.value ? ('syncable' as const) : ('private' as const),
  }
  const currentGeneration = generation
  busy.value = true
  error.value = ''
  try {
    const current = await agentProjectSnapshot(snapshot.projectId)
    if (
      current.principalId !== snapshot.principalId ||
      current.rootPath !== snapshot.rootPath ||
      current.workspaceUpdatedAt !== snapshot.workspaceUpdatedAt
    )
      throw new Error('Projekt oder Konto hat sich geändert.')
    if (currentGeneration !== generation || props.killSwitch) throw new Error('Die Importauswahl hat sich geändert.')
    const record = await importAgentMemory(selected)
    if (currentGeneration !== generation) return
    notice.value =
      record.visibility === 'private'
        ? 'Als private Erinnerung gespeichert; sie wird nicht an Modelle oder den Server übertragen.'
        : 'Projekt-Erinnerung übernommen. Sie steht dem freigegebenen Erinnerungsabruf zur Verfügung.'
    resetTransfer()
    emit('memory-imported')
  } catch (caught) {
    if (currentGeneration === generation)
      error.value = caught instanceof Error ? caught.message : 'Erinnerung konnte nicht übernommen werden.'
  } finally {
    if (currentGeneration === generation) busy.value = false
  }
}

async function openDesktop() {
  if (!project.value || props.killSwitch) return
  const current = generation
  try {
    await openCodexDesktopForProject(project.value, linkedThread.value || undefined)
    if (current !== generation) return
    notice.value =
      'Projektordner oder verknüpfte Sitzung an den Codex-Desktop übergeben. Die Desktop-App bestätigt das Öffnen selbst.'
  } catch (caught) {
    if (current === generation)
      error.value = caught instanceof Error ? caught.message : 'Codex-Desktop konnte nicht geöffnet werden.'
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="agent-hub"
    aria-labelledby="agent-hub-title"
    @close="emit('update:open', false)"
    @cancel="emit('update:open', false)"
  >
    <header class="agent-hub__header">
      <div>
        <p class="agent-hub__eyebrow">{{ project?.projectName || 'Projekt' }}</p>
        <h2 id="agent-hub-title">Agenten & Erinnerungen</h2>
      </div>
      <button type="button" aria-label="Agentenzentrale schließen" @click="emit('update:open', false)">
        Schließen
      </button>
    </header>
    <div class="agent-hub__body">
      <p v-if="error" class="agent-hub__error" role="alert">{{ error }}</p>
      <p v-if="notice" class="agent-hub__notice" role="status">{{ notice }}</p>
      <p v-if="killSwitch" role="alert">Not-Aus ist aktiv. Neue Aufträge und Übernahmen sind gesperrt.</p>
      <section class="agent-hub__section">
        <h3>Projektverknüpfung</h3>
        <p>{{ project?.rootPath || 'Bitte im Projekt einen lokalen Ordner zuordnen, um Codex zu nutzen.' }}</p>
        <p v-if="linkedThread">
          Codex-Aufgabe: <code>{{ linkedThread }}</code>
        </p>
        <p v-else>Der erste abgeschlossene Codex-Auftrag verknüpft seine Sitzung mit diesem Luczor-Projekt.</p>
        <p class="agent-hub__muted">
          Codex nutzt seinen vorhandenen Login. Luczor führt die Aufträge und setzt die verknüpfte Codex-Sitzung fort.
          Der Projektordner lässt sich an den Desktop übergeben; dessen gespeicherte Projektliste verwaltet Codex
          selbst.
        </p>
        <button type="button" :disabled="!project?.rootPath || killSwitch" @click="openDesktop">
          Im Codex-Desktop öffnen
        </button>
        <details v-if="linkedThread">
          <summary>Im Codex-Desktop weiterarbeiten</summary>
          <p>
            Im Projektordner <code>codex resume {{ linkedThread }}</code> ausführen und in der Codex-Sitzung
            <code>/app</code> eingeben. Die Desktop-App verwaltet ihre eigene Projektliste.
          </p>
        </details>
      </section>
      <section class="agent-hub__section">
        <h3>Agentenauftrag</h3>
        <div class="agent-hub__fields">
          <label
            >Agent<select v-model="adapterId">
              <option value="codex">Codex · Coding-Agent{{ codexAvailable ? '' : ' (CLI nicht erkannt)' }}</option>
              <option v-for="option in modelOptions" :key="option.id" :value="option.id" :disabled="!option.available">
                {{ option.label }}{{ option.available ? '' : ' (nicht bereit)' }}
              </option>
            </select></label
          >
          <label
            >Aufgabe<select v-model="role">
              <option value="assistant">Allgemein</option>
              <option value="planner">Planung</option>
              <option value="implementer">Implementierung</option>
              <option value="reviewer">Review</option>
            </select></label
          >
          <label
            >Freigabe<select v-model="permission">
              <option value="read-only">Nur lesen / Vorschläge</option>
              <option v-if="adapterId === 'codex'" value="workspace-write" :disabled="mode === 'observe'">
                Im Projekt schreiben
              </option>
            </select></label
          >
          <label v-if="adapterId === 'codex'"
            >Codex-Modell (optional)<input
              v-model="model"
              maxlength="128"
              placeholder="Standard aus Codex-Konfiguration"
          /></label>
        </div>
        <p v-if="adapterId !== 'codex'" class="agent-hub__muted">
          Modellagenten erstellen Analysen und Codevorschläge ohne Datei- oder Computerzugriff. Die Modellrichtlinie
          wählt das konfigurierte Modell passend zur Aufgabe. Externe Pakete benötigen eine eigene Freigabe.
        </p>
        <p v-else class="agent-hub__muted">
          Codex kann den Projektordner lesen und dafür seinen eigenen Anbieter verwenden. Schreibzugriff gilt nur für
          diesen Auftrag; in Beobachten bleibt er gesperrt.
        </p>
        <label
          >Arbeitsauftrag<textarea
            v-model="prompt"
            rows="4"
            maxlength="24000"
            placeholder="Zum Beispiel: Prüfe die Projektstruktur und erstelle einen Umsetzungsplan."
          />
        </label>
        <label class="agent-hub__check"
          ><input v-model="includeMemory" type="checkbox" /> Freigegebene Projekt- und Nutzererinnerungen
          einbeziehen</label
        >
        <label v-if="adapterId === 'codex' && linkedThread" class="agent-hub__check"
          ><input v-model="resume" type="checkbox" /> Verknüpfte Codex-Sitzung fortsetzen</label
        >
        <button type="button" class="agent-hub__primary" :disabled="!canPrepare" @click="prepare">
          Auftrag prüfen
        </button>
      </section>
      <section class="agent-hub__section">
        <h3>
          Aufträge <span class="agent-hub__muted">{{ jobs.length }}</span>
        </h3>
        <p v-if="!jobs.length" class="agent-hub__muted">
          Noch keine Aufträge in dieser App-Sitzung. Aufträge desselben Projektordners laufen nacheinander.
        </p>
        <article v-for="job in jobs" :key="job.id" class="agent-hub__job">
          <div class="agent-hub__row">
            <strong>{{ job.adapterId }} · {{ label(job.status) }}</strong
            ><span>{{ job.permission === 'workspace-write' ? 'Schreibzugriff' : 'Lesen' }}</span>
          </div>
          <details v-if="job.status === 'awaiting_approval'" open>
            <summary>Vollständigen Auftrag prüfen</summary>
            <pre>{{ agentHub.getPrompt(job.id) }}</pre>
          </details>
          <p v-if="job.status === 'failed'" role="alert">
            {{
              job.errorCode === 'scope_changed'
                ? 'Konto, Modus oder Projektzuordnung hat sich geändert.'
                : 'Ausführung fehlgeschlagen. CLI-Anmeldung, Modellstatus und Projektordner prüfen.'
            }}
          </p>
          <details v-if="output(job.id)" :open="job.status === 'completed'">
            <summary>Ergebnis</summary>
            <pre>{{ output(job.id) }}</pre>
          </details>
          <div class="agent-hub__actions">
            <button
              v-if="job.status === 'awaiting_approval'"
              type="button"
              class="agent-hub__primary"
              :disabled="killSwitch || (job.permission === 'workspace-write' && mode === 'observe')"
              @click="agentHub.approve(job.id)"
            >
              Auftrag starten
            </button>
            <button v-if="job.status === 'awaiting_approval'" type="button" @click="copyTask(job)">
              Für ChatGPT kopieren
            </button>
            <button v-if="pending(job)" type="button" @click="agentHub.cancel(job.id)">Abbrechen</button>
            <button v-if="job.status === 'completed' && output(job.id)" type="button" @click="useResult(job)">
              Als Erinnerung prüfen
            </button>
          </div>
        </article>
        <article v-for="approval in approvals" :key="approval.jobId" class="agent-hub__job">
          <h4>Externe Modellanfrage prüfen</h4>
          <p>Ziel: {{ approval.destination }} · {{ approval.characterCount }} Zeichen · ohne Werkzeuge</p>
          <details>
            <summary>Übertragenen Inhalt anzeigen</summary>
            <pre v-for="(message, index) in approval.messages" :key="index"
              >{{ message.role }}: {{ message.content }}</pre>
          </details>
          <div class="agent-hub__actions">
            <button type="button" :disabled="killSwitch" @click="resolveAgentExternalApproval(approval.jobId, true)">
              Dieses Paket freigeben</button
            ><button type="button" @click="resolveAgentExternalApproval(approval.jobId, false)">Ablehnen</button>
          </div>
        </article>
      </section>
      <section class="agent-hub__section">
        <h3>ChatGPT / Codex → Luczor</h3>
        <p>
          Übernimm ausgewählte Entscheidungen und Projektwissen aus einem Export, einer Notiz oder einem
          Agentenergebnis.
        </p>
        <div class="agent-hub__fields">
          <label
            >Quelle<select v-model="source">
              <option value="chatgpt">ChatGPT</option>
              <option value="codex">Codex</option>
              <option value="agent">Luczor-Modellagent</option>
            </select></label
          ><label>Aufgaben-ID / Quellenverweis (optional)<input v-model="sourceRef" maxlength="256" /></label>
        </div>
        <label
          >Datei öffnen (.json, .md, .txt; bis 4 MB)<input type="file" accept=".json,.md,.txt" @change="readFile"
        /></label>
        <details>
          <summary>Text oder Export einfügen</summary>
          <label>Quelltext<textarea v-model="sourceText" rows="4" maxlength="4194304" /></label
          ><button type="button" :disabled="!sourceText.trim()" @click="preview()">Vorschau erstellen</button>
        </details>
        <label v-if="previews.length"
          >Auswahl<select v-model="selectedPreview">
            <option v-for="item in previews" :key="item.id" :value="item.id">{{ item.title }}</option>
          </select></label
        >
        <label
          >Erinnerung prüfen und bearbeiten<textarea
            v-model="memoryBody"
            rows="5"
            maxlength="16000"
            placeholder="Nur die Aussagen stehen lassen, die Luczor sich für dieses Projekt merken soll."
          />
        </label>
        <label class="agent-hub__check"
          ><input v-model="syncMemory" type="checkbox" /> Für Erinnerungsabruf durch Modelle und Serversynchronisierung
          freigeben</label
        >
        <p class="agent-hub__muted">
          Ohne Freigabe bleibt die Erinnerung privat auf diesem Gerät. Quellenangaben bleiben als Herkunft erhalten.
          Vertrauliche Inhalte unterliegen weiterhin der Erinnerungskontrolle.
        </p>
        <button
          type="button"
          class="agent-hub__primary"
          :disabled="busy || !memoryBody.trim() || killSwitch || !project"
          @click="importMemory"
        >
          Geprüfte Erinnerung übernehmen
        </button>
      </section>
    </div>
  </dialog>
</template>

<style scoped>
.agent-hub {
  width: min(980px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 0;
  border: 1px solid var(--border, #353942);
  border-radius: 18px;
  background: var(--surface, #181b21);
  color: var(--text, #e9ebef);
  box-shadow: 0 24px 90px #0007;
}
.agent-hub::backdrop {
  background: #07090ebd;
}
.agent-hub__header {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface, #181b21);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 28px;
  border-bottom: 1px solid #ffffff18;
}
.agent-hub__eyebrow {
  margin: 0 0 6px;
  color: #a7b4c8;
  font-size: 13px;
}
.agent-hub h2 {
  margin: 0;
  font-size: 24px;
}
.agent-hub h3 {
  margin: 0 0 14px;
  font-size: 18px;
}
.agent-hub__body {
  padding: 0 28px 28px;
}
.agent-hub__section {
  padding: 24px 0;
  border-bottom: 1px solid #ffffff18;
}
.agent-hub p {
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.agent-hub__muted {
  color: #a7b0c0;
  font-size: 13px;
}
.agent-hub__fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.agent-hub label {
  display: grid;
  gap: 7px;
  margin: 12px 0;
  font-size: 13px;
}
.agent-hub input,
.agent-hub select,
.agent-hub textarea {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  color: inherit;
  background: #0d1119;
  border: 1px solid #ffffff28;
  border-radius: 8px;
  font: inherit;
}
.agent-hub textarea {
  resize: vertical;
  line-height: 1.5;
}
.agent-hub .agent-hub__check {
  display: flex;
  align-items: center;
  gap: 9px;
}
.agent-hub__check input {
  width: auto;
}
.agent-hub button {
  padding: 9px 14px;
  border: 1px solid #ffffff30;
  border-radius: 8px;
  background: #262e3c;
  color: inherit;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.agent-hub button:disabled {
  opacity: 0.45;
  cursor: default;
}
.agent-hub button:focus-visible,
.agent-hub summary:focus-visible {
  outline: 2px solid #83bbfd;
  outline-offset: 3px;
}
.agent-hub .agent-hub__primary {
  background: #b5d2f5;
  color: #111a27;
  border-color: transparent;
  font-weight: 600;
}
.agent-hub__row,
.agent-hub__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.agent-hub__actions {
  justify-content: flex-start;
  margin-top: 12px;
}
.agent-hub__job {
  border: 1px solid #ffffff24;
  border-radius: 10px;
  padding: 16px;
  margin: 12px 0;
}
.agent-hub details {
  margin: 12px 0;
}
.agent-hub summary {
  cursor: pointer;
  font-size: 13px;
}
.agent-hub pre {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #0d1119;
  padding: 14px;
  border-radius: 8px;
  font:
    12px/1.6 ui-monospace,
    monospace;
}
.agent-hub__error {
  color: #ffc0b6;
  background: #8f29262b;
  padding: 12px;
  border-radius: 8px;
}
.agent-hub__notice {
  color: #b8e6ce;
  background: #235f442b;
  padding: 12px;
  border-radius: 8px;
}
@media (max-width: 620px) {
  .agent-hub__fields {
    grid-template-columns: 1fr;
    gap: 0;
  }
  .agent-hub__header {
    padding: 18px;
  }
  .agent-hub__body {
    padding: 0 18px 18px;
  }
  .agent-hub h2 {
    font-size: 20px;
  }
}
</style>
