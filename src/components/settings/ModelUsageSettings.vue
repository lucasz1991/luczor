<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { localInferenceCoordinator, reinitializeLocalInferenceForCurrentApi } from '@/services/inference/coordinator'
import {
  modelUsageSettings,
  saveModelUsageSettings,
  DEFAULT_MODEL_USAGE,
  isClaudeRouteMode,
  type ChatRouteMode,
  type ModelUsageSettings as ModelUsageConfig,
} from '@/services/inference/modelUsageSettings'
import { claudeMainPolicy } from '@/services/inference/claudeMain'
import LocalResourceSettings from '@/components/LocalResourceSettings.vue'
import ThinkingSettings from './ThinkingSettings.vue'

const props = defineProps<{ managed?: boolean }>()
const emit = defineEmits<{ openClaudeApi: [] }>()
const draft = defineModel<ModelUsageConfig>({ default: () => ({ ...modelUsageSettings.value }) })
const status = ref(localInferenceCoordinator.status())
const message = ref('')
const busy = ref(false)
watch(modelUsageSettings, value => {
  if (!props.managed) draft.value = { ...value }
})

type ModeRow = { value: ChatRouteMode; title: string; description: string; lead: string }
const MODE_GROUPS: ReadonlyArray<{ id: string; label: string; rows: readonly ModeRow[] }> = [
  {
    id: 'local',
    label: 'Lokales Modell führt',
    rows: [
      {
        value: 'local',
        title: 'Lokal',
        description: 'Nur das lokale Modell; Inhalte bleiben auf dem Gerät.',
        lead: 'lokal',
      },
      {
        value: 'auto',
        title: 'Lokal + extern',
        description: 'Lokal zuerst, externe Unterstützung bei Bedarf.',
        lead: 'lokal + extern',
      },
    ],
  },
  {
    id: 'claude',
    label: 'Claude führt',
    rows: [
      {
        value: 'claude_local',
        title: 'Claude + lokal',
        description:
          'Claude führt den Chat. Das lokale Modell übernimmt als Spezial-Agent, wenn Claude eine Anfrage nicht bearbeitet.',
        lead: 'Claude API',
      },
      {
        value: 'claude',
        title: 'Nur Claude',
        description: 'Claude führt ohne lokales Modell – auch für Geräte, auf denen kein lokales Modell läuft.',
        lead: 'Claude API',
      },
    ],
  },
  {
    id: 'external',
    label: 'Externe Modelle führen',
    rows: [
      {
        value: 'external',
        title: 'Nur extern',
        description: 'Vom Server gewählte externe Modelle bearbeiten die Anfrage.',
        lead: 'extern',
      },
    ],
  },
]
// Older stored drafts may lack the `claude` block; treat that as "no access".
const claudeConnected = computed(() => draft.value.claude?.enabled === true)
const claudeUsable = computed(() => claudeMainPolicy.value.allowed && claudeConnected.value)
const claudeStatus = computed(() => {
  if (claudeUsable.value) return 'Claude-Zugang verbunden'
  return claudeConnected.value
    ? 'Claude-Zugang verbunden · Modi vom Server nicht freigeschaltet'
    : 'Kein Claude-Zugang eingerichtet'
})
function lockReason(mode: ChatRouteMode): string {
  if (mode === 'local') return ''
  if (!isClaudeRouteMode(mode))
    return draft.value.externalEnabled ? '' : 'Zuerst unten „Externe Modelle zulassen“ einschalten.'
  if (!claudeMainPolicy.value.allowed) return 'Der Server hat die Claude-Modi nicht freigeschaltet.'
  return claudeConnected.value ? '' : 'Zuerst im Bereich „Claude API“ einen Zugang einrichten.'
}
/** A mode whose access is missing is shown as "Lokal", exactly as it is stored and used. */
const selectedMode = computed<ChatRouteMode>(() =>
  lockReason(draft.value.chatRouteMode) ? 'local' : draft.value.chatRouteMode
)
function selectMode(mode: ChatRouteMode) {
  if (!lockReason(mode)) draft.value = { ...draft.value, chatRouteMode: mode }
}
/** Resets the choices of this device; the server-verified Claude access is not a choice and stays. */
function resetDraft() {
  draft.value = { ...DEFAULT_MODEL_USAGE, claude: { ...(draft.value.claude ?? DEFAULT_MODEL_USAGE.claude) } }
}
async function save() {
  busy.value = true
  try {
    await saveModelUsageSettings(draft.value)
    message.value = 'Gespeichert. Modellwahl und erlaubte Unterstützung gelten für neue Aufträge.'
  } catch {
    message.value = 'Die Einstellungen konnten nicht gespeichert werden.'
  } finally {
    busy.value = false
  }
}
async function refreshCatalog() {
  busy.value = true
  try {
    const result = await reinitializeLocalInferenceForCurrentApi({ diagnoseUnavailable: true })
    status.value = localInferenceCoordinator.status()
    message.value = result.ok
      ? 'Katalogabruf abgeschlossen. Die aktuelle Modellfreigabe wird angezeigt.'
      : result.message
  } catch {
    message.value = 'Der Modellkatalog konnte nicht aktualisiert werden. Bitte die Serververbindung prüfen.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="lz-section" aria-label="Chat- und Agentenmodelle">
    <div class="lz-section__head">
      <h3>Chat &amp; Agenten</h3>
      <p>Modelle und erlaubte Unterstützung für dieses Gerät.</p>
    </div>
    <div class="lz-card">
      <div class="model-usage-cardhead">
        <div id="model-usage-mode-title" class="lz-card__title">Hauptmodus</div>
        <div class="lz-card__meta">Standard für neue Chats</div>
      </div>
      <div class="model-usage-modes" role="radiogroup" aria-labelledby="model-usage-mode-title">
        <div
          v-for="group in MODE_GROUPS"
          :key="group.id"
          class="model-usage-modegroup"
          role="group"
          :aria-labelledby="`model-usage-group-${group.id}`"
        >
          <div :id="`model-usage-group-${group.id}`" class="model-usage-modegroup__label">{{ group.label }}</div>
          <label
            v-for="row in group.rows"
            :key="row.value"
            class="model-usage-mode"
            :class="{ 'is-on': selectedMode === row.value, 'is-disabled': !!lockReason(row.value) }"
          >
            <input
              type="radio"
              name="model-usage-route"
              class="model-usage-mode__input"
              :value="row.value"
              :checked="selectedMode === row.value"
              :disabled="!!lockReason(row.value)"
              :aria-describedby="`model-usage-mode-${row.value}`"
              @change="selectMode(row.value)"
            />
            <span class="model-usage-mode__radio" aria-hidden="true" />
            <span class="model-usage-mode__text">
              <b>{{ row.title }}</b>
              <span :id="`model-usage-mode-${row.value}`">
                {{ row.description }}
                <em v-if="lockReason(row.value)">{{ lockReason(row.value) }}</em>
              </span>
            </span>
            <span class="model-usage-mode__lead" aria-hidden="true">{{ row.lead }}</span>
          </label>
        </div>
      </div>
      <p class="lz-hint">
        Modell und Denktiefe wählst du direkt im Eingabefeld des Chats. Dort lässt sich auch der Modus je Chat
        umstellen.
      </p>
      <div class="model-usage-status">
        <span class="lz-permission__badge" :class="{ 'is-ok': claudeUsable }" role="status">
          <i aria-hidden="true" />{{ claudeStatus }}
        </span>
        <button type="button" class="model-usage-link" @click="emit('openClaudeApi')">
          {{ claudeConnected ? 'Zugang verwalten' : 'Im Bereich „Claude API“ einrichten' }}
        </button>
      </div>
    </div>
    <div class="lz-card">
      <div class="model-usage-cardhead">
        <div class="lz-card__title">Lokales Modell und externe Freigabe</div>
      </div>
      <label class="lz-label" for="model-usage-local">Lokales Modell</label>
      <select id="model-usage-local" v-model="draft.localModelId" class="lz-input">
        <option :value="null">Automatisch nach Hardware und signiertem Katalog</option>
        <option
          v-for="model in status.manifest?.models ?? []"
          :key="model.id"
          :value="model.id"
          :disabled="!model.enabled"
        >
          {{ model.displayName }}{{ !model.enabled ? ' · noch nicht freigegeben' : '' }}
        </option>
        <option
          v-if="draft.localModelId && !status.manifest?.models.some(model => model.id === draft.localModelId)"
          :value="draft.localModelId"
          disabled
        >
          {{ draft.localModelId }} · im aktuellen Katalog nicht verfügbar
        </option>
      </select>
      <p class="lz-hint">
        Eine feste Auswahl verwendet ausschließlich dieses lokale Modell. Installation und Bereitschaft werden vor dem
        Auftrag geprüft.
      </p>
      <button type="button" class="lz-btn" :disabled="busy" @click="refreshCatalog">
        Modellkatalog vom Server aktualisieren
      </button>
      <p v-if="!status.manifest" role="status" class="lz-hint">
        Noch kein verifizierter Modellkatalog verfügbar. Bitte die Serververbindung prüfen.
      </p>
      <label class="model-usage-toggle"
        ><input v-model="draft.externalEnabled" type="checkbox" /> Externe Modelle zulassen</label
      >
      <p class="lz-hint">
        Erlaubt die automatische Nutzung externer Modelle in passenden Chats. Provider und Rollenmodelle werden im Admin
        verwaltet. Ausschalten sperrt neue externe Modellrunden.
      </p>
      <label class="model-usage-toggle">
        <input v-model="draft.externalToolsEnabled" type="checkbox" :disabled="!draft.externalEnabled" />
        Externe Agenten dürfen freigegebenen Kontext gezielt durchsuchen
      </label>
      <p class="lz-hint">
        Ermöglicht gezielte Lesezugriffe innerhalb des freigegebenen Kontexts. Projektgrenzen und gesperrte Inhalte
        bleiben verbindlich.
      </p>
      <p v-if="!draft.externalEnabled" class="lz-hint">Externe Modelle sind gesperrt. Luczor arbeitet lokal.</p>
      <div class="model-usage-actions">
        <button v-if="!managed" type="button" class="lz-btn" :disabled="busy" @click="save">
          Modellnutzung speichern
        </button>
        <button type="button" class="lz-btn" @click="resetDraft">Zurücksetzen</button>
      </div>
      <p v-if="managed" class="lz-hint">Änderungen mit „Speichern“ unten im Einstellungsfenster übernehmen.</p>
      <p role="status" class="lz-hint">{{ message }}</p>
    </div>
    <LocalResourceSettings />
    <ThinkingSettings />
  </section>
</template>

<style scoped>
.model-usage-cardhead,
.model-usage-status {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.model-usage-status {
  align-items: center;
  flex-wrap: wrap;
  padding-top: 4px;
}
.model-usage-modes,
.model-usage-modegroup {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.model-usage-modegroup__label {
  margin: 6px 2px 0;
  font: 500 9.5px var(--font-mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.model-usage-mode {
  position: relative;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 13px;
  background: rgba(5, 6, 10, 0.35);
  cursor: pointer;
  transition:
    border-color var(--dur, 200ms) var(--ease, ease),
    background var(--dur, 200ms) var(--ease, ease);
}
.model-usage-mode:hover:not(.is-disabled) {
  border-color: var(--border-soft);
}
.model-usage-mode.is-on {
  border-color: var(--border-strong);
  background: linear-gradient(90deg, var(--cy-12), rgba(255, 255, 255, 0.025));
}
.model-usage-mode.is-disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
/* The native radio stays focusable and operable; only its drawing is replaced. */
.model-usage-mode__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}
.model-usage-mode__radio {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border: 1.5px solid var(--text-faint);
  border-radius: 50%;
}
.model-usage-mode.is-on .model-usage-mode__radio {
  border-color: var(--cy-soft);
}
.model-usage-mode.is-on .model-usage-mode__radio::after {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cy-soft);
}
.model-usage-mode:has(.model-usage-mode__input:focus-visible) {
  box-shadow: var(--focus-ring);
}
.model-usage-mode__text b {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.model-usage-mode__text span {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-muted);
}
.model-usage-mode__text em {
  display: block;
  font-style: normal;
  color: var(--warn-soft);
}
.model-usage-mode__lead {
  font: 9.5px var(--font-mono);
  letter-spacing: 0.06em;
  white-space: nowrap;
  color: var(--text-faint);
}
.model-usage-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--cy-soft);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.model-usage-link:focus-visible {
  outline: none;
  border-radius: 4px;
  box-shadow: var(--focus-ring);
}
@media (max-width: 480px) {
  .model-usage-mode {
    grid-template-columns: 18px minmax(0, 1fr);
  }
  .model-usage-mode__lead {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .model-usage-mode {
    transition: none;
  }
}
.model-usage-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 20px 0 8px;
}
.model-usage-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}
</style>
