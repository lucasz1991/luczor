<script setup lang="ts">
import { ref, watch } from 'vue'
import { localInferenceCoordinator } from '@/services/inference/coordinator'
import {
  modelUsageSettings,
  saveModelUsageSettings,
  DEFAULT_MODEL_USAGE,
} from '@/services/inference/modelUsageSettings'
import LocalResourceSettings from '@/components/LocalResourceSettings.vue'
import ThinkingSettings from './ThinkingSettings.vue'

const draft = ref({ ...modelUsageSettings.value })
const status = ref(localInferenceCoordinator.status())
const message = ref('')
watch(modelUsageSettings, value => {
  draft.value = { ...value }
})
function save() {
  try {
    saveModelUsageSettings(draft.value)
    message.value =
      'Gespeichert. Modellwahl und Teamstandard gelten für neue Aufträge; externe Freigaben bleiben erforderlich.'
  } catch {
    message.value = 'Die Einstellungen konnten nicht gespeichert werden.'
  }
}
</script>

<template>
  <section class="lz-section" aria-label="Chat- und Agentenmodelle">
    <div class="lz-section__head">
      <h3>Chat &amp; Agenten</h3>
      <p>Modelle und Teamstandard für dieses Gerät.</p>
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
      <button type="button" class="lz-btn" @click="status = localInferenceCoordinator.status()">
        Kataloganzeige aktualisieren
      </button>
      <p v-if="!status.manifest" role="status" class="lz-hint">
        Noch kein verifizierter Modellkatalog verfügbar. Bitte die Serververbindung prüfen.
      </p>
      <label class="model-usage-toggle"
        ><input v-model="draft.externalEnabled" type="checkbox" /> Externe Modelle zulassen</label
      >
      <p class="lz-hint">
        Erlaubt externe Chat-Fallbacks und Spezialisten nach Nachrichtenfreigabe. Provider und Rollenmodelle werden im
        Admin verwaltet. Ausschalten sperrt neue externe Modellrunden.
      </p>
      <label class="model-usage-toggle"
        ><input v-model="draft.agentsByDefault" type="checkbox" /> Neue Chats standardmäßig im Agentenmodus</label
      >
      <label class="lz-label" for="model-usage-team">Agententeam</label>
      <select id="model-usage-team" v-model="draft.teamPreset" class="lz-input">
        <option value="local">Alle Agenten lokal</option>
        <option value="server" :disabled="!draft.externalEnabled">Admin-Standard</option>
        <option value="free" :disabled="!draft.externalEnabled">Lokale Planung + Free-Spezialisten</option>
        <option value="budget" :disabled="!draft.externalEnabled">Günstige externe Planung + Free-Spezialisten</option>
      </select>
      <p v-if="!draft.externalEnabled" class="lz-hint">Externe Modelle sind gesperrt. Teams arbeiten lokal.</p>
      <div class="model-usage-actions">
        <button type="button" class="lz-btn" @click="save">Modellnutzung speichern</button>
        <button type="button" class="lz-btn" @click="draft = { ...DEFAULT_MODEL_USAGE }">Zurücksetzen</button>
      </div>
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
