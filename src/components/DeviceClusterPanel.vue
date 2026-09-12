<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import { state } from '@/state/store'
import { deviceCluster } from '@/services/coordination/channel'
import { coordinationApi } from '@/services/coordination/api'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig } from '@/services/api/luczorApi'
import { projectExternalIdForServer } from '@/services/cloudProjectAccess'
import { pauseProjectMirror, projectMirrorState, syncProjectMirror } from '@/services/coordination/mirror'
import { binaryRequest } from '@/services/coordination/binaryTransport'
import { lanState } from '@/services/coordination/lan'
import { coordinationMetadata, setCoordinationRank } from '@/services/coordination/preferences'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { executionGate, invokeGuarded } from '@/services/executionGate'
import { hasActiveChatRuns } from '@/services/chatRunManager'
import { createWorkflowApi } from '@/services/workflows/api'
import type { Workflow } from '@/services/workflows/types'
import type { WorkflowTestCase, WorkflowTestEvidence } from '@/services/workflows/workflowTests'
import { buildCoordinationDiagnostic } from '@/services/coordination/diagnostics'
import { useClipboard } from '@/composables/useClipboard'

const props = defineProps<{ open: boolean; projectId?: string }>()
const emit = defineEmits<{ close: [] }>()
const nativeAvailable = isTauri()
const clipboard = useClipboard()
const diagnosticText = ref('')
const dialog = ref<HTMLDialogElement>()
const tab = ref<'devices' | 'files' | 'workflows' | 'tests'>('devices')
const error = ref(''),
  pending = ref(false),
  notice = ref('')
const selectedProject = ref(''),
  target = ref(''),
  prompt = ref('')
const workflows = ref<Workflow[]>([]),
  workflowId = ref(0),
  cases = ref<WorkflowTestCase[]>([]),
  caseId = ref(0)
const selectedDevices = ref<string[]>([])
const matrices = ref<
  Array<{ matrix_id: string; status: string; definition_version: number; tests: WorkflowTestEvidence[] }>
>([])
const stepTargets = ref<Record<string, string>>({})
const screenshot = ref('')
const ownDevice = ref(''),
  deviceRank = ref(0)
const nativeControl = ref<{
  backend: string
  semanticInput: boolean
  windowInput: boolean
  portal?: unknown
  pointerReason?: string
} | null>(null)
const projectId = computed(() => selectedProject.value || props.projectId || '')
const project = computed(() => state.projects.find(value => value.id === projectId.value))
const mirror = computed(() => projectMirrorState[projectId.value])
const workflow = computed(() => workflows.value.find(value => value.id === workflowId.value))
const devices = computed(() => deviceCluster.coordinator?.devices ?? [])
const labels: Record<string, string> = {
  queued: 'Wartet',
  running: 'Arbeitet',
  completed: 'Abgeschlossen',
  failed: 'Fehlgeschlagen',
  waiting_resource: 'Wartet auf Ressourcen',
  outcome_unknown: 'Ergebnis prüfen',
  cancelled: 'Gestoppt',
  cancelling: 'Wird gestoppt',
}
let previousFocus: HTMLElement | null = null
let generation = 0
let controller = new AbortController()
watch(
  () => props.open,
  async open => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null
      controller.abort()
      controller = new AbortController()
      generation++
      pending.value = false
      selectedProject.value = props.projectId ?? ''
      await nextTick()
      dialog.value?.showModal()
      await perform(refresh)
    } else {
      generation++
      controller.abort()
      dialog.value?.close()
      previousFocus?.focus()
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  controller.abort()
  if (screenshot.value) URL.revokeObjectURL(screenshot.value)
})
async function perform(action: () => Promise<void>) {
  if (pending.value) return
  const captured = generation
  pending.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (cause) {
    if (captured === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (captured === generation) pending.value = false
  }
}
async function exportDiagnostic(download = false) {
  const checks = new Map<string, 'ok' | 'unavailable' | 'not_requested'>()
  const read = async (name: string, args?: Record<string, unknown>) => {
    if (!nativeAvailable) {
      checks.set(name, 'not_requested')
      return null
    }
    try {
      const value = await invoke(name, args)
      checks.set(name, 'ok')
      return value
    } catch {
      checks.set(name, 'unavailable')
      return null
    }
  }
  const owner = nativeAvailable ? await getVerifiedAccountSnapshot().catch(() => null) : null
  const [build, desktop, model, journals] = await Promise.all([
    read('wf_runtime_capabilities'),
    read('desktop_adapter_status'),
    read('local_model_status'),
    owner
      ? read('device_run_journal_list', { payload: { ownerPrincipalId: owner.principalId, limit: 200 } })
      : Promise.resolve(null),
  ])
  diagnosticText.value = JSON.stringify(
    buildCoordinationDiagnostic({
      native: nativeAvailable,
      clientId: owner?.config.clientId,
      build,
      desktop,
      model,
      journals,
      cluster: deviceCluster,
      lan: lanState,
      mirrors: projectMirrorState,
      checks: Object.fromEntries(checks),
    }),
    null,
    2
  )
  if (download) {
    const url = URL.createObjectURL(new Blob([diagnosticText.value], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `luczor-geraetediagnose-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    notice.value = 'Diagnose als JSON bereitgestellt.'
  } else {
    await clipboard.copy(diagnosticText.value)
    notice.value = clipboard.error.value || 'Gerätediagnose kopiert. Du kannst sie zur Auswertung im Chat einfügen.'
  }
}
async function account() {
  if (!nativeAvailable)
    throw new Error(
      'Öffne den Geräteverbund in der Luczor-Desktop-App. Diese Browseransicht zeigt die Oberfläche ohne Geräteverbindung.'
    )
  const value = await getVerifiedAccountSnapshot()
  if (!value) throw new Error('Bitte unter Einstellungen → Server anmelden.')
  return value
}
async function refresh() {
  if (!nativeAvailable) {
    notice.value = 'Browser-Vorschau: Geräteverbindung und Ordnerabgleich stehen in der Luczor-Desktop-App bereit.'
    return
  }
  const owner = await account(),
    api = coordinationApi(owner.config, controller.signal)
  deviceCluster.coordinator = (await api.state()).data
  deviceCluster.jobs = (await api.jobs()).data
  ownDevice.value = owner.config.clientId
  deviceRank.value = (await coordinationMetadata(owner)).model_tier ?? 0
  nativeControl.value = await invoke<NonNullable<typeof nativeControl.value>>('desktop_adapter_status').catch(
    () => null
  )
  if (projectId.value)
    workflows.value = (await createWorkflowApi(owner.config, controller.signal).list(projectId.value)).data
  for (const value of [...matrices.value]) {
    const refreshed = (
      await requestWithConfig<{ data: typeof value }>(
        `/workflow-test-matrices/${value.matrix_id}`,
        { signal: controller.signal },
        owner.config
      )
    ).data
    matrices.value = matrices.value.map(item => (item.matrix_id === value.matrix_id ? refreshed : item))
  }
}
async function configureMaster() {
  const owner = await account()
  const metadata = await coordinationMetadata(owner)
  deviceCluster.coordinator = (
    await coordinationApi(owner.config, controller.signal).heartbeat(
      deviceCluster.activeJobs.length > 0 || hasActiveChatRuns(),
      true,
      { ...metadata, preferred: true }
    )
  ).data
  notice.value =
    'Dieses Gerät ist als bevorzugtes Master-Gerät gespeichert. Eine laufende Übergabe erfolgt nach dem aktuellen Auftrag.'
}
async function configureRank() {
  await setCoordinationRank(await account(), deviceRank.value)
  notice.value = 'Die Rangfolge für die automatische Übernahme wurde gespeichert.'
}
async function configurePortal() {
  const ticket = executionGate.capture(controller.signal)
  await invokeGuarded('desktop_portal_setup', {}, ticket, true)
  nativeControl.value = await invoke('desktop_adapter_status')
  notice.value = 'Die Betriebssystemfreigabe wurde geprüft.'
}
async function delegate() {
  const owner = await account(),
    api = coordinationApi(owner.config, controller.signal)
  const cluster = (await api.state()).data
  if (!target.value || !prompt.value.trim()) throw new Error('Gerät und Auftrag auswählen.')
  await api.dispatch({
    operation_id: crypto.randomUUID(),
    target_device_id: target.value,
    project_id: projectId.value ? projectExternalIdForServer(projectId.value, owner.principalId) : undefined,
    tool_profile: 'chat.turn',
    master_epoch: cluster.epoch,
    payload: { prompt: prompt.value.trim(), model_mode: 'local', thinking_tier: 'balanced', tool_allowlist: [] },
  })
  prompt.value = ''
  notice.value = 'Der Auftrag läuft auf dem Zielgerät. Du kannst hier weiterarbeiten.'
  await refresh()
}
async function cancel(id: string) {
  const owner = await account(),
    api = coordinationApi(owner.config, controller.signal)
  const cluster = (await api.state()).data
  await api.cancel(id, cluster.epoch)
  await refresh()
}
async function showArtifact(jobId: string, hash: unknown) {
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return
  const owner = await account()
  const bytes = await binaryRequest(
    owner.config,
    `/coordination/jobs/${jobId}/artifacts/${hash}`,
    undefined,
    controller.signal
  )
  if (screenshot.value) URL.revokeObjectURL(screenshot.value)
  screenshot.value = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
}
async function selectWorkflow() {
  stepTargets.value = {}
  cases.value = []
  caseId.value = 0
  if (!workflowId.value) return
  const owner = await account()
  cases.value = (
    await requestWithConfig<{ data: WorkflowTestCase[] }>(
      `/workflows/${workflowId.value}/test-cases`,
      { signal: controller.signal },
      owner.config
    )
  ).data
  caseId.value = cases.value[0]?.id ?? 0
}
async function startWorkflow(matrix: boolean) {
  if (!workflow.value) return
  const owner = await account(),
    cluster = (await coordinationApi(owner.config, controller.signal).state()).data
  const body = {
    operation_id: crypto.randomUUID(),
    master_epoch: cluster.epoch,
    expected_version: workflow.value.version,
  }
  if (matrix) {
    if (!caseId.value || !selectedDevices.value.length)
      throw new Error('Testfall und mindestens ein Zielgerät auswählen.')
    const result = await requestWithConfig<{ data: (typeof matrices.value)[number] }>(
      `/workflows/${workflow.value.id}/test-matrices`,
      {
        method: 'POST',
        body: { ...body, test_case_id: caseId.value, mode: 'real', device_ids: selectedDevices.value },
        signal: controller.signal,
      },
      owner.config
    )
    matrices.value.unshift(result.data)
  } else {
    await createWorkflowApi(owner.config, controller.signal).start(workflow.value.id, {
      ...body,
      device_id: target.value || cluster.leader_device_id,
      device_targets: stepTargets.value,
      input: {},
    })
    notice.value = 'Der Workflow wurde mit festen Versionen und den gewählten Geräten gestartet.'
  }
}
</script>

<template>
  <dialog ref="dialog" class="cluster" aria-labelledby="cluster-title" @cancel.prevent="emit('close')">
    <header class="cluster__header">
      <div>
        <span class="cluster__eyebrow">Dein Arbeitsplatz, auf allen Geräten</span>
        <h2 id="cluster-title">Geräteverbund</h2>
      </div>
      <button type="button" class="cluster__icon" aria-label="Geräteverbund schließen" @click="emit('close')">
        <AiIcon name="close" />
      </button>
    </header>
    <nav class="cluster__tabs" aria-label="Geräteverbund-Bereiche">
      <button
        v-for="item in [
          ['devices', 'Geräte'],
          ['files', 'Dateien'],
          ['workflows', 'Workflows'],
          ['tests', 'Testläufe'],
        ] as const"
        :key="item[0]"
        type="button"
        :aria-pressed="tab === item[0]"
        @click="tab = item[0]"
      >
        {{ item[1] }}
      </button>
    </nav>
    <div class="cluster__body">
      <div v-if="error" class="cluster__error" role="alert">{{ error }}</div>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="cluster__toolbar">
        <label
          >Projekt<select v-model="selectedProject" @change="perform(refresh)">
            <option value="">Aktuelles Projekt</option>
            <option v-for="item in state.projects.filter(p => !p.archivedAt)" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select></label
        >
        <button type="button" :disabled="pending" @click="perform(refresh)">
          <AiIcon name="refresh" /> Aktualisieren
        </button>
        <button type="button" :disabled="pending" @click="perform(() => exportDiagnostic())">Diagnose kopieren</button>
      </div>
      <details class="cluster__details">
        <summary>Diagnose für den Gerätetest</summary>
        <p>
          Enthält Versionen, Modellressourcen, Auftragszustände und Verbindungsdaten. Chattexte, Dateiinhalte und
          Zugangsdaten werden ausgelassen.
        </p>
        <button type="button" :disabled="pending" @click="perform(() => exportDiagnostic(true))">
          JSON herunterladen
        </button>
        <textarea
          v-if="diagnosticText"
          :value="diagnosticText"
          readonly
          rows="7"
          aria-label="Gerätediagnose zum Kopieren"
        />
      </details>
      <section v-if="tab === 'devices'">
        <div class="cluster__summary">
          <AiIcon name="network" :size="22" />
          <div>
            <strong>{{
              lanState.active
                ? 'Direkte LAN-Verbindung bereit'
                : nativeAvailable
                  ? 'LAN-Verbindung wird vorbereitet'
                  : 'LAN-Verbindung in der Desktop-App'
            }}</strong>
            <p>
              {{ lanState.peers.length }} bestätigte Geräte · {{ (lanState.transferred / 1048576).toFixed(1) }} MiB
              direkt übertragen
            </p>
            <p v-if="lanState.error">{{ lanState.error }}</p>
          </div>
        </div>
        <div class="cluster__summary">
          <span class="cluster__dot" :class="{ 'is-online': deviceCluster.connected }" />
          <div>
            <strong>{{
              deviceCluster.coordinator?.leader_device_id ? 'Koordinator aktiv' : 'Noch kein Koordinator erreichbar'
            }}</strong>
            <p>
              {{
                deviceCluster.coordinator?.handoff_pending
                  ? 'Rückgabe an das bevorzugte Master-Gerät vorgemerkt.'
                  : 'Aufträge und Ergebnisse bleiben ihrem Gerät und Projekt zugeordnet.'
              }}
            </p>
          </div>
        </div>
        <ul class="cluster__devices">
          <li v-for="device in devices" :key="device.client_id">
            <AiIcon name="panel" :size="22" />
            <div>
              <strong>{{ device.name || device.client_id }}</strong
              ><small
                >{{ device.platform || 'Plattform nicht gemeldet' }} ·
                {{ device.available ? 'Erreichbar' : 'Nicht bereit' }}</small
              >
            </div>
            <span>{{
              device.client_id === deviceCluster.coordinator?.leader_device_id ? 'Koordinator' : 'Assistent'
            }}</span>
          </li>
        </ul>
        <p v-if="!devices.length" class="cluster__empty">
          Melde deine Geräte mit demselben Benutzerkonto an. Ihre Verfügbarkeit wird hier angezeigt.
        </p>
        <details class="cluster__details">
          <summary>Dieses Gerät einrichten</summary>
          <p>{{ ownDevice }}</p>
          <button type="button" :disabled="pending" @click="perform(configureMaster)">
            Als bevorzugtes Master-Gerät verwenden
          </button>
          <label
            >Leistungsrang für Übernahme<select v-model.number="deviceRank" @change="perform(configureRank)">
              <option :value="0">Automatisch anhand des aktiven Modells</option>
              <option v-for="rank in 5" :key="rank" :value="rank">
                {{ rank }} ·
                {{ rank === 5 ? 'höchste Priorität' : rank === 1 ? 'niedrigste Priorität' : 'mittlere Priorität' }}
              </option>
            </select></label
          >
          <p v-if="nativeControl">
            Desktop: {{ nativeControl.backend }} ·
            {{
              nativeControl.windowInput
                ? 'Fenstereingaben verfügbar'
                : nativeControl.semanticInput
                  ? 'Bedienelemente steuerbar'
                  : 'Freigabe prüfen'
            }}
          </p>
          <p v-if="nativeControl?.pointerReason">{{ nativeControl.pointerReason }}</p>
          <button
            v-if="nativeControl?.backend.includes('wayland')"
            type="button"
            :disabled="pending"
            @click="perform(configurePortal)"
          >
            Bildschirm und Eingabe freigeben
          </button>
        </details>
        <details class="cluster__details">
          <summary>Einzelnen Modellauftrag delegieren</summary>
          <label
            >Zielgerät<select v-model="target">
              <option value="">Gerät auswählen</option>
              <option v-for="device in devices" :key="device.client_id" :value="device.client_id">
                {{ device.name || device.client_id }}
              </option>
            </select></label
          ><label>Auftrag<textarea v-model="prompt" rows="3" placeholder="Was soll dieses Gerät bearbeiten?" /></label
          ><small
            >Verwendet das lokale Modell des Zielgeräts. Werkzeugrechte vergibt der Orchestrator gezielt je
            Teilauftrag.</small
          ><button type="button" :disabled="pending || !prompt.trim() || !target" @click="perform(delegate)">
            Auftrag starten
          </button>
        </details>
        <h3>Aufträge</h3>
        <details
          v-for="message in lanState.received.filter(item => item.kind === 'result')"
          :key="message.id"
          class="cluster__job"
        >
          <summary>
            Direkt empfangen · {{ devices.find(device => device.client_id === message.from)?.name || message.from }}
          </summary>
          <p>Ergebnis lokal gesichert. Die Serverbestätigung wird getrennt abgeglichen.</p>
          <pre>{{ JSON.stringify(message.payload.completion, null, 2) }}</pre>
        </details>
        <p v-if="!deviceCluster.jobs.length" class="cluster__empty">Noch keine Geräteaufträge.</p>
        <details v-for="job in deviceCluster.jobs" :key="job.id" class="cluster__job">
          <summary>
            <span>{{ job.tool_profile }}</span
            ><small>{{ labels[job.status] || job.status }}</small>
          </summary>
          <p>Ziel: {{ devices.find(d => d.client_id === job.target_device_id)?.name || job.target_device_id }}</p>
          <p v-if="job.result?.answer">{{ job.result.answer }}</p>
          <pre v-else-if="job.result">{{ JSON.stringify(job.result, null, 2) }}</pre>
          <button
            v-if="job.result?.artifact"
            type="button"
            @click="perform(() => showArtifact(job.id, (job.result!.artifact as Record<string, unknown>).sha256))"
          >
            Screenshot anzeigen
          </button>
          <button
            v-if="['queued', 'running', 'waiting_resource'].includes(job.status)"
            type="button"
            @click="perform(() => cancel(job.id))"
          >
            Diesen Auftrag stoppen
          </button>
        </details>
        <img
          v-if="screenshot"
          class="cluster__screenshot"
          :src="screenshot"
          alt="Erfasster Bildschirm des Zielgeräts"
        />
      </section>
      <section v-else-if="tab === 'files'">
        <h3>Vollständiger Projektordner</h3>
        <p>
          Alle Dateien, versteckten Ordner und Binärdateien werden versioniert übertragen. Der lokale Ordner wird beim
          Übernehmen vorher gesichert.
        </p>
        <p v-if="!project?.cloud" class="cluster__empty">
          Dieses Projekt zuerst unter „Globale Projekte“ mit deinem Benutzerkonto verbinden und einen lokalen Ordner
          auswählen.
        </p>
        <template v-else
          ><div class="cluster__summary">
            <AiIcon name="folder" :size="24" />
            <div>
              <strong>{{ mirror?.stage || 'Zum Abgleich bereit' }}</strong>
              <p>
                Revision {{ mirror?.revision ?? 0 }} · {{ (mirror?.files ?? 0).toLocaleString('de-DE') }} Einträge ·
                {{ ((mirror?.transferred ?? 0) / 1048576).toFixed(1) }} MiB übertragen
              </p>
            </div>
          </div>
          <p v-if="mirror?.error" class="cluster__error">{{ mirror.error }}</p>
          <progress v-if="mirror?.busy" aria-label="Projektabgleich läuft" />
          <div class="cluster__actions">
            <button
              type="button"
              :disabled="pending || mirror?.busy"
              @click="perform(() => syncProjectMirror(projectId))"
            >
              Jetzt abgleichen</button
            ><button type="button" @click="perform(() => pauseProjectMirror(projectId, !mirror?.paused))">
              {{ mirror?.paused ? 'Abgleich fortsetzen' : 'Abgleich pausieren' }}
            </button>
          </div>
          <details v-if="mirror?.backupPath" class="cluster__details">
            <summary>Letzte lokale Sicherung</summary>
            <code>{{ mirror.backupPath }}</code>
          </details></template
        >
      </section>
      <section v-else>
        <h3>{{ tab === 'tests' ? 'Ein Projektstand. Mehrere Geräte.' : 'Gemeinsame Workflows' }}</h3>
        <p>
          {{
            tab === 'tests'
              ? 'Starte denselben Testfall auf Windows und Linux. Jeder Lauf liefert seine tatsächlichen Ergebnisse zurück.'
              : 'Lege für jeden Schritt fest, auf welchem Gerät er ausgeführt wird.'
          }}
        </p>
        <label
          >Workflow<select v-model="workflowId" @change="perform(selectWorkflow)">
            <option :value="0">Workflow auswählen</option>
            <option v-for="item in workflows" :key="item.id" :value="item.id">
              {{ item.name }} · Version {{ item.version }}
            </option>
          </select></label
        >
        <template v-if="workflow"
          ><template v-if="tab === 'workflows'"
            ><label v-for="step in workflow.definition.steps" :key="step.key"
              >{{ step.key }} · {{ step.type
              }}<select v-model="stepTargets[step.key]">
                <option :value="undefined">Koordinator / Standardgerät</option>
                <option v-for="device in devices" :key="device.client_id" :value="device.client_id">
                  {{ device.name || device.client_id }}
                </option>
              </select></label
            ><button type="button" :disabled="pending" @click="perform(() => startWorkflow(false))">
              Workflow starten
            </button></template
          >
          <template v-else
            ><label
              >Testfall<select v-model="caseId">
                <option :value="0">Testfall auswählen</option>
                <option v-for="item in cases" :key="item.id" :value="item.id">{{ item.name }}</option>
              </select></label
            >
            <fieldset>
              <legend>Zielgeräte</legend>
              <label v-for="device in devices" :key="device.client_id" class="cluster__check"
                ><input v-model="selectedDevices" type="checkbox" :value="device.client_id" />{{
                  device.name || device.client_id
                }}
                · {{ device.platform }}</label
              >
            </fieldset>
            <button
              type="button"
              :disabled="pending || !caseId || !selectedDevices.length"
              @click="perform(() => startWorkflow(true))"
            >
              Gerätetests starten
            </button></template
          ></template
        >
        <div v-for="matrix in matrices" :key="matrix.matrix_id" class="cluster__details">
          <strong>Testmatrix · {{ matrix.status }} · Version {{ matrix.definition_version }}</strong>
          <details v-for="test in matrix.tests" :key="test.id" class="cluster__job">
            <summary>{{ test.device_id }} · {{ test.status }}</summary>
            <p>Projektstand: {{ test.code_hash }}</p>
            <pre>{{ JSON.stringify(test.result, null, 2) }}</pre>
          </details>
        </div>
      </section>
    </div>
  </dialog>
</template>

<style scoped>
.cluster {
  margin: auto;
  inset: 0;
  color: var(--ai-text, #e8ebef);
  background: var(--ai-panel, #191d22);
  border: 1px solid var(--ai-border, #373c46);
  border-radius: 16px;
  width: min(880px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  padding: 0;
  box-shadow: 0 24px 100px #0008;
}
.cluster::backdrop {
  background: #080c148a;
}
.cluster__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 28px 18px;
}
.cluster h2 {
  font-size: 24px;
  letter-spacing: -0.03em;
  margin: 5px 0;
}
.cluster__eyebrow,
.cluster small,
.cluster p {
  color: var(--ai-muted, #a3adb9);
}
.cluster__eyebrow {
  font-size: 12px;
}
.cluster__tabs {
  display: flex;
  gap: 6px;
  padding: 0 28px 14px;
  border-bottom: 1px solid var(--ai-border, #373c46);
}
.cluster button,
.cluster select,
.cluster textarea {
  font: inherit;
  color: inherit;
  border: 1px solid var(--ai-border, #373c46);
  border-radius: 8px;
  background: var(--ai-surface, #232830);
  padding: 9px 12px;
}
.cluster button {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
}
.cluster button:disabled {
  opacity: 0.45;
  cursor: default;
}
.cluster button[aria-pressed='true'] {
  color: var(--ai-accent, #66d3d9);
  border-color: currentColor;
}
.cluster__body {
  padding: 22px 28px 30px;
  overflow: auto;
}
.cluster__toolbar,
.cluster__actions {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
}
.cluster label {
  display: grid;
  gap: 7px;
  margin: 12px 0;
  font-size: 13px;
  flex: 1;
}
.cluster select,
.cluster textarea {
  width: 100%;
  box-sizing: border-box;
}
.cluster p {
  font-size: 13px;
  line-height: 1.65;
}
.cluster h3 {
  font-size: 17px;
  margin: 26px 0 10px;
}
.cluster__summary {
  display: flex;
  gap: 14px;
  align-items: center;
  background: var(--ai-surface, #232830);
  padding: 16px;
  border-radius: 10px;
  margin: 16px 0;
}
.cluster__summary p {
  margin: 5px 0 0;
}
.cluster__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #8d96a4;
}
.cluster__dot.is-online {
  background: #74cba6;
}
.cluster__devices {
  list-style: none;
  padding: 0;
}
.cluster__devices li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 0;
  border-bottom: 1px solid var(--ai-border, #373c46);
}
.cluster__devices li div {
  display: grid;
  gap: 5px;
  flex: 1;
}
.cluster__devices li > span {
  font-size: 12px;
  color: var(--ai-muted, #a3adb9);
}
.cluster__details {
  border: 1px solid var(--ai-border, #373c46);
  border-radius: 10px;
  padding: 14px;
  margin: 16px 0;
}
.cluster summary {
  cursor: pointer;
  font-size: 13px;
}
.cluster__job {
  border-bottom: 1px solid var(--ai-border, #373c46);
  padding: 14px 0;
}
.cluster__job summary {
  display: flex;
  justify-content: space-between;
  gap: 14px;
}
.cluster pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  max-height: 320px;
  overflow: auto;
}
.cluster__error {
  color: #f3aaa8;
  background: #6b25252b;
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
}
.cluster__empty {
  padding: 18px 0;
}
.cluster__screenshot {
  width: 100%;
  height: auto;
  margin-top: 16px;
}
.cluster fieldset {
  border: 1px solid var(--ai-border, #373c46);
  border-radius: 8px;
  margin: 16px 0;
}
.cluster .cluster__check {
  display: flex;
  align-items: center;
}
.cluster:focus-visible,
.cluster :focus-visible {
  outline: 2px solid var(--ai-accent, #66d3d9);
  outline-offset: 3px;
}
.cluster progress {
  width: 100%;
}
@media (max-width: 560px) {
  .cluster__header,
  .cluster__body {
    padding: 18px;
  }
  .cluster__tabs {
    padding: 0 18px 12px;
    overflow: auto;
  }
  .cluster__tabs button {
    flex: 1;
    padding: 8px;
  }
  .cluster__devices li {
    align-items: start;
  }
  .cluster__devices li > span {
    max-width: 85px;
  }
  .cluster__toolbar {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
