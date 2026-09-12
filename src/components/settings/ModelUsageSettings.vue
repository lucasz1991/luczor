<script setup lang="ts">
import { ref, watch } from 'vue'
import { localInferenceCoordinator, reinitializeLocalInferenceForCurrentApi } from '@/services/inference/coordinator'
import {
  modelUsageSettings,
  saveModelUsageSettings,
  DEFAULT_MODEL_USAGE,
  type ModelUsageSettings as ModelUsageConfig,
} from '@/services/inference/modelUsageSettings'
import LocalResourceSettings from '@/components/LocalResourceSettings.vue'
import ThinkingSettings from './ThinkingSettings.vue'

const props = defineProps<{ managed?: boolean }>()
const draft = defineModel<ModelUsageConfig>({ default: () => ({ ...modelUsageSettings.value }) })
const status = ref(localInferenceCoordinator.status())
const message = ref('')
const busy = ref(false)
watch(modelUsageSettings, value => {
  if (!props.managed) draft.value = { ...value }
})
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
      <label class="lz-label" for="model-usage-route">Standardmodus neuer Chats</label>
      <select id="model-usage-route" v-model="draft.chatRouteMode" class="lz-input">
        <option value="local">Lokal · signiertes lokales Modell</option>
        <option value="auto" :disabled="!draft.externalEnabled">Lokal + extern · Unterstützung nach Bedarf</option>
        <option value="external" :disabled="!draft.externalEnabled">Nur extern · kein lokales Modell</option>
      </select>
      <p class="lz-hint">
        Gilt als Vorauswahl im Eingabefeld; dort ist der Modus pro Chat umstellbar. Das Chatmodell entscheidet anhand
        der Anfrage, ob es direkt antwortet oder Unterstützung hinzuzieht. „Lokal“ bleibt auf diesem Gerät, „Lokal +
        extern“ erlaubt zusätzlich externe Modelle, „Nur extern“ verwendet kein lokales Modell.
      </p>
      <p v-if="!draft.externalEnabled" class="lz-hint">Externe Modelle sind gesperrt. Luczor arbeitet lokal.</p>
      <div class="model-usage-actions">
        <button v-if="!managed" type="button" class="lz-btn" :disabled="busy" @click="save">
          Modellnutzung speichern
        </button>
        <button type="button" class="lz-btn" @click="draft = { ...DEFAULT_MODEL_USAGE }">Zurücksetzen</button>
      </div>
      <p v-if="managed" class="lz-hint">Änderungen mit „Speichern“ unten im Einstellungsfenster übernehmen.</p>
      <p role="status" class="lz-hint">{{ message }}</p>
    </div>
    <LocalResourceSettings />
    <ThinkingSettings />
  </section>
</template>

<style scoped>
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
