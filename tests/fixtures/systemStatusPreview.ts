// Explicit synthetic UI review. No device, model, account or network operation is performed.
import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import SystemStatusPanel from '@/components/SystemStatusPanel.vue'
import { hud, type HudStatus } from '@/state/hud'
import { appearance } from '@/services/appearance'
import { trackMemoryActivity } from '@/services/memory/activity'
import { fetchWithActivity } from '@/services/networkActivity'
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
      disk: {
        mount: 'E:\\',
        kind: 'ssd',
        total_bytes: 2_000_000_000_000,
        used_bytes: 860_000_000_000,
        busy_percent: cpu / 2,
        read_percent: cpu / 3,
        write_percent: cpu / 6,
      },
      cpu_percent: cpu,
      ram_percent: 48,
      ram_used_mb: 15729,
      ram_total_mb: 32768,
      gpu_percent: unavailableGpu.value ? null : cpu + 16,
      cpu_temp_c: null,
      gpu_temp_c: null,
      gpu_source: 'windows_engine',
      network_local: {
        sent_bytes: reads.value * 768,
        received_bytes: reads.value * 1536,
        requests: reads.value,
        active_requests: modelRunning.value ? 1 : 0,
        failed_requests: 0,
      },
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
window.fetch = async input => {
  if (String(input) === 'https://traffic.example.test/synthetic')
    return new Response('Synthetische Nutzdaten '.repeat(256), { status: 200 })
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
          button('Datenaktivität', () => {
            void trackMemoryActivity('read', async () => undefined)
            void trackMemoryActivity('write', async () => undefined)
            void fetchWithActivity('https://traffic.example.test/synthetic', {
              method: 'POST',
              body: 'Synthetisch',
            }).then(response => response.text())
          }),
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
          button('Modellanalyse', () => {
            const sample = localModelDiagnostics.begin('Lokales Modell · Beispieldaten', [
              { role: 'system', content: 'x'.repeat(1200) },
              { role: 'user', content: 'x'.repeat(3500) },
              { role: 'assistant', content: 'x'.repeat(900) },
              { role: 'tool', content: 'x'.repeat(1800) },
            ])
            sample.delta('Die Projektstruktur ist geprüft. ')
            sample.finish(
              {
                content: 'Die Projektstruktur ist geprüft. Die Änderungen können jetzt im Chat besprochen werden.',
                usage: { inputTokens: 7400, outputTokens: 312, totalTokens: 7712 },
                contextUsage: {
                  inputTokens: 7400,
                  contextTokens: 32768,
                  outputTokens: 2048,
                  omittedMessages: 2,
                  shortenedToolResults: 1,
                },
                rawToolCalls: [],
                finishReason: 'stop',
              },
              {
                cachedTokens: 4096,
                reasoningTokens: 64,
                promptMs: 480,
                predictedMs: 5200,
                promptTokensPerSecond: 15416,
                outputTokensPerSecond: 60,
              }
            )
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
