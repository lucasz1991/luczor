// Explicit synthetic UI review. No device, model, account or network operation is performed.
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import SystemStatusPanel from '@/components/SystemStatusPanel.vue'
import { hud, type HudStatus } from '@/state/hud'
import { appearance } from '@/services/appearance'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const open = ref(true)
const waiting = ref(false)
const fail = ref(false)
const unavailableGpu = ref(false)
const modelRunning = ref(true)
const reads = ref(0)
const miniRequests = ref(0)
const samples = [23, 24, 22, 30, 38, 27, 20, 21, 35, 42, 29, 26]
mockIPC(command => {
  if (command === 'system_metrics') {
    reads.value++
    if (fail.value) throw new Error('Synthetic unavailable telemetry')
    const cpu = samples.at((reads.value - 1) % samples.length) ?? 23
    return {
      cpu_percent: cpu,
      ram_percent: 48,
      ram_used_mb: 15729,
      ram_total_mb: 32768,
      gpu_percent: unavailableGpu.value ? null : cpu + 16,
      cpu_temp_c: null,
      gpu_temp_c: null,
      gpu_source: 'windows_engine',
      app_cpu_percent: 2.3,
      app_ram_percent: 4.8,
      app_ram_used_mb: 1573,
      app_gpu_percent: unavailableGpu.value ? null : 3.1,
      model_cpu_percent: modelRunning.value ? cpu - 10 : null,
      model_ram_percent: modelRunning.value ? 22 : null,
      model_ram_used_mb: modelRunning.value ? 7208 : null,
      model_gpu_percent: !unavailableGpu.value && modelRunning.value ? cpu + 11 : null,
      model_running: modelRunning.value,
    }
  }
  if (command === 'plugin:store|load') return 1
  if (command === 'plugin:store|get') return [null, false]
  throw new Error('Native operations are disabled in this synthetic preview')
})
window.fetch = async () => {
  throw new Error('Network is disabled in this synthetic preview')
}
hud.sync.server = 'online'
hud.sync.cognee = 'configured'
hud.sync.pending = 3
hud.lastTool = 'fs_read_text'
const button = (label: string, click: () => void) => h('button', { class: 'ai-button', onClick: click }, label)
const phase = (status: HudStatus) => {
  waiting.value = false
  hud.status = status
  hud.micLevel = status === 'listening' ? 0.38 : 0
}
createApp({
  render: () =>
    h(
      'main',
      {
        style: 'min-height:100dvh;background:var(--ai-page);color:var(--ai-ink);font:12px var(--ai-font);padding:20px',
      },
      [
        h('p', 'Synthetische Vorschau · keine echten Gerätewerte'),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;max-width:480px' }, [
          button(open.value ? 'Panel schließen' : 'Systemstatus öffnen', () => {
            open.value = !open.value
          }),
          button('Bereit', () => phase('idle')),
          button('Arbeitet', () => phase('executing')),
          button('Hört zu', () => phase('listening')),
          button('Fehler', () => phase('error')),
          button('Freigabe wartet', () => {
            waiting.value = true
          }),
          button(fail.value ? 'Messung wiederherstellen' : 'Messfehler', () => {
            fail.value = !fail.value
          }),
          button(unavailableGpu.value ? 'GPU verfügbar' : 'GPU fehlt', () => {
            unavailableGpu.value = !unavailableGpu.value
          }),
          button('Verbindung offline', () => {
            hud.sync.server = 'offline'
          }),
          button('Modell umschalten', () => {
            modelRunning.value = !modelRunning.value
          }),
          button('Bewegung reduzieren', () => {
            appearance.reduceMotion = !appearance.reduceMotion
          }),
        ]),
        h('p', { 'data-testid': 'fixture-counters' }, `Abfragen: ${reads.value} · Mini-Aufrufe: ${miniRequests.value}`),
        h(SystemStatusPanel, {
          active: open.value,
          assistantPhase: waiting.value ? 'waiting' : undefined,
          projectName: 'Luczor Workspace',
          onClose: () => {
            open.value = false
          },
          onOpenMini: () => {
            miniRequests.value++
          },
        }),
      ]
    ),
}).mount('#app')
