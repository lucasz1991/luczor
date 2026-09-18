<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ProjectWorkspaceBinding } from '@/services/projectWorkspace'
import type { RepositoryExternalPolicy, RepositoryGraphStatus } from '@/services/repositoryGraph'
import { idleOptimizationEnabled, saveIdleOptimizationSetting } from '@/services/agents/idleOptimization'
import { idleEmergencyOffload, saveIdleEmergencyOffloadSetting } from '@/services/agents/idleOffloadSetting'
import {
  loadMemoryGraphDisplay,
  memoryGraphDisplay,
  saveMemoryGraphDisplay,
  type MemoryGraphDisplay,
} from '@/features/memory/graphDisplay'

type Tab = 'folder' | 'graph' | 'display'

const props = withDefaults(
  defineProps<{
    open: boolean
    project: { id: string; name: string; goal?: string | null } | undefined
    workspace: ProjectWorkspaceBinding | null
    workspaceBusy?: boolean
    workspaceMessage?: string
    graphStatus: RepositoryGraphStatus
    graphBusy?: boolean
    graphMessage?: string
    policy: RepositoryExternalPolicy
    initialTab?: Tab
  }>(),
  { workspaceBusy: false, workspaceMessage: '', graphBusy: false, graphMessage: '', initialTab: 'folder' }
)
const emit = defineEmits<{
  (event: 'update:open', value: boolean): void
  (event: 'bind'): void
  (event: 'change-folder'): void
  (event: 'reindex'): void
  (event: 'unbind'): void
  (event: 'update:policy', value: RepositoryExternalPolicy): void
  (event: 'rename', value: string): void
  (event: 'open-memory'): void
}>()

const tabs: Array<{ id: Tab; title: string; desc: string; icon: string }> = [
  { id: 'folder', title: 'Ordner', desc: 'Projektordner & @project', icon: 'M3 6h7l2 3h9v11H3Z' },
  {
    id: 'graph',
    title: 'Graph-Erkennung',
    desc: 'Index, LSP, Egress',
    icon: 'M6 6h.01M18 6h.01M12 18h.01M6 6l6 12M18 6l-6 12M6 6h12',
  },
  {
    id: 'display',
    title: 'Darstellung',
    desc: '3D-Wissensraum',
    icon: 'M12 3l9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  },
]
const tab = ref<Tab>(props.initialTab)
const scroller = ref<HTMLElement | null>(null)
watch(tab, () => {
  if (scroller.value) scroller.value.scrollTop = 0
})
const name = ref(props.project?.name ?? '')
watch(
  () => props.open,
  open => {
    if (open) {
      tab.value = props.initialTab
      name.value = props.project?.name ?? ''
      void loadMemoryGraphDisplay()
    }
  }
)
watch(
  () => props.project?.name,
  value => {
    name.value = value ?? ''
  }
)

const GRAPH_STATES: Record<RepositoryGraphStatus['status'], string> = {
  unbound: 'nicht gebunden',
  unindexed: 'noch nicht indexiert',
  indexing: 'wird indexiert',
  ready: 'bereit',
  stale: 'veraltet',
  error: 'Fehler',
}
const LSP_STATES = {
  ready: 'bereit',
  partial: 'teilweise analysiert',
  unavailable: 'Runtime fehlt',
  not_applicable: 'keine passenden Dateien',
  error: 'Analyse fehlgeschlagen',
} as const
const indexedAt = computed(() =>
  props.graphStatus.last_indexed_at
    ? new Date(props.graphStatus.last_indexed_at * 1000).toLocaleString('de-DE', {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '—'
)
const savingIdle = ref(false)
const idleError = ref('')
async function toggleIdle() {
  savingIdle.value = true
  idleError.value = ''
  try {
    await saveIdleOptimizationSetting(!idleOptimizationEnabled.value)
  } catch {
    idleError.value = 'Die Einstellung konnte nicht gespeichert werden.'
  } finally {
    savingIdle.value = false
  }
}
const savingOffload = ref(false)
async function toggleOffload() {
  savingOffload.value = true
  idleError.value = ''
  try {
    await saveIdleEmergencyOffloadSetting(!idleEmergencyOffload.value)
  } catch {
    idleError.value = 'Die Einstellung konnte nicht gespeichert werden.'
  } finally {
    savingOffload.value = false
  }
}
const display = computed(() => memoryGraphDisplay.value)
function setDisplay<K extends keyof MemoryGraphDisplay>(key: K, value: MemoryGraphDisplay[K]) {
  void saveMemoryGraphDisplay({ [key]: value } as Partial<MemoryGraphDisplay>)
}
function commitName() {
  const next = name.value.trim()
  if (next && props.project && next !== props.project.name) emit('rename', next)
  else name.value = props.project?.name ?? ''
}
function close() {
  emit('update:open', false)
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) {
    event.preventDefault()
    close()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <teleport to="body">
    <div v-if="open" class="lz-root project-settings">
      <button type="button" class="lz-backdrop" aria-label="Projekteinstellungen schließen" @click="close" />
      <div class="lz-modal project-settings__modal" role="dialog" aria-modal="true" aria-label="Projekteinstellungen">
        <div class="lz-head">
          <div class="lz-head__brand">
            <span class="lz-dot" />
            <div>
              <div class="lz-title">Projekteinstellungen</div>
              <div class="lz-sub">{{ project?.name ?? 'Kein Projekt' }} · Ordner, Graph-Erkennung, Darstellung</div>
            </div>
          </div>
          <div class="lz-head__actions">
            <button type="button" class="lz-x" title="Schließen (Esc)" @click="close">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div class="lz-body">
          <aside class="lz-nav" role="tablist" aria-label="Bereiche der Projekteinstellungen">
            <div class="tac-label lz-nav__label">Projekt</div>
            <button
              v-for="item in tabs"
              :key="item.id"
              type="button"
              class="lz-tab"
              :class="{ 'is-active': tab === item.id }"
              role="tab"
              :aria-selected="tab === item.id"
              @click="tab = item.id"
            >
              <span class="lz-tab__icon">
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path :d="item.icon" />
                </svg>
              </span>
              <span class="min-w-0">
                <span class="lz-tab__title">{{ item.title }}</span>
                <span class="lz-tab__desc">{{ item.desc }}</span>
              </span>
            </button>
          </aside>

          <section class="lz-main" role="tabpanel">
            <div ref="scroller" class="lz-scroll">
              <!-- Ordner -->
              <div v-if="tab === 'folder'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Projektordner</h3>
                  <p>
                    Der Ordner, auf den <span class="mono">@project</span>, Dateiwerkzeuge und Coding-Agenten begrenzt
                    sind.
                  </p>
                </div>
                <div class="lz-card">
                  <label class="lz-label" for="project-settings-name">Projektname</label>
                  <input
                    id="project-settings-name"
                    v-model="name"
                    class="lz-input"
                    maxlength="160"
                    :disabled="!project"
                    @blur="commitName"
                    @keydown.enter.prevent="commitName"
                  />
                  <p class="lz-hint">
                    Der Name erscheint in der Kopfzeile, im Bildschirmrand-Nudge und in Kontextpaketen.
                  </p>
                </div>
                <div class="lz-card">
                  <div class="lz-card__head">
                    <div>
                      <div class="lz-card__title">Lokaler Ordner</div>
                      <div class="lz-card__meta">
                        {{
                          workspace
                            ? workspace.status === 'ready'
                              ? 'bereit'
                              : workspace.status === 'missing'
                                ? 'Ordner fehlt'
                                : 'kein Zugriff'
                            : 'nicht zugeordnet'
                        }}
                      </div>
                    </div>
                    <span class="project-settings__badge" :data-state="workspace?.status ?? 'unbound'">
                      {{ workspace ? (workspace.isGitRepository ? 'Git-Repository' : 'Projektordner') : 'offen' }}
                    </span>
                  </div>
                  <template v-if="workspace">
                    <dl class="project-settings__facts">
                      <div>
                        <dt>Anzeige</dt>
                        <dd>{{ workspace.displayName }}</dd>
                      </div>
                      <div>
                        <dt>Pfad</dt>
                        <dd>
                          <code :title="workspace.rootPath">{{ workspace.rootPath }}</code>
                        </dd>
                      </div>
                      <div v-if="workspace.gitRootPath && workspace.gitRootPath !== workspace.rootPath">
                        <dt>Git-Wurzel</dt>
                        <dd>
                          <code>{{ workspace.gitRootPath }}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Modellpfad</dt>
                        <dd><span class="mono">@project</span> → dieser Ordner</dd>
                      </div>
                    </dl>
                  </template>
                  <p v-else class="lz-hint">
                    Ohne Ordner antwortet Luczor nur aus Gespräch und Erinnerungen. Wähle einen Ordner, damit
                    <span class="mono">@project</span> greift und der Repository-Graph aufgebaut werden kann.
                  </p>
                  <div class="lz-actions">
                    <button
                      v-if="!workspace"
                      type="button"
                      class="lz-btn lz-btn--primary"
                      :disabled="workspaceBusy || !project"
                      @click="emit('bind')"
                    >
                      Ordner auswählen
                    </button>
                    <button
                      v-else
                      type="button"
                      class="lz-btn lz-btn--ghost"
                      :disabled="workspaceBusy || graphBusy"
                      @click="emit('change-folder')"
                    >
                      Ordner wechseln
                    </button>
                    <button
                      v-if="workspace"
                      type="button"
                      class="lz-btn lz-btn--ghost project-settings__danger"
                      :disabled="workspaceBusy || graphBusy"
                      @click="emit('unbind')"
                    >
                      Zuordnung lösen
                    </button>
                  </div>
                  <p v-if="workspaceMessage" class="lz-result">{{ workspaceMessage }}</p>
                </div>
                <div class="lz-card">
                  <div class="lz-card__title">Was gilt für diesen Ordner</div>
                  <ul class="project-settings__rules">
                    <li>Dateiwerkzeuge und Coding-Agenten dürfen nur innerhalb dieses Ordners lesen und schreiben.</li>
                    <li>
                      Der absolute Pfad bleibt auf diesem Gerät; externe Modelle sehen nur
                      <span class="mono">@project</span>.
                    </li>
                    <li>
                      Ausschlüsse steuerst du über <span class="mono">.gitignore</span> und eine optionale
                      <span class="mono">.luczorignore</span> im Ordner – beide gelten für Index und Graph.
                    </li>
                  </ul>
                </div>
              </div>

              <!-- Graph-Erkennung -->
              <div v-else-if="tab === 'graph'" class="lz-section">
                <div class="lz-section__head">
                  <h3>Graph-Erkennung</h3>
                  <p>Wie Luczor Dateien, Symbole und Beziehungen im Projektordner erkennt und aktuell hält.</p>
                </div>
                <div class="lz-card">
                  <div class="lz-card__head">
                    <div>
                      <div class="lz-card__title">Repository-Graph</div>
                      <div class="lz-card__meta">
                        {{ GRAPH_STATES[graphStatus.status] }} · indexiert {{ indexedAt }}
                      </div>
                    </div>
                    <span class="project-settings__badge" :data-state="graphStatus.status">{{
                      GRAPH_STATES[graphStatus.status]
                    }}</span>
                  </div>
                  <div class="project-settings__stats">
                    <div>
                      <b>{{ graphStatus.files }}</b
                      ><span>Dateien</span>
                    </div>
                    <div>
                      <b>{{ graphStatus.symbols }}</b
                      ><span>Symbole</span>
                    </div>
                    <div>
                      <b>{{ graphStatus.edges }}</b
                      ><span>Beziehungen</span>
                    </div>
                    <div>
                      <b>{{ graphStatus.skipped }}</b
                      ><span>übersprungen</span>
                    </div>
                  </div>
                  <dl class="project-settings__facts">
                    <div v-if="graphStatus.branch || graphStatus.commit_sha">
                      <dt>Revision</dt>
                      <dd>
                        <code>{{ graphStatus.branch || 'detached' }} · {{ graphStatus.commit_sha?.slice(0, 10) }}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>LSP TS/JS</dt>
                      <dd v-if="graphStatus.lsp">
                        {{ LSP_STATES[graphStatus.lsp.status] }} · {{ graphStatus.lsp.scanned }}/{{
                          graphStatus.lsp.files
                        }}
                        Dateien · {{ graphStatus.lsp.edges }} Referenzen
                      </dd>
                      <dd v-else>noch nicht ausgeführt</dd>
                    </div>
                  </dl>
                  <p v-if="workspace && !workspace.isGitRepository" class="lz-hint">
                    Die Graph-Erkennung setzt ein Git-Repository voraus. Dieser Ordner ist ein normaler Projektordner;
                    <span class="mono">@project</span> funktioniert trotzdem.
                  </p>
                  <p v-else-if="!workspace" class="lz-hint">Erst einen Projektordner zuordnen (Bereich „Ordner“).</p>
                  <div class="lz-actions">
                    <button
                      type="button"
                      class="lz-btn lz-btn--primary"
                      :disabled="graphBusy || !workspace?.isGitRepository"
                      @click="emit('reindex')"
                    >
                      {{
                        graphStatus.status === 'unbound' || graphStatus.status === 'unindexed'
                          ? 'Index aufbauen'
                          : 'Neu indexieren'
                      }}
                    </button>
                    <button
                      v-if="workspace"
                      type="button"
                      class="lz-btn lz-btn--ghost project-settings__danger"
                      :disabled="graphBusy || workspaceBusy"
                      @click="emit('unbind')"
                    >
                      Index löschen &amp; Zuordnung lösen
                    </button>
                  </div>
                  <p v-if="graphMessage || graphStatus.error" class="lz-result">
                    {{ graphMessage || graphStatus.error }}
                  </p>
                </div>
                <div class="lz-card">
                  <div class="lz-card__title">Erkennungsregeln</div>
                  <ul class="project-settings__rules">
                    <li>
                      <span class="mono">.gitignore</span> und <span class="mono">.luczorignore</span> werden
                      respektiert; Symlinks werden nicht verfolgt.
                    </li>
                    <li>Dateien über 2 MB, Binärdateien und Geheimnismuster werden übersprungen bzw. redigiert.</li>
                    <li>
                      TypeScript/JavaScript wird zusätzlich per LSP auf Referenzen analysiert, wenn die Runtime
                      vorhanden ist.
                    </li>
                    <li>Änderungen werden inkrementell nach Datei-Hash und Git-Revision erkannt.</li>
                  </ul>
                </div>
                <div class="lz-card">
                  <div class="lz-row">
                    <div>
                      <div class="lz-card__title">Im Leerlauf aktuell halten</div>
                      <p class="lz-hint">
                        Die Leerlauf-Pflege („Träumen“) aktualisiert den Index inkrementell und verdichtet Erinnerungen
                        – lokal, ohne Werkzeuge, nur wenn kein Auftrag läuft.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': idleOptimizationEnabled }"
                      role="switch"
                      :aria-checked="idleOptimizationEnabled"
                      :disabled="savingIdle"
                      aria-label="Leerlauf-Pflege"
                      @click="toggleIdle"
                    >
                      <span />
                    </button>
                  </div>
                  <div class="lz-row">
                    <div>
                      <div class="lz-card__title">Notfall-Auslagerung auf den Datenträger</div>
                      <p class="lz-hint">
                        Wird beim Träumen der Arbeitsspeicher knapp, läuft der Durchgang weiter über die
                        Auslagerungsdatei (SSD): Modellgewichte per Speicherabbildung, kleinere Quellenbündel. Deutlich
                        langsamer, greift nur bei RAM-Mangel und lässt mindestens 3 % des RAM für den Desktop frei.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': idleEmergencyOffload }"
                      role="switch"
                      :aria-checked="idleEmergencyOffload"
                      :disabled="savingOffload"
                      aria-label="Notfall-Auslagerung"
                      @click="toggleOffload"
                    >
                      <span />
                    </button>
                  </div>
                  <p v-if="idleError" class="lz-error">{{ idleError }}</p>
                </div>
                <div class="lz-card">
                  <label class="lz-label" for="project-settings-policy">Code an externe Modelle</label>
                  <select
                    id="project-settings-policy"
                    class="lz-input"
                    :value="policy"
                    @change="
                      emit('update:policy', ($event.target as HTMLSelectElement).value as RepositoryExternalPolicy)
                    "
                  >
                    <option value="deny">Nie übertragen</option>
                    <option value="ask">Nur nach Freigabe</option>
                    <option value="allow_selected">Ausgewählte Treffer erlauben</option>
                  </select>
                  <p class="lz-hint">
                    Gilt geräteweit. Lokale Modelle sehen den Graphen immer; externe erhalten höchstens redigierte,
                    freigegebene Ausschnitte.
                  </p>
                </div>
              </div>

              <!-- Darstellung -->
              <div v-else class="lz-section">
                <div class="lz-section__head">
                  <h3>Darstellung</h3>
                  <p>
                    Wie der 3D-Wissensraum Knoten, Beziehungen und das Träumen zeigt. Ändert nichts am Gespeicherten.
                  </p>
                </div>
                <div class="lz-card">
                  <div class="lz-label">Beschriftungen</div>
                  <div class="lz-segment" role="radiogroup" aria-label="Beschriftungen">
                    <button
                      v-for="option in [
                        { id: 'hubs', label: 'Systeme', hint: 'nur Knotenpunkte' },
                        { id: 'selected', label: 'Auswahl', hint: 'nur gewählter Knoten' },
                        { id: 'all', label: 'Alle', hint: 'jeder Knoten' },
                      ] as const"
                      :key="option.id"
                      type="button"
                      class="lz-segment__item"
                      :class="{ 'is-active': display.labels === option.id }"
                      role="radio"
                      :aria-checked="display.labels === option.id"
                      @click="setDisplay('labels', option.id)"
                    >
                      <span>{{ option.label }}</span
                      ><small>{{ option.hint }}</small>
                    </button>
                  </div>
                </div>
                <div class="lz-card">
                  <div class="lz-label">Beziehungen</div>
                  <div class="lz-segment" role="radiogroup" aria-label="Beziehungen">
                    <button
                      v-for="option in [
                        { id: 'all', label: 'Alle', hint: 'Zuordnung + gespeichert' },
                        { id: 'stored', label: 'Gespeichert', hint: 'ohne Zuordnungslinien' },
                        { id: 'none', label: 'Keine', hint: 'nur bei Auswahl' },
                      ] as const"
                      :key="option.id"
                      type="button"
                      class="lz-segment__item"
                      :class="{ 'is-active': display.edges === option.id }"
                      role="radio"
                      :aria-checked="display.edges === option.id"
                      @click="setDisplay('edges', option.id)"
                    >
                      <span>{{ option.label }}</span
                      ><small>{{ option.hint }}</small>
                    </button>
                  </div>
                </div>
                <div class="lz-card">
                  <div class="lz-row">
                    <div>
                      <div class="lz-card__title">Wissensraum als Hintergrund</div>
                      <p class="lz-hint">
                        Der langsam drehende Wissensraum liegt leicht verschwommen hinter der ganzen App; auf der
                        Gedächtnisseite wird er scharf und bedienbar.
                      </p>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': display.ambientBackdrop }"
                      role="switch"
                      :aria-checked="display.ambientBackdrop"
                      aria-label="Wissensraum als Hintergrund"
                      @click="setDisplay('ambientBackdrop', !display.ambientBackdrop)"
                    >
                      <span />
                    </button>
                  </div>
                  <div class="lz-row">
                    <div>
                      <div class="lz-card__title">Tiefenwirkung</div>
                      <p class="lz-hint">Entfernte Knoten werden blasser.</p>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': display.depthFade }"
                      role="switch"
                      :aria-checked="display.depthFade"
                      aria-label="Tiefenwirkung"
                      @click="setDisplay('depthFade', !display.depthFade)"
                    >
                      <span />
                    </button>
                  </div>
                  <div class="lz-row">
                    <div>
                      <div class="lz-card__title">Träumen animieren</div>
                      <p class="lz-hint">Lesering, Traum-Orb, neue und ersetzte Knoten sichtbar animieren.</p>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': display.dreamAnimation }"
                      role="switch"
                      :aria-checked="display.dreamAnimation"
                      aria-label="Träumen animieren"
                      @click="setDisplay('dreamAnimation', !display.dreamAnimation)"
                    >
                      <span />
                    </button>
                  </div>
                  <div class="lz-row">
                    <div>
                      <div class="lz-card__title">Langsam drehen</div>
                      <p class="lz-hint">Die Karte rotiert von selbst, solange du nicht ziehst.</p>
                    </div>
                    <button
                      type="button"
                      class="lz-switch"
                      :class="{ 'is-on': display.autoRotate }"
                      role="switch"
                      :aria-checked="display.autoRotate"
                      aria-label="Langsam drehen"
                      @click="setDisplay('autoRotate', !display.autoRotate)"
                    >
                      <span />
                    </button>
                  </div>
                </div>
                <div class="lz-card">
                  <label class="lz-label" for="project-settings-scale"
                    >Knotengröße <span class="lz-range__val">{{ Math.round(display.nodeScale * 100) }} %</span></label
                  >
                  <input
                    id="project-settings-scale"
                    class="lz-range"
                    type="range"
                    min="0.6"
                    max="1.6"
                    step="0.1"
                    :value="display.nodeScale"
                    @input="setDisplay('nodeScale', Number(($event.target as HTMLInputElement).value))"
                  />
                </div>
                <div class="lz-actions">
                  <button type="button" class="lz-btn lz-btn--ghost" @click="emit('open-memory')">
                    Wissensraum öffnen
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style src="./settings/settings.css"></style>
<style scoped>
.project-settings__modal {
  max-width: 820px;
}
.project-settings__badge {
  flex: none;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-soft);
  font: 600 10.5px var(--font-mono);
  letter-spacing: 0.04em;
  color: var(--text-muted);
  background: var(--surface-3, transparent);
}
.project-settings__badge[data-state='ready'] {
  color: var(--success, #34d399);
  border-color: color-mix(in srgb, var(--success, #34d399) 50%, transparent);
}
.project-settings__badge[data-state='missing'],
.project-settings__badge[data-state='inaccessible'],
.project-settings__badge[data-state='error'],
.project-settings__badge[data-state='stale'] {
  color: var(--danger-soft, #fb7185);
  border-color: color-mix(in srgb, var(--danger-soft, #fb7185) 50%, transparent);
}
.project-settings__facts {
  display: grid;
  gap: 6px;
  margin: 0;
}
.project-settings__facts > div {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 10px;
  font-size: 12.5px;
}
.project-settings__facts dt {
  color: var(--text-muted);
}
.project-settings__facts dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-primary);
}
.project-settings__facts code {
  font: 11.5px var(--font-mono);
  color: var(--text-secondary);
}
.project-settings__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.project-settings__stats > div {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--r-md, 10px);
  background: var(--bg-sunken);
  border: 1px solid var(--border-hair);
}
.project-settings__stats b {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.project-settings__stats span {
  font-size: 10.5px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.project-settings__rules {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.project-settings__danger {
  color: var(--danger-soft, #fb7185);
}
.lz-range__val {
  float: right;
  font: 11px var(--font-mono);
  color: var(--text-muted);
}
@media (max-width: 640px) {
  .project-settings__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .project-settings__facts > div {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
