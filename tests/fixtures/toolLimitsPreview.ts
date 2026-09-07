// Real presentation components, isolated from account data and native inference.
import { createApp, h, ref } from 'vue'
import PromptBar from '@/components/ai/PromptBar.vue'
import ExecutionSettingsSection from '@/components/settings/ExecutionSettingsSection.vue'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const text = ref('Bitte das Projekt analysieren')
const mode = ref(false)
const chat = ref(6)
const agent = ref(12)
const status = ref('Bereit')
createApp({
  setup: () => () =>
    h('main', { style: 'max-width: 720px; margin: 24px auto; padding: 16px;' }, [
      h('h1', 'Agentenmodus und Tool-Limits'),
      h('p', 'Oberflächentest mit Beispieldaten – keine Modell- oder Tool-Ausführung.'),
      h(PromptBar, {
        modelValue: text.value,
        agentMode: mode.value,
        contextLabel: 'Luczor-Testprojekt',
        'onUpdate:modelValue': (value: string) => (text.value = value),
        'onUpdate:agentMode': (value: boolean) => (mode.value = value),
        onSend: () => (status.value = mode.value ? 'Agententeam sofort starten' : 'Normaler Chat'),
      }),
      h('p', { role: 'status' }, `${status.value} · Chat: ${chat.value} Runden · Arbeitsagent: ${agent.value} Runden`),
      h(ExecutionSettingsSection, {
        autoExecuteMutatingTools: false,
        chatToolRounds: chat.value,
        agentToolRounds: agent.value,
        'onUpdate:chatToolRounds': (value: number) => (chat.value = value),
        'onUpdate:agentToolRounds': (value: number) => (agent.value = value),
      }),
    ]),
}).mount('#app')
