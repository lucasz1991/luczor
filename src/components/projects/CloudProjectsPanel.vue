<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { state } from '@/state/store'
import {
  cloudProjectsState,
  cloudProjectFiles,
  copyCloudProject,
  importCloudProject,
  listCloudProjects,
  pauseCloudProject,
  publishCloudProject,
  readCloudProjectFile,
  saveCloudProjectFile,
  syncCloudProjects,
  type CloudProjectFile,
} from '@/services/api/cloudProjects'
import AiIcon from '@/components/ai/AiIcon.vue'

const props = defineProps<{ open: boolean; projectId: string; busy: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; select: [id: string] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const working = ref(false)
const error = ref('')
const notice = ref('')
const tab = ref<'projects' | 'files'>('projects')
const files = ref<CloudProjectFile[]>([])
const filePath = ref('')
const fileContent = ref('')
const fileRevision = ref(0)
const openedFilePath = ref('')
const fileDirty = ref(false)
let viewGeneration = 0
let focusReturn: HTMLElement | null = null
const current = computed(() => state.projects.find(project => project.id === props.projectId))
const linked = computed(() =>
  current.value?.cloud?.principalId === cloudProjectsState.principalId ? current.value.cloud : undefined
)
const status = computed(() => cloudProjectsState.status[props.projectId])
const disabled = computed(
  () => working.value || props.busy || cloudProjectsState.busy || !cloudProjectsState.principalId
)
const localId = (serverId: number) =>
  state.projects.find(
    project => project.cloud?.projectId === serverId && project.cloud.principalId === cloudProjectsState.principalId
  )?.id

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
async function refreshFiles() {
  const captured = viewGeneration
  const result = await cloudProjectFiles(props.projectId)
  if (captured === viewGeneration) files.value = result
}
async function openFile(file: CloudProjectFile) {
  if (fileDirty.value) {
    error.value = 'Dateientwurf zuerst speichern oder über „Neue Datei“ verwerfen.'
    return
  }
  const id = props.projectId
  const captured = viewGeneration
  await perform(async () => {
    const result = await readCloudProjectFile(id, file.path)
    if (captured !== viewGeneration) return
    filePath.value = result.path
    openedFilePath.value = result.path
    fileContent.value = result.content
    fileRevision.value = result.revision
    fileDirty.value = false
  })
}
function newFile() {
  filePath.value = ''
  openedFilePath.value = ''
  fileContent.value = ''
  fileRevision.value = 0
  fileDirty.value = false
}
async function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement
  const selected = input.files?.[0]
  input.value = ''
  if (!selected) return
  if (fileDirty.value) {
    error.value = 'Den offenen Dateientwurf zuerst speichern oder verwerfen.'
    return
  }
  const captured = viewGeneration
  await perform(async () => {
    if (selected.size > 1024 * 1024) throw new Error('Bitte eine Textdatei bis 1 MiB auswählen.')
    const bytes = await selected.arrayBuffer()
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (content.includes('\0')) throw new Error('Binärdateien werden im Projekt-Dateispeicher nicht unterstützt.')
    if (captured !== viewGeneration) return
    filePath.value = selected.name
    openedFilePath.value = ''
    fileContent.value = content
    fileRevision.value = 0
    fileDirty.value = true
  })
}
async function saveFile() {
  const id = props.projectId
  const captured = viewGeneration
  const path = filePath.value.trim()
  const content = fileContent.value
  const revision = openedFilePath.value === path ? fileRevision.value : 0
  await perform(async () => {
    const saved = await saveCloudProjectFile(id, path, content, revision)
    if (captured !== viewGeneration) return
    fileRevision.value = saved.revision
    openedFilePath.value = saved.path
    fileDirty.value = content !== fileContent.value || path !== filePath.value.trim()
    notice.value = `Datei gespeichert · Version ${saved.revision}`
    await refreshFiles()
  })
}
function downloadFile() {
  const url = URL.createObjectURL(new Blob([fileContent.value], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filePath.value.split('/').at(-1) || 'projekt.txt'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
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
    files.value = []
    newFile()
    await nextTick()
    if (open) {
      if (!dialog.value?.open) {
        focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null
        dialog.value?.showModal()
      }
      await perform(async () => {
        await refresh()
        if (tab.value === 'files' && linked.value) await refreshFiles()
      })
    } else {
      dialog.value?.close()
      focusReturn?.focus()
    }
  },
  { immediate: true }
)
watch(tab, value => {
  if (value === 'files' && linked.value) void perform(refreshFiles)
})
const identityChanged = () => {
  viewGeneration++
  error.value = ''
  files.value = []
  newFile()
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
            Verfügung. Lokale Ordner bleiben pro Gerät zugeordnet.
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
              ><span class="subtle">{{
                localId(project.id) ? 'Auf diesem Gerät vorhanden' : 'Vom Server öffnen'
              }}</span>
            </div>
            <button type="button" :disabled="disabled" @click="openProject(project.id)">Öffnen</button>
          </li>
        </ul>
        <p v-if="!cloudProjectsState.projects.length" class="subtle">Noch keine globalen Projekte vorhanden.</p>
      </template>
      <template v-else>
        <p>
          Ausgewählte UTF-8-Textdateien gemeinsam bearbeiten. Bis 1 MiB pro Datei; das Projektverzeichnis wird nicht
          automatisch hochgeladen.
        </p>
        <p v-if="!linked" class="subtle">Stelle das aktuelle Projekt zuerst im Tab „Projekte“ global bereit.</p>
        <template v-else>
          <div class="actions">
            <button type="button" :disabled="working" @click="perform(refreshFiles)">Dateiliste aktualisieren</button
            ><button type="button" :disabled="working" @click="newFile">
              {{ fileDirty ? 'Entwurf verwerfen / neue Datei' : 'Neue Datei' }}</button
            ><label class="file-picker"
              >Datei auswählen<input type="file" :disabled="working" @change="chooseFile"
            /></label>
          </div>
          <ul class="file-list">
            <li v-for="file in files" :key="file.path">
              <button type="button" :disabled="working" @click="openFile(file)">
                {{ file.path }} <span class="subtle">v{{ file.revision }} · {{ file.bytes }} Bytes</span>
              </button>
            </li>
          </ul>
          <label class="field"
            >Pfad im Cloud-Projekt<input
              v-model="filePath"
              placeholder="docs/README.md"
              maxlength="240"
              @input="fileDirty = true"
          /></label>
          <label class="field"
            >Dateiinhalt<textarea v-model="fileContent" rows="12" spellcheck="false" @input="fileDirty = true" />
          </label>
          <div class="actions">
            <button type="button" :disabled="working || !filePath.trim() || !fileDirty" @click="saveFile">
              In Cloud speichern</button
            ><button type="button" :disabled="!filePath.trim()" @click="downloadFile">Datei herunterladen</button>
          </div>
          <p class="subtle">
            Gleichzeitige Änderungen werden als Konflikt angezeigt. Dein Dateientwurf bleibt dabei erhalten.
          </p>
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
.current {
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
button,
.file-picker {
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
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--ai-accent, #7c9cff);
  outline-offset: 3px;
}
.project-list,
.file-list {
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
.file-list li {
  margin-bottom: 6px;
}
.file-picker input {
  max-width: 190px;
  margin-left: 10px;
}
.field {
  display: grid;
  gap: 7px;
  font-size: 12px;
}
.field input,
.field textarea {
  padding: 10px;
  background: var(--ai-page, #15171a);
  color: inherit;
  border: 1px solid var(--ai-line, #34383e);
  border-radius: 7px;
  width: 100%;
  box-sizing: border-box;
}
.field textarea {
  font-family: monospace;
  resize: vertical;
}
@media (max-width: 600px) {
  header,
  .body {
    padding: 16px;
  }
  .tabs {
    padding-inline: 16px;
  }
  .file-picker input {
    display: block;
    margin: 8px 0 0;
  }
  .actions {
    align-items: stretch;
  }
  .actions button {
    flex: 1;
  }
}
</style>
