<script lang="ts">
import type { HardwareSnapshot } from '@/services/inference/capacity'
import type { LocalResourceConfig, LocalResourceConfigState } from '@/services/inference/resources'

export type LocalResourceSettingsClient = {
  read: () => Promise<LocalResourceConfigState>
  save: (config: LocalResourceConfig, revision: number) => Promise<LocalResourceConfigState>
  hardware: () => Promise<HardwareSnapshot>
  subscribe: (listener: (state: LocalResourceConfigState) => void) => Promise<() => void>
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import {
  getLocalResourceConfig,
  setLocalResourceConfig,
  getLocalResourceHardware,
  subscribeLocalResourceConfig,
  DEFAULT_LOCAL_RESOURCE_CONFIG,
} from '@/services/inference/resources'

const props = defineProps<{ client?: LocalResourceSettingsClient }>()
const client = props.client ?? {
  read: getLocalResourceConfig,
  save: setLocalResourceConfig,
  hardware: getLocalResourceHardware,
  subscribe: subscribeLocalResourceConfig,
}
const defaults = (): LocalResourceConfig => ({ ...DEFAULT_LOCAL_RESOURCE_CONFIG })
const modes = [
  { id: 'auto', title: 'Automatisch – alle Ressourcen', detail: 'GPU, CPU und RAM passend zum Gerät einsetzen.' },
  {
    id: 'gpu',
    title: 'GPU – Automatik als Ersatz',
    detail: 'Auf der Grafikkarte rechnen; bei Bedarf automatisch verteilen.',
  },
  { id: 'cpu', title: 'Nur CPU/RAM', detail: 'Ohne GPU-Offload rechnen. Benötigt mehr RAM.' },
] as const
const modeLabel = (mode: LocalResourceConfig['mode']) => modes.find(item => item.id === mode)?.title ?? 'Unbekannt'
const saveErrors = new Map([
  [
    'resource_config_revision_conflict',
    'Die Einstellungen wurden inzwischen geändert. Bitte den aktuellen Stand neu laden.',
  ],
  ['resource_threads_invalid', 'Die Threadanzahl passt nicht zu den verfügbaren Prozessorkernen.'],
  ['resource_ram_reserve_invalid', 'Der RAM-Puffer passt nicht zur verfügbaren Speichermenge.'],
  ['resource_vram_reserve_invalid', 'Der VRAM-Puffer passt nicht zu den ausgewählten Grafikkarten.'],
  [
    'resource_gpu_selection_changed',
    'Die gespeicherte Grafikkarte hat sich geändert. Bitte die Hardware neu laden und auswählen.',
  ],
  [
    'resource_gpu_selection_ambiguous',
    'Die Grafikkartenauswahl ist nicht eindeutig. Bitte Automatik verwenden oder die Auswahl erneuern.',
  ],
  [
    'resource_gpu_selection_unavailable',
    'Eine ausgewählte Grafikkarte ist nicht verfügbar. Bitte die Hardware neu laden.',
  ],
  [
    'resource_thread_controls_unavailable',
    'Diese Runtime unterstützt keine manuelle Threadsteuerung. Bitte die Threadfelder leeren.',
  ],
])
const config = ref<LocalResourceConfigState | null>(null)
const draft = ref<LocalResourceConfig>(defaults())
const hardware = ref<HardwareSnapshot | null>(null)
const loading = ref(true)
const modeGroupId = useId()
const saving = ref(false)
const error = ref('')
const notice = ref('')
const hardwareUnavailable = ref(false)
const revisionConflict = ref(false)
let stopped = false
let unsubscribe: (() => void) | undefined
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const dirty = computed(() => !!config.value && JSON.stringify(draft.value) !== JSON.stringify(config.value.requested))
const cores = computed(() => hardware.value?.cpu.availableLogicalCores ?? hardware.value?.cpu.logicalCores ?? 1024)
const gib = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 2 })
const chosenGpus = computed(
  () =>
    hardware.value?.accelerators.filter(
      gpu => draft.value.gpuDeviceIds === null || draft.value.gpuDeviceIds.includes(gpu.id)
    ) ?? []
)
const maxRamReserve = computed(() =>
  hardware.value ? Math.max(0, hardware.value.memory.totalBytes - 1024 ** 3) : null
)
const maxVramReserve = computed(() => {
  const totals = chosenGpus.value
    .map(gpu => gpu.totalBytes)
    .filter((value): value is number => typeof value === 'number')
  return totals.length
    ? Math.max(0, (draft.value.gpuDeviceIds === null ? Math.max(...totals) : Math.min(...totals)) - 256 * 1024 ** 2)
    : null
})
const validation = computed(() => {
  if (revisionConflict.value)
    return 'Die Geräteeinstellungen wurden zwischenzeitlich geändert. Bitte den aktuellen Stand neu laden, bevor du speicherst.'
  for (const threads of [draft.value.threads, draft.value.threadsBatch]) {
    if (threads !== null && (!Number.isInteger(threads) || threads < 1 || threads > cores.value))
      return `Bitte zwischen 1 und ${cores.value} Threads wählen oder das Feld für Automatik leeren.`
  }
  for (const [value, minimum, maximum, label] of [
    [draft.value.ramReserveBytes, 1024 ** 3, maxRamReserve.value, 'RAM'],
    [draft.value.vramReserveBytes, 256 * 1024 ** 2, maxVramReserve.value, 'VRAM'],
  ] as const) {
    if (label === 'VRAM' && draft.value.mode === 'cpu') continue
    if (value !== null && (!Number.isSafeInteger(value) || value < minimum || (maximum !== null && value > maximum)))
      return `${label}-Puffer: mindestens ${gib(minimum)} GiB${maximum !== null ? `, höchstens ${gib(maximum)} GiB` : ''}. Leer bedeutet Automatik.`
  }
  if (draft.value.mode !== 'cpu' && draft.value.gpuDeviceIds?.length === 0)
    return 'Bitte mindestens eine Grafikkarte auswählen oder die automatische Auswahl verwenden.'
  if (
    draft.value.mode !== 'cpu' &&
    draft.value.gpuDeviceIds?.some(id => !hardware.value?.accelerators.some(gpu => gpu.id === id))
  )
    return 'Eine ausgewählte Grafikkarte ist nicht mehr verfügbar. Bitte die Auswahl aktualisieren.'
  return ''
})

function receive(next: LocalResourceConfigState, replaceDraft = false): void {
  if (
    stopped ||
    (config.value &&
      (next.revision < config.value.revision ||
        (next.revision === config.value.revision && next.appliedRevision < config.value.appliedRevision)))
  )
    return
  if (!replaceDraft && dirty.value && config.value && next.revision > config.value.revision)
    revisionConflict.value = true
  const replace = replaceDraft || !dirty.value
  config.value = copy(next)
  if (replace) {
    draft.value = copy(next.requested)
    revisionConflict.value = false
  }
}
async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  const [stateResult, hardwareResult] = await Promise.allSettled([client.read(), client.hardware()])
  if (stopped) return
  if (stateResult.status === 'fulfilled') receive(stateResult.value, true)
  else error.value = 'Die Geräteeinstellungen konnten nicht gelesen werden. Bitte erneut laden.'
  hardwareUnavailable.value = hardwareResult.status !== 'fulfilled'
  if (hardwareResult.status === 'fulfilled') hardware.value = hardwareResult.value
  loading.value = false
}
async function save(): Promise<void> {
  if (!config.value || validation.value || saving.value || loading.value) return
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const next = await client.save(copy(draft.value), config.value.revision)
    receive(next, true)
    if (!stopped)
      notice.value = next.pending
        ? 'Gespeichert. Die Änderung wartet auf das Ende der laufenden Aufträge.'
        : 'Die Ressourceneinstellungen wurden für dieses Gerät gespeichert.'
  } catch (failure) {
    const code = typeof failure === 'string' ? failure : failure instanceof Error ? failure.message : ''
    if (!stopped)
      error.value =
        saveErrors.get(code) ??
        'Die Einstellung wurde nicht bestätigt. Bitte den aktuellen Stand neu laden und erneut speichern.'
  } finally {
    if (!stopped) saving.value = false
  }
}
function reset(): void {
  draft.value = defaults()
  notice.value = 'Automatik ausgewählt. Zum Übernehmen speichern.'
}
function setNumber(
  key: 'threads' | 'threadsBatch' | 'ramReserveBytes' | 'vramReserveBytes',
  event: Event,
  factor = 1
): void {
  const value = (event.target as HTMLInputElement).value
  const next = value === '' ? null : Number(value) * factor
  switch (key) {
    case 'threads':
      draft.value.threads = next
      break
    case 'threadsBatch':
      draft.value.threadsBatch = next
      break
    case 'ramReserveBytes':
      draft.value.ramReserveBytes = next
      break
    case 'vramReserveBytes':
      draft.value.vramReserveBytes = next
      break
  }
}
function toggleGpu(id: string, checked: boolean): void {
  const selected = new Set(draft.value.gpuDeviceIds ?? [])
  if (checked) selected.add(id)
  else selected.delete(id)
  draft.value.gpuDeviceIds = [...selected]
}
onMounted(async () => {
  await refresh()
  if (stopped) return
  try {
    const stop = await client.subscribe(next => receive(next))
    if (stopped) stop()
    else unsubscribe = stop
  } catch {
    if (!stopped) notice.value = 'Live-Aktualisierung nicht verfügbar. Der aktuelle Stand kann neu geladen werden.'
  }
})
onBeforeUnmount(() => {
  stopped = true
  unsubscribe?.()
})
</script>

<template>
  <section class="resource-settings" aria-label="Lokales Modell: Ressourcen">
    <header>
      <h4>Lokales Modell · dieses Gerät</h4>
      <p>Leistung automatisch abstimmen oder die verfügbaren Ressourcen selbst aufteilen.</p>
    </header>
    <p v-if="loading" role="status">Geräteeinstellungen werden gelesen …</p>
    <div v-if="config" class="resource-settings__state" aria-live="polite">
      <span
        >Gewählt <strong>{{ modeLabel(config.requested.mode) }}</strong></span
      >
      <span
        >Angewandt <strong>{{ config.applied ? modeLabel(config.applied.mode) : 'Noch nicht angewandt' }}</strong></span
      >
      <p v-if="config.pending">
        Änderung vorgemerkt. Laufende Chats und Agenten arbeiten mit den bisherigen Einstellungen weiter.
      </p>
    </div>
    <fieldset :disabled="loading || saving || !config">
      <legend>Berechnungsmodus</legend>
      <div class="resource-settings__modes">
        <label v-for="mode in modes" :key="mode.id" :class="{ selected: draft.mode === mode.id }">
          <input v-model="draft.mode" type="radio" :value="mode.id" :name="modeGroupId" />
          <span
            ><strong>{{ mode.title }}</strong
            ><small>{{ mode.detail }}</small></span
          >
        </label>
      </div>
      <details class="resource-settings__expert">
        <summary>Details: Grafikkarten, Threads und Speicherpuffer</summary>
        <p>
          Leere Felder verwenden die Automatik. Speicherpuffer sind Sicherheitsabstände für andere Anwendungen; sie
          sperren keinen RAM.
        </p>
        <div class="resource-settings__gpu" :aria-disabled="draft.mode === 'cpu'">
          <label class="resource-settings__automatic"
            ><input
              type="checkbox"
              :checked="draft.gpuDeviceIds === null"
              :disabled="draft.mode === 'cpu'"
              @change="draft.gpuDeviceIds = ($event.target as HTMLInputElement).checked ? null : []"
            />
            Grafikkarten automatisch auswählen</label
          >
          <p v-if="hardwareUnavailable">
            Grafikkarten und Speichergrößen konnten nicht gelesen werden. Die native Prüfung erfolgt beim Speichern
            erneut.
          </p>
          <p v-else-if="hardware && !hardware.accelerators.length">
            Keine Grafikkarte erkannt. Automatik kann ein freigegebenes CPU-Modell nutzen.
          </p>
          <label v-for="gpu in hardware?.accelerators ?? []" :key="gpu.id" class="resource-settings__device">
            <input
              type="checkbox"
              :disabled="draft.mode === 'cpu' || draft.gpuDeviceIds === null"
              :checked="draft.gpuDeviceIds?.includes(gpu.id) ?? false"
              :aria-label="gpu.name"
              @change="toggleGpu(gpu.id, ($event.target as HTMLInputElement).checked)"
            />
            <span
              ><strong>{{ gpu.name }}</strong
              ><small
                >{{
                  gpu.totalBytes == null ? 'Dedizierter VRAM unbekannt' : `${gib(gpu.totalBytes)} GiB dedizierter VRAM`
                }}
                ·
                {{
                  gpu.availableBytes == null ? 'Freier VRAM unbekannt' : `${gib(gpu.availableBytes)} GiB frei`
                }}</small
              ><small
                v-if="
                  gpu.totalBytes != null &&
                  gpu.availableBytes != null &&
                  gpu.availableBytes >= 0 &&
                  gpu.availableBytes <= gpu.totalBytes
                "
                >Gesamtbelegung: {{ gib(gpu.totalBytes - gpu.availableBytes) }} GiB · alle Prozesse, beim Aktualisieren
                gemessen</small
              ><small v-if="gpu.backend === 'unknown'">Hardware erkannt · Inferenz-Backend noch ungeprüft</small
              ><small v-if="gpu.sharedSystemLimitBytes"
                >Geteilter RAM: höchstens {{ gib(gpu.sharedSystemLimitBytes) }} GiB · kein zusätzlicher VRAM</small
              ></span
            >
          </label>
        </div>
        <div class="resource-settings__numbers">
          <label
            >Antwortthreads<input
              type="number"
              min="1"
              :max="cores"
              step="1"
              placeholder="Automatisch"
              :value="draft.threads ?? ''"
              @input="setNumber('threads', $event)"
          /></label>
          <label
            >Kontextthreads<input
              type="number"
              min="1"
              :max="cores"
              step="1"
              placeholder="Automatisch"
              :value="draft.threadsBatch ?? ''"
              @input="setNumber('threadsBatch', $event)"
          /></label>
          <label
            >RAM-Puffer (GiB)<input
              type="number"
              min="1"
              :max="maxRamReserve === null ? undefined : maxRamReserve / 1024 ** 3"
              step="0.25"
              placeholder="Automatisch"
              :value="draft.ramReserveBytes === null ? '' : draft.ramReserveBytes / 1024 ** 3"
              @input="setNumber('ramReserveBytes', $event, 1024 ** 3)"
          /></label>
          <label
            >VRAM-Puffer (GiB)<input
              type="number"
              min="0.25"
              :max="maxVramReserve === null ? undefined : maxVramReserve / 1024 ** 3"
              step="0.25"
              placeholder="Automatisch"
              :disabled="draft.mode === 'cpu'"
              :value="draft.vramReserveBytes === null ? '' : draft.vramReserveBytes / 1024 ** 3"
              @input="setNumber('vramReserveBytes', $event, 1024 ** 3)"
          /></label>
        </div>
        <p v-if="hardware">
          {{ hardware.cpu.logicalCores }} logische CPU-Kerne · {{ gib(hardware.memory.totalBytes) }} GiB RAM ·
          {{ gib(hardware.memory.availableBytes) }} GiB aktuell frei.
        </p>
      </details>
      <p v-if="validation" class="resource-settings__error" role="alert">{{ validation }}</p>
      <div class="resource-settings__actions">
        <button type="button" :disabled="!dirty || !!validation" @click="save">
          {{ saving ? 'Speichert …' : 'Ressourcen speichern' }}</button
        ><button type="button" class="secondary" @click="reset">Auf Automatik zurücksetzen</button>
      </div>
    </fieldset>
    <p v-if="error" class="resource-settings__error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <button type="button" class="resource-settings__reload" :disabled="loading || saving" @click="refresh">
      Aktuellen Stand neu laden
    </button>
    <p class="resource-settings__footnote">
      Gilt nur auf diesem Gerät. Modellfreigaben und RAM-Schutz bleiben aktiv. Eine neue Verteilung kann das Modell nach
      dem aktuellen Auftrag einmal neu laden.
    </p>
  </section>
</template>

<style scoped>
.resource-settings {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--border-soft, #353340);
  border-radius: 10px;
  color: var(--text-primary, #eeedf3);
  font-size: 13px;
  line-height: 1.5;
}
.resource-settings h4 {
  margin: 0;
  font-size: 15px;
}
.resource-settings p {
  margin: 5px 0 0;
  color: var(--text-muted, #aba8b8);
}
.resource-settings fieldset {
  min-width: 0;
  border: 0;
  padding: 0;
  margin: 0;
}
.resource-settings legend {
  margin-bottom: 9px;
  font-weight: 600;
}
.resource-settings__state {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 22px;
  padding: 10px 12px;
  background: var(--bg-soft, #22222b);
  border-radius: 6px;
}
.resource-settings__state span {
  display: grid;
  gap: 2px;
  font-size: 12px;
  color: var(--text-muted, #aba8b8);
}
.resource-settings__state strong {
  color: var(--text-primary, #eeedf3);
}
.resource-settings__state p {
  flex-basis: 100%;
}
.resource-settings__modes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr));
  gap: 8px;
}
.resource-settings__modes label {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border-soft, #353340);
  border-radius: 7px;
  cursor: pointer;
}
.resource-settings__modes label.selected {
  border-color: var(--accent, #a899ed);
  background: var(--bg-soft, #22222b);
}
.resource-settings small {
  display: block;
  margin-top: 3px;
  color: var(--text-muted, #aba8b8);
  font-size: 12px;
}
.resource-settings input[type='radio'],
.resource-settings input[type='checkbox'] {
  flex-shrink: 0;
  margin: 4px 0 0;
  accent-color: var(--accent, #a899ed);
}
.resource-settings__expert {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft, #353340);
}
.resource-settings summary {
  cursor: pointer;
  font-weight: 600;
}
.resource-settings__gpu {
  margin: 14px 0;
}
.resource-settings__automatic,
.resource-settings__device {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}
.resource-settings__device {
  padding: 10px 0;
  border-bottom: 1px solid var(--border-soft, #353340);
}
.resource-settings__device span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.resource-settings__numbers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 185px), 1fr));
  gap: 12px;
}
.resource-settings__numbers label {
  display: grid;
  gap: 5px;
}
.resource-settings input[type='number'] {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--border-soft, #353340);
  border-radius: 5px;
  background: var(--bg-soft, #22222b);
  padding: 9px;
  color: inherit;
  font: inherit;
}
.resource-settings__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.resource-settings button {
  border: 1px solid var(--accent, #a899ed);
  border-radius: 6px;
  padding: 9px 12px;
  background: var(--accent, #a899ed);
  color: var(--on-accent, #17131e);
  font: inherit;
  cursor: pointer;
}
.resource-settings button.secondary,
.resource-settings button.resource-settings__reload {
  background: transparent;
  border-color: var(--border-soft, #353340);
  color: inherit;
}
.resource-settings button.resource-settings__reload {
  justify-self: start;
}
.resource-settings :disabled {
  opacity: 0.55;
  cursor: default;
}
.resource-settings :focus-visible {
  outline: 2px solid var(--accent, #a899ed);
  outline-offset: 3px;
}
.resource-settings p.resource-settings__error {
  color: var(--danger, #ee9292);
}
.resource-settings__footnote {
  font-size: 12px;
}
.resource-settings__actions button {
  max-width: 100%;
}
</style>
