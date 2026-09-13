<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { desktopControlError, loadDesktopControl, previewDesktopControl, saveDesktopControl, type DesktopControlConfig, type DesktopControlStatus } from '@/services/desktopControl'

const status = ref<DesktopControlStatus | null>(null)
const draft = ref<DesktopControlConfig | null>(null)
const busy = ref(false)
const error = ref('')
const saved = ref(false)
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(status.value?.config))
async function load() {
  busy.value = true; error.value = ''; saved.value = false
  try { const loaded = await loadDesktopControl(); status.value = loaded; draft.value = structuredClone(loaded.config) }
  catch (cause) { error.value = desktopControlError(cause) }
  finally { busy.value = false }
}
function selectMonitor(event: Event) {
  if (!draft.value || !status.value) return
  const value = (event.target as HTMLSelectElement).value
  const monitor = value === '' ? null : status.value.monitors.find(item => String(item.id) === value)
  draft.value.monitor = monitor ? { id: monitor.id, name: monitor.name } : null
  saved.value = false
}
async function save() {
  if (!draft.value || !status.value) return
  busy.value = true; error.value = ''; saved.value = false
  try {
    const config = await saveDesktopControl(JSON.parse(JSON.stringify(draft.value)) as DesktopControlConfig)
    status.value = { ...status.value, config }
    draft.value = structuredClone(config)
    saved.value = true
  } catch (cause) { error.value = desktopControlError(cause) }
  finally { busy.value = false }
}
async function preview() {
  error.value = ''
  try { await previewDesktopControl() } catch (cause) { error.value = desktopControlError(cause) }
}
onMounted(load)
</script>

<template>
  <section class="screen-control" aria-labelledby="screen-control-title">
    <header><h3 id="screen-control-title">Bildschirmsteuerung</h3><p>Ein Arbeitsbereich für Luczor. Deine anderen Bildschirme bleiben bei dir.</p></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="busy && !draft" role="status">Bildschirme werden erkannt …</p>
    <template v-if="draft && status">
      <fieldset :disabled="busy">
        <legend>01 · Luczors Bildschirm</legend>
        <label for="control-monitor">Bildschirm für Aufnahme und native Eingaben</label>
        <select id="control-monitor" :value="draft.monitor?.id ?? ''" @change="selectMonitor">
          <option value="">Keiner – nur interner Browser</option>
          <option v-for="(monitor, index) in status.monitors" :key="monitor.id" :value="monitor.id">
            {{ index + 1 }} · {{ monitor.name }} · {{ monitor.width }} × {{ monitor.height }}{{ monitor.primary ? ' · Hauptbildschirm' : '' }}
          </option>
        </select>
        <p>Das Zielfenster muss vollständig auf diesem Bildschirm liegen. Während der Bedienung erscheint ein blauer Rand; nach 30 Sekunden ohne Aktion verschwindet er.</p>
        <button type="button" :disabled="dirty || !draft.monitor" @click="preview">Bildschirm markieren</button>
      </fieldset>
      <fieldset :disabled="busy">
        <legend>02 · Maus und Tastatur</legend>
        <label class="choice"><input v-model="draft.inputMode" type="radio" value="isolated" name="desktop-input-mode"><span><strong>Getrennte Eingaben</strong><small>Eigener Luczor-Zeiger. Keine Bewegung deiner Systemmaus und keine globalen Tastenkombinationen.</small></span></label>
        <label class="choice"><input v-model="draft.inputMode" type="radio" value="shared" name="desktop-input-mode"><span><strong>Systemmaus und Tastatur gemeinsam nutzen</strong><small>Für Programme ohne gezielte Eingabeschnittstelle. Deine gleichzeitigen Eingaben können sich überschneiden.</small></span></label>
        <p v-if="status.isolatedBackend === 'win32_window_messages'">Getrennte Fenstereingaben unterstützen klassische Windows-Textfelder und Schaltflächen. Andere Programme können eine eigene Sitzung oder den gemeinsamen Modus benötigen. Eine zweite virtuelle Hardware-Tastatur wird nicht installiert.</p>
        <p v-else>Auf diesem System sind unabhängige Eingaben im internen Browser verfügbar. Native Programme benötigen derzeit den gemeinsamen Modus; unter Wayland ist die Bildschirmmarkierung noch nicht verfügbar.</p>
        <label class="choice"><input v-model="draft.showCursor" type="checkbox"><span>Luczor-Zeiger anzeigen – auf dem Bildschirm und im internen Browser</span></label>
      </fieldset>
      <fieldset :disabled="busy">
        <legend>03 · Browser</legend>
        <label class="choice"><input v-model="draft.preferInternalBrowser" type="checkbox"><span><strong>Internen Luczor-Browser bevorzugen</strong><small>Webseiten direkt bedienen, ohne deine Maus oder deinen Tastaturfokus zu übernehmen.</small></span></label>
        <div class="browser-routes"><p><strong>Interner Browser</strong><br>Eigene Sitzung, DOM, Formulare und Browser-Screenshots.</p><p><strong>Externe Browserfenster</strong><br>Native Fensterwerkzeuge mit Bildschirm- und Eingabeprüfung. Kein automatischer Wechsel zwischen beiden Wegen.</p></div>
      </fieldset>
      <footer><span v-if="saved && !dirty" role="status">Auf diesem Gerät gespeichert.</span><span v-else>Gilt nur auf diesem Gerät.</span><button type="button" :disabled="busy" @click="load">Neu laden</button><button type="button" class="primary" :disabled="busy || !dirty" @click="save">Bildschirmsteuerung speichern</button></footer>
    </template>
    <button v-else-if="!busy" type="button" @click="load">Erneut versuchen</button>
  </section>
</template>

<style scoped>
.screen-control{display:grid;gap:20px;color:var(--text-primary,#e2e5ea)}
header h3{font-size:20px;margin:0 0 7px}p,small{color:var(--text-secondary,#a4adbb);line-height:1.55;font-size:13px}p{margin:8px 0}
fieldset{border:1px solid var(--border-color,#343943);border-radius:10px;padding:18px;display:grid;gap:12px;min-width:0}
legend{padding:0 7px;font-size:13px;font-weight:600}.choice{display:flex;align-items:flex-start;gap:10px}.choice input{margin-top:4px;accent-color:#398cff}.choice span{display:grid;gap:4px}label{font-size:13px}
select,button{font:inherit;font-size:13px;border:1px solid var(--border-color,#3c4553);background:var(--bg-secondary,#242932);color:inherit;border-radius:7px;padding:9px 12px}select{width:100%}button{cursor:pointer;justify-self:start}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #398cff;outline-offset:3px}.primary{background:#195a9f;border-color:#398cff;color:#fff}
.browser-routes{display:grid;grid-template-columns:1fr 1fr;gap:20px;border-top:1px solid #343943;padding-top:10px}footer{display:flex;gap:10px;align-items:center;flex-wrap:wrap}footer span{margin-right:auto;font-size:12px;color:#a4adbb}.error{color:#ffb6b6;background:#492b30;border-radius:8px;padding:12px}
@media(max-width:650px){.browser-routes{grid-template-columns:1fr}footer button{width:100%}}
</style>
