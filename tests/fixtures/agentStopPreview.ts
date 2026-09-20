// Synthetic interaction acceptance: never stops native processes or changes user data.
import { createApp, h, ref } from 'vue'
import ExecutionSettingsSection from '@/components/settings/ExecutionSettingsSection.vue'
import { createAgentStopController } from '@/services/agentStop'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

document.documentElement.setAttribute('data-theme', 'dark')
const stopped = ref(false)
const calls = ref(0)
const fail = ref(false)
const control = createAgentStopController({
  begin: () => {
    stopped.value = true
  },
  drain: async () => {},
  stopNative: async () => {
    calls.value++
    await new Promise(resolve => setTimeout(resolve, 150))
    return { complete: !fail.value, processCount: 2, pendingCount: fail.value ? 1 : 0, errors: [] }
  },
  recover: async () => {},
  resume: () => {
    stopped.value = false
  },
})
createApp({
  setup() {
    return () =>
      h('main', { style: 'max-width:800px;margin:32px auto;padding:24px;color:var(--text-primary)' }, [
        h('h1', { style: 'font-size:20px' }, 'Synthetische Einstellungsprüfung'),
        h('p', `Simulierte Bereinigungen: ${calls.value}`),
        h('label', [
          h('input', {
            type: 'checkbox',
            checked: fail.value,
            onChange: () => {
              fail.value = !fail.value
            },
          }),
          ' Fehler simulieren',
        ]),
        h(ExecutionSettingsSection, {
          autoExecuteMutatingTools: false,
          killSwitch: stopped.value,
          agentStopState: control.state.value,
          stopAgents: control.stop,
          resumeAgents: control.resume,
        }),
      ])
  },
}).mount('#app')
