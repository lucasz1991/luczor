// Synthetic UI acceptance only; never starts an optimizer or accesses user memory.
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import IdleOptimizationSettings from '@/components/IdleOptimizationSettings.vue'
import { idleOptimizationEnabled, idleOptimizationStatus } from '@/services/agents/idleOptimization'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/components/settings/settings.css'
mockIPC(command => (command === 'plugin:store|load' ? 1 : undefined))
idleOptimizationEnabled.value = true
const width = ref(780)
function state(phase: 'waiting' | 'running' | 'yielding' | 'paused', reason: string | null = null) {
  idleOptimizationStatus.value = {
    enabled: true,
    phase,
    reason,
    foregroundJobs: 0,
    completed: 2,
    lastCompletedAt: Date.now(),
    nextCheckAt: null,
  }
}
state('waiting')
createApp({
  render: () =>
    h('main', { style: 'padding:24px;font:15px system-ui;max-width:100%;' }, [
      h('h1', { style: 'font-size:24px;margin-bottom:8px' }, 'Leerlaufoptimierung'),
      h('p', { style: 'margin-bottom:20px' }, 'Synthetische UI-Prüfung · keine Modellaufrufe oder Nutzerdaten.'),
      h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px' }, [
        h('button', { onClick: () => state('running') }, 'Laufend'),
        h('button', { onClick: () => state('yielding') }, 'Nutzerauftrag'),
        h('button', { onClick: () => state('paused', 'memory_pressure') }, 'Speicherdruck'),
        h(
          'button',
          {
            onClick: () => {
              width.value = width.value === 320 ? 780 : 320
            },
          },
          'Breite umschalten'
        ),
      ]),
      h('section', { class: 'lz-settings', style: { width: `${width.value}px`, maxWidth: '100%' } }, [
        h(IdleOptimizationSettings),
      ]),
    ]),
}).mount('#app')
