<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { resourceRecovery, closeResourceRecovery } from '@/services/inference/resourceRecovery'
import { localInferenceCoordinator } from '@/services/inference/coordinator'
import { modelUsageSettings, saveModelUsageSettings } from '@/services/inference/modelUsageSettings'
import {
  checkLocalResourceHardware,
  getLocalResourceConfig,
  setLocalResourceConfig,
  type LocalResourceConfig,
} from '@/services/inference/resources'

const dialog = ref<HTMLDialogElement>()
const busy = ref(false)
const notice = ref('')
const error = ref('')
const modelId = ref('')
const models = ref<Array<{ id: string; label: string }>>([])
const mode = ref<LocalResourceConfig['mode']>('auto')
let previousFocus: HTMLElement | null = null

watch(
  resourceRecovery,
  async request => {
    if (!request) {
      dialog.value?.close()
      previousFocus?.focus()
      return
    }
    if (dialog.value?.open) return
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    notice.value = ''
    error.value = ''
    modelId.value = modelUsageSettings.value.localModelId ?? ''
    models.value = (localInferenceCoordinator.status().manifest?.models ?? [])
      .filter(model => model.enabled)
      .map(model => ({ id: model.id, label: model.displayName }))
    await nextTick()
    if (resourceRecovery.value !== request) return
    dialog.value?.showModal()
    await run(async () => {
      mode.value = (await getLocalResourceConfig()).requested.mode
    })
  },
  { flush: 'post', immediate: true }
)

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch {
    error.value =
      'Die Aktion konnte nicht abgeschlossen werden. Laufende Aufträge erst beenden oder abbrechen; anschließend erneut versuchen. Details unter Systemstatus prüfen.'
  } finally {
    busy.value = false
  }
}
async function measure(cleanup: boolean) {
  await run(async () => {
    const result = await checkLocalResourceHardware(cleanup)
    if (result.reasonCode) throw new Error(result.reasonCode)
    const ram = result.hardware ? (result.hardware.memory.availableBytes / 1024 ** 3).toFixed(1) : null
    notice.value = `${result.runtimeUnloaded ? 'Luczors lokale Runtime wurde entladen.' : 'Keine Runtime entladen.'}${ram ? ` Aktuell ${ram} GiB RAM verfügbar.` : ''} Andere Programme und gespeicherte Dateien bleiben unverändert.`
  })
}
async function changeModel() {
  await run(async () => {
    if (
      modelId.value &&
      !localInferenceCoordinator.status().manifest?.models.some(model => model.enabled && model.id === modelId.value)
    )
      throw new Error('catalog_changed')
    await saveModelUsageSettings({ ...modelUsageSettings.value, localModelId: modelId.value || null })
    notice.value =
      'Modellwahl gespeichert. Ein erforderlicher Wechsel erfolgt nach laufenden Aufträgen; die Bereitschaft zeigt die Modellwechsel-Anzeige.'
  })
}
async function changeMode() {
  await run(async () => {
    const current = await getLocalResourceConfig()
    const saved = await setLocalResourceConfig({ ...current.requested, mode: mode.value }, current.revision)
    notice.value = saved.pending
      ? 'Gespeichert. Der Moduswechsel wartet auf das Ende laufender Aufträge.'
      : 'Berechnungsmodus gespeichert. Beim nächsten Modellstart wird die Hardware-Eignung erneut geprüft.'
  })
}
function close() {
  if (!busy.value) closeResourceRecovery()
}
</script>

<template>
  <dialog
    ref="dialog"
    class="resource-recovery"
    aria-labelledby="resource-recovery-title"
    aria-describedby="resource-recovery-description"
    :aria-busy="busy"
    @cancel.prevent="close"
  >
    <header>
      <h2 id="resource-recovery-title">Lokale Modellressourcen</h2>
      <button type="button" :disabled="busy" aria-label="Dialog schließen" @click="close">×</button>
    </header>
    <p id="resource-recovery-description">{{ resourceRecovery?.message }}</p>
    <p>Du entscheidest, was geändert wird. Eine Chat-Anfrage wird dabei nicht automatisch wiederholt.</p>
    <fieldset :disabled="busy">
      <legend>Arbeitsspeicher und Grafikspeicher</legend>
      <p>
        RAM und VRAM des geladenen Modells werden gemeinsam durch Entladen freigegeben – nur wenn keine Aufträge laufen.
        Keine fremden Prozesse beenden, keine Windows-Caches leeren, keine Modelldateien löschen.
      </p>
      <button type="button" @click="measure(false)">Nur Ressourcen prüfen</button>
      <button type="button" @click="measure(true)">Luczor-Modell entladen · RAM + VRAM freigeben</button>
    </fieldset>
    <fieldset :disabled="busy">
      <legend>Anderes Modell</legend>
      <label for="recovery-model">Signierter Modellkatalog</label>
      <select id="recovery-model" v-model="modelId">
        <option value="">Automatische Modellwahl</option>
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }}</option>
      </select>
      <button type="button" :disabled="models.length === 0" @click="changeModel">Modellwahl speichern</button>
      <p v-if="!models.length">Kein verifizierter Katalog verfügbar. Bitte zuerst den Server synchronisieren.</p>
    </fieldset>
    <fieldset :disabled="busy">
      <legend>Berechnungsmodus</legend>
      <label for="recovery-mode">Runtime-Nutzung</label>
      <select id="recovery-mode" v-model="mode">
        <option value="auto">Automatisch alle Ressourcen</option>
        <option value="gpu">GPU-Automatik</option>
        <option value="cpu">Nur CPU und RAM</option>
        <option value="hybrid">Erzwungener Split · CPU + GPU</option>
      </select>
      <p>
        Alle Modi verwenden das signierte Runtime-Paket. GPU und Split benötigen zusätzlich einen unterstützten
        Grafiktreiber und ausreichend freien VRAM. Bestehende CPU-, RAM- und GPU-Limits bleiben erhalten.
      </p>
      <button type="button" @click="changeMode">Berechnungsmodus speichern</button>
    </fieldset>
    <p v-if="busy" role="status">Aktion wird ausgeführt …</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <footer><button type="button" :disabled="busy" @click="close">Schließen</button></footer>
  </dialog>
</template>

<style scoped>
.resource-recovery {
  width: min(40rem, calc(100vw - 2rem));
  max-height: calc(100vh - 3rem);
  overflow: auto;
  margin: auto;
  padding: 1.5rem;
  border: 1px solid var(--border, #64748b);
  border-radius: 1rem;
  background: var(--panel, #1d2026);
  color: var(--text, #e9edf3);
  line-height: 1.5;
}
.resource-recovery::backdrop {
  background: #0009;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
h2 {
  font-size: 1.2rem;
  margin: 0;
}
fieldset {
  border: 0;
  border-top: 1px solid var(--border, #64748b);
  margin-top: 1.25rem;
  padding: 0.75rem 0 0;
}
legend {
  font-weight: 600;
  padding-right: 0.5rem;
}
p {
  margin: 0.75rem 0;
}
label {
  display: block;
}
select {
  width: 100%;
  color: inherit;
  background: var(--panel, #1d2026);
  padding: 0.5rem;
  border: 1px solid var(--border, #64748b);
  border-radius: 0.5rem;
}
button {
  margin: 0.5rem 0.5rem 0 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border, #64748b);
  border-radius: 0.5rem;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--accent, #7dd3fc);
  outline-offset: 3px;
}
footer {
  text-align: right;
}
</style>
