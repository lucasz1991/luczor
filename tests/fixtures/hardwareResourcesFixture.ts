/* eslint-disable vue/one-component-per-file -- This review fixture mounts the same real components at two widths. */
import { createApp } from 'vue'
import LocalResourceSummary from '../../src/components/LocalResourceSummary.vue'
import LocalResourceSettings, { type LocalResourceSettingsClient } from '../../src/components/LocalResourceSettings.vue'
import { DEFAULT_LOCAL_RESOURCE_CONFIG, type LocalResourceConfigState } from '../../src/services/inference/resources'
import type { HardwareSnapshot } from '../../src/services/inference/capacity'

const checks = [
  { label: 'Automatische Abstimmung', value: 'Ausgewogen · beim Modellstart angewandt', verified: true },
  { label: 'CPU-Aufteilung', value: '10 Antwortthreads · 18 Kontextthreads', verified: true },
  { label: 'RAM beim Modellstart', value: '14 / 32 GiB frei · 2 GiB Pufferziel', verified: true },
  { label: 'Modellspeicher', value: 'NVMe-SSD · festes Laufwerk · 716 GiB frei beim Start', verified: true },
  { label: 'Grafikkarte', value: 'Beispiel: NVIDIA RTX 3090', verified: true },
  { label: 'Modellschichten auf GPU', value: '49 / 65', verified: true },
  { label: 'GPU-Modellpuffer', value: '20 GiB', verified: true },
]
function render(selector: string, data: typeof checks) {
  createApp(LocalResourceSummary, { checks: data }).mount(selector)
}
render('#wide', checks)
render(
  '#compact',
  checks.map(check => ({
    ...check,
    value: check.label === 'Automatische Abstimmung' ? 'Speicherschonend · Startprüfung läuft' : check.value,
    verified: false,
  }))
)

function settingsClient(pending = false): LocalResourceSettingsClient {
  let state: LocalResourceConfigState = {
    requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: pending ? 'gpu' : 'auto' },
    applied: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
    revision: pending ? 2 : 1,
    appliedRevision: 1,
    pending,
    reasonCode: null,
  }
  const listeners = new Set<(value: LocalResourceConfigState) => void>()
  const hardware: HardwareSnapshot = {
    schemaVersion: 1,
    snapshotId: 'fixture-only',
    capturedAtMs: Date.now(),
    platform: 'windows',
    arch: 'x86_64',
    cpu: { logicalCores: 20, physicalCores: 10, loadPercent: null, features: [] },
    memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 14 * 1024 ** 3 },
    storage: [],
    accelerators: [
      {
        id: 'cuda-example',
        name: 'Beispiel: NVIDIA RTX 3090',
        backend: 'cuda',
        totalBytes: 24 * 1024 ** 3,
        availableBytes: 20 * 1024 ** 3,
      },
      {
        id: 'dxgi-example',
        name: 'Beispiel: Intel Grafik',
        backend: 'unknown',
        totalBytes: 128 * 1024 ** 2,
        availableBytes: null,
        sharedSystemLimitBytes: 16 * 1024 ** 3,
      },
    ],
  }
  return {
    read: async () => structuredClone(state),
    hardware: async () => structuredClone(hardware),
    save: async (requested, revision) => {
      if (revision !== state.revision) throw new Error('fixture_revision_changed')
      state = { ...state, requested: structuredClone(requested), revision: revision + 1, pending: true }
      for (const listener of listeners) listener(structuredClone(state))
      return structuredClone(state)
    },
    subscribe: async listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
const wideSettings = createApp(LocalResourceSettings, { client: settingsClient() })
wideSettings.config.idPrefix = 'wide-settings'
wideSettings.mount('#settings-wide')
const compactSettings = createApp(LocalResourceSettings, { client: settingsClient(true) })
compactSettings.config.idPrefix = 'compact-settings'
compactSettings.mount('#settings-compact')
