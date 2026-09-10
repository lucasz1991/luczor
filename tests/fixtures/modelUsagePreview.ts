// Synthetic browser fixture: no model, account or hardware operations.
import { createApp, h } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import ModelUsageSettings from '@/components/settings/ModelUsageSettings.vue'
import { localInferenceCoordinator } from '@/services/inference/coordinator'
import { DEFAULT_LOCAL_RESOURCE_CONFIG } from '@/services/inference/resources'
import type { VerifiedLocalModelManifest } from '@/services/inference/modelManifest'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/components/settings/settings.css'

const config = {
  requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
  applied: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
  revision: 1,
  appliedRevision: 1,
  pending: false,
  reasonCode: null,
}
mockIPC(command => {
  if (command === 'local_model_get_resource_config') return config
  if (command === 'local_model_hardware_snapshot')
    return {
      schemaVersion: 1,
      snapshotId: 'fixture',
      capturedAtMs: Date.now(),
      platform: 'linux',
      arch: 'x64',
      cpu: { logicalCores: 12, physicalCores: 6, availableLogicalCores: 12, features: [], loadPercent: 10 },
      memory: { totalBytes: 16 * 1024 ** 3, availableBytes: 10 * 1024 ** 3 },
      accelerators: [
        {
          id: 'fixture-gpu',
          name: 'RTX Laptop · Beispieldaten',
          backend: 'cuda',
          totalBytes: 6 * 1024 ** 3,
          availableBytes: 5 * 1024 ** 3,
        },
      ],
      storage: [],
    }
  throw new Error(`Fixture does not execute ${command}`)
})
localInferenceCoordinator.status = () => ({
  mode: 'active',
  reason: 'fixture',
  admissions: [],
  manifest: {
    models: [
      { id: 'local-tier-light', displayName: 'Laptop · Qwen3-4B Q4_K_M (Beispiel)', enabled: true },
      { id: 'desktop', displayName: 'Desktopmodell (Beispiel)', enabled: true },
      { id: 'unreleased', displayName: 'Noch nicht freigegeben', enabled: false },
    ],
  } as VerifiedLocalModelManifest,
})
createApp({
  render: () =>
    h('main', { style: 'max-width:900px;margin:24px auto;padding:24px' }, [
      h('p', { style: 'margin-bottom:24px' }, 'Testansicht · synthetische Modell- und Hardwaredaten'),
      h(ModelUsageSettings),
    ]),
}).mount('#app')
