<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { state } from '@/state/store'
import {
  cloudProjectsState,
  copyCloudProject,
  importCloudProject,
  listCloudProjects,
  pauseCloudProject,
  publishCloudProject,
  syncCloudProjects,
} from '@/services/api/cloudProjects'
import {
  pauseProjectMirror,
  projectMirrorState,
  setProjectFolderShared,
  syncProjectMirror,
} from '@/services/coordination/mirror'
import type { ProjectWorkspaceBinding } from '@/services/projectWorkspace'
import AiIcon from '@/components/ai/AiIcon.vue'

const props = defineProps<{
  open: boolean
  projectId: string
  busy: boolean
  /** Device-local folder binding of the current project; folders are never synchronized as settings. */
  workspace?: ProjectWorkspaceBinding | null
  workspaceBusy?: boolean
}>()
const emit = defineEmits<{ 'update:open': [value: boolean]; select: [id: string]; 'select-folder': [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const working = ref(false)
const error = ref('')
const notice = ref('')
const tab = ref<'projects' | 'files'>('projects')
let viewGeneration = 0
let focusReturn: HTMLElement | null = null
const current = computed(() => state.projects.find(project => project.id === props.projectId))
const linked = computed(() =>
  current.value?.cloud?.principalId === cloudProjectsState.principalId ? current.value.cloud : undefined
)
const status = computed(() => cloudProjectsState.status[props.projectId])
const mirror = computed(() => projectMirrorState[props.projectId])
const folderShared = computed(() => linked.value?.folderShared ?? mirror.value?.shared ?? false)
const folderReady = computed(() => props.workspace?.status === 'ready')
const disabled = computed(
  () => working.value || props.busy || cloudProjectsState.busy || !cloudProjectsState.principalId
)
const localId = (serverId: number) =>
  state.projects.find(
    project => project.cloud?.projectId === serverId && project.cloud.principalId === cloudProjectsState.principalId
  )?.id
const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1)

async function perform(action: () => Promise<void>) {
  if (working.value) return
  const captured = viewGeneration
  working.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (cause) {
    if (captured === viewGeneration)
      error.value = cause instanceof Error ? cause.message : 'Cloud-Projekt konnte nicht abgeglichen werden.'
  } finally {
    if (captured === viewGeneration) working.value = false
  }
}
async function refresh() {
  await listCloudProjects()
}
async function publish() {
  const id = props.projectId
  await perform(async () => {
    await publishCloudProject(id)
    await refresh()
    notice.value = 'Das Projekt ist jetzt auf deinen angemeldeten Geräten erreichbar.'
  })
}
async function synchronize() {
  const id = props.projectId
  await perform(async () => {
    await syncCloudProjects(id)
    await refresh()
  })
}
async function openProject(serverId: number) {
  await perform(async () => {
    const id = localId(serverId) ?? (await importCloudProject(serverId))
    emit('select', id)
    emit('update:open', false)
  })
}
async function reviewConflict() {
  const id = props.projectId
  await perform(async () => {
    const copy = await copyCloudProject(id)
    emit('select', copy)
    notice.value = 'Cloud-Stand als pausierte Projektkopie geöffnet. Dein ursprüngliches Projekt bleibt erhalten.'
  })
}
async function togglePaused() {
  const id = props.projectId
  await perform(async () => {
    await pauseCloudProject(id, !linked.value?.paused)
  })
}
/** The switch lives on the server: one decision for the project, every device follows it. */
async function toggleFolderShared() {
  const id = props.projectId
  const next = !folderShared.value
  await perform(async () => {
    await setProjectFolderShared(id, next)
    notice.value = next
      ? folderReady.value
        ? 'Der Projektordner wird jetzt global gespeichert und auf allen Geräten automatisch abgeglichen.'
        : 'Global aktiviert. Wähle jetzt den lokalen Projektordner, damit der Abgleich auf diesem Gerät startet.'
      : 'Der Abgleich ist auf allen Geräten beendet. Lokale Dateien und die Serverkopie bleiben erhalten.'
  })
}
/** Background folder sync; errors stay in the mirror status instead of the dialog. */
function syncFolder() {
  const id = props.projectId
  if (!linked.value || !folderShared.value || !folderReady.value) return
  void syncProjectMirror(id).catch(() => undefined)
}
async function toggleFolderPaused() {
  const id = props.projectId
  await perform(async () => {
    await pauseProjectMirror(id, !mirror.value?.paused)
    syncFolder()
  })
}
function close() {
  emit('update:open', false)
}
watch(
  () => [props.open, props.projectId] as const,
  async ([open]) => {
    viewGeneration++
    working.value = false
    error.value = ''
    notice.value = ''
    await nextTick()
    if (open) {
      if (!dialog.value?.open) {
        focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null
        dialog.value?.showModal()
      }
      await perform(refresh)
      if (tab.value === 'files') syncFolder()
    } else {
      dialog.value?.close()
      focusReturn?.focus()
    }
  },
  { immediate: true }
)
watch(tab, value => {
  if (value === 'files') syncFolder()
})
// A newly chosen folder on a second device downloads the shared files without waiting for the next poll.
watch(
  () => [props.workspace?.rootPath, props.workspace?.status] as const,
  ([rootPath, workspaceStatus], previous) => {
    if (props.open && rootPath && workspaceStatus === 'ready' && rootPath !== previous?.[0]) syncFolder()
  }
)
const identityChanged = () => {
  viewGeneration++
  error.value = ''
  close()
}
window.addEventListener('luczor:api-identity-changing', identityChanged)
onBeforeUnmount(() => {
  viewGeneration++
  window.removeEventListener('luczor:api-identity-changing', identityChanged)
})
</script>

<template>
  <dialog ref="dialog" class="cloud-projects" aria-labelledby="cloud-projects-title" @cancel.prevent="close">
    <header>
      <div>
        <span class="eyebrow">Dein Luczor-Konto</span>
        <h2 id="cloud-projects-title">Globale Projekte</h2>
      </div>
      <button type="button" class="ai-icon-button" aria-label="Globale Projekte schließen" @click="close">
        <AiIcon name="close" />
      </button>
    </header>
    <nav class="tabs" aria-label="Cloud-Projektbereiche">
      <button type="button" :aria-pressed="tab === 'projects'" @click="tab = 'projects'">Projekte</button>
      <button type="button" :aria-pressed="tab === 'files'" @click="tab = 'files'">Projektdateien</button>
    </nav>
    <div class="body">
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="notice" role="status" class="notice">{{ notice }}</p>
      <p v-if="props.busy" class="subtle">
        Luczor arbeitet noch. Der Projektabgleich ist nach dem Auftrag wieder verfügbar.
      </p>
      <template v-if="tab === 'projects'">
        <section class="current">
          <div>
            <span class="eyebrow">Aktuelles Projekt</span>
            <h3>{{ current?.name }}</h3>
          </div>
          <p>
            Projektziele, öffentliche Chats, Projekterinnerungen und Zusammenfassungen stehen auf deinen Geräten zur
            Verfügung. Der Projektordner wird unter „Projektdateien“ freigegeben; welcher lokale Ordner dazugehört,
            bleibt pro Gerät gewählt.
          </p>
          <template v-if="linked">
            <p role="status" class="subtle">
              {{
                linked.paused
                  ? 'Abgleich auf diesem Gerät pausiert'
                  : (status?.message ?? `Global · Version ${linked.revision}`)
              }}
            </p>
            <div class="actions">
              <button type="button" :disabled="disabled || linked.paused" @click="synchronize">Jetzt abgleichen</button>
              <button type="button" :disabled="disabled" @click="togglePaused">
                {{ linked.paused ? 'Abgleich fortsetzen' : 'Auf diesem Gerät pausieren' }}
              </button>
              <button v-if="status?.state === 'conflict'" type="button" :disabled="disabled" @click="reviewConflict">
                Cloud-Stand als Kopie öffnen
              </button>
            </div>
          </template>
          <button v-else type="button" :disabled="disabled || !current || !!current.cloud" @click="publish">
            Dieses Projekt global bereitstellen
          </button>
        </section>
        <div class="section-title">
          <h3>Auf deinen Geräten verfügbar</h3>
          <button type="button" :disabled="working" @click="perform(refresh)">Aktualisieren</button>
        </div>
        <ul class="project-list">
          <li v-for="project in cloudProjectsState.projects" :key="project.id">
            <div>
              <strong>{{ project.name }}</strong
              ><span class="subtle"
                >{{ localId(project.id) ? 'Auf diesem Gerät vorhanden' : 'Vom Server öffnen'
                }}{{ project.folder_shared ? ' · Projektordner global' : '' }}</span
              >
            </div>
            <button type="button" :disabled="disabled" @click="openProject(project.id)">Öffnen</button>
          </li>
        </ul>
        <p v-if="!cloudProjectsState.projects.length" class="subtle">Noch keine globalen Projekte vorhanden.</p>
      </template>
      <template v-else>
        <p>
          Der gesamte Projektordner wird auf dem Server gespeichert und auf allen angemeldeten Geräten automatisch
          abgeglichen – wie ein gemeinsames Repository, nur ohne manuelles Commit, Push und Pull.
        </p>
        <p v-if="!linked" class="subtle">Stelle das aktuelle Projekt zuerst im Tab „Projekte“ global bereit.</p>
        <template v-else>
          <section class="folder">
            <div class="section-title">
              <h3>Lokaler Projektordner auf diesem Gerät</h3>
              <button type="button" :disabled="disabled || props.workspaceBusy" @click="emit('select-folder')">
                {{ props.workspace ? 'Anderen Ordner wählen' : 'Projektordner auswählen' }}
              </button>
            </div>
            <p v-if="props.workspace">
              <code>{{ props.workspace.rootPath }}</code>
              <span v-if="!folderReady" class="subtle"> · derzeit nicht verfügbar ({{ props.workspace.status }})</span>
            </p>
            <p v-else class="subtle">
              Noch kein Ordner zugeordnet. Wähle den Ordner, der global gespeichert werden soll – oder auf einem
              weiteren Gerät einen leeren Zielordner, in den die Serverdateien geladen werden. Einzelne Dateien werden
              nicht ausgewählt; es zählt immer der ganze Ordner.
            </p>
          </section>
          <section class="folder">
            <label class="switch">
              <input
                type="checkbox"
                role="switch"
                :checked="folderShared"
                :disabled="disabled"
                @change="toggleFolderShared"
              />
              <span>Projektordner global speichern</span>
            </label>
            <p class="subtle">
              Ein: Der Ordner wird auf den Server geladen und auf jedem Gerät mit zugeordnetem Ordner laufend aktuell
              gehalten; alle Dateien, versteckte Ordner und Binärdateien eingeschlossen. Aus: Der Abgleich endet auf
              allen Geräten; lokale Dateien und die Serverkopie bleiben erhalten.
            </p>
          </section>
          <section v-if="folderShared" class="folder">
            <div class="status-row">
              <AiIcon name="folder" :size="22" />
              <div>
                <strong>{{
                  folderReady ? mirror?.stage || 'Zum Abgleich bereit' : 'Lokalen Projektordner zuordnen'
                }}</strong>
                <p class="subtle">
                  Revision {{ mirror?.revision ?? 0 }} · {{ (mirror?.files ?? 0).toLocaleString('de-DE') }} Einträge ·
                  {{ megabytes(mirror?.transferred ?? 0) }} MiB übertragen
                </p>
              </div>
            </div>
            <p v-if="mirror?.error" class="error">{{ mirror.error }}</p>
            <p v-if="mirror?.conflicts" class="subtle">
              {{ mirror.conflicts }} überlappende Änderung{{ mirror.conflicts === 1 ? '' : 'en' }}: Die Fassung des
              anderen Geräts behält den Namen, deine Fassung liegt als Konfliktkopie („.konflikt-…“) daneben.
            </p>
            <progress v-if="mirror?.busy" aria-label="Projektordner wird abgeglichen" />
            <div class="actions">
              <button type="button" :disabled="disabled || !folderReady || mirror?.busy" @click="syncFolder">
                Jetzt abgleichen
              </button>
              <button type="button" :disabled="disabled || !folderReady" @click="toggleFolderPaused">
                {{ mirror?.paused ? 'Abgleich auf diesem Gerät fortsetzen' : 'Auf diesem Gerät pausieren' }}
              </button>
            </div>
            <details v-if="mirror?.backupPath" class="details">
              <summary>Letzte lokale Sicherung ersetzter oder gelöschter Dateien</summary>
              <code>{{ mirror.backupPath }}</code>
            </details>
          </section>
        </template>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.cloud-projects {
  inset: 0;
  margin: auto;
  width: min(840px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  padding: 0;
  border: 1px solid var(--ai-line, #34383e);
  border-radius: 14px;
  background: var(--ai-surface, #1b1d20);
  color: var(--text-primary, #e9edf3);
}
.cloud-projects::backdrop {
  background: rgb(0 0 0 / 48%);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 22px 24px 16px;
  gap: 16px;
}
h2,
h3,
p {
  margin: 0;
}
h2 {
  font-size: 21px;
}
h3 {
  font-size: 15px;
}
.eyebrow {
  display: block;
  color: var(--text-muted, #98a2b1);
  font-size: 11px;
  margin-bottom: 6px;
}
.tabs {
  display: flex;
  gap: 8px;
  padding: 0 24px 14px;
  border-bottom: 1px solid var(--ai-line, #34383e);
}
.body {
  padding: 22px 24px;
  display: grid;
  gap: 18px;
  overflow: auto;
  max-height: calc(100dvh - 180px);
}
p {
  font-size: 13px;
  line-height: 1.65;
}
.current,
.folder {
  display: grid;
  gap: 14px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--ai-line, #34383e);
}
.section-title,
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.section-title {
  justify-content: space-between;
}
.subtle {
  color: var(--text-muted, #98a2b1);
  font-size: 12px;
}
.notice {
  color: var(--success, #91d9b4);
}
.error {
  color: var(--danger, #f394a0);
}
button {
  font: inherit;
  font-size: 12px;
  padding: 9px 12px;
  border: 1px solid var(--ai-line, #34383e);
  border-radius: 7px;
  background: var(--ai-hover, #24272c);
  color: inherit;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button[aria-pressed='true'] {
  border-color: var(--ai-accent, #7c9cff);
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--ai-accent, #7c9cff);
  outline-offset: 3px;
}
.project-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.project-list li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 14px 0;
  border-bottom: 1px solid var(--ai-line, #34383e);
}
.project-list li div {
  display: grid;
  gap: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}
code {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.switch {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.switch input {
  appearance: none;
  width: 38px;
  height: 22px;
  margin: 0;
  border-radius: 11px;
  border: 1px solid var(--ai-line, #34383e);
  background: var(--ai-page, #15171a);
  position: relative;
  cursor: pointer;
  flex: none;
}
.switch input::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text-muted, #98a2b1);
  transition:
    transform 0.15s ease,
    background 0.15s ease;
}
.switch input:checked {
  border-color: var(--ai-accent, #7c9cff);
  background: color-mix(in srgb, var(--ai-accent, #7c9cff) 35%, transparent);
}
.switch input:checked::after {
  transform: translateX(16px);
  background: var(--ai-accent, #7c9cff);
}
.switch input:disabled {
  opacity: 0.45;
  cursor: default;
}
.status-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.status-row strong {
  display: block;
  margin-bottom: 4px;
}
progress {
  width: 100%;
}
.details summary {
  cursor: pointer;
  font-size: 12px;
}
@media (max-width: 600px) {
  header,
  .body {
    padding: 16px;
  }
  .tabs {
    padding-inline: 16px;
  }
  .actions {
    align-items: stretch;
  }
  .actions button {
    flex: 1;
  }
}
</style>
