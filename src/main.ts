import { createPinia } from 'pinia'
import { createApp } from 'vue'
import './assets/main.css'
import './styles/theme.css'
import './styles/beautiful-ui.css'

// The secondary display must not initialize another model, microphone or store.
async function mount() {
  const hash = window.location.hash
  if (hash !== '#mini-chat' && !hash.startsWith('#system-status')) {
    const { initializeModelUsageSettings } = await import('./services/inference/modelUsageSettings')
    await initializeModelUsageSettings()
  }
  const root =
    hash === '#mini-chat'
      ? (await import('./components/mini/MiniChatWindow.vue')).default
      : hash.startsWith('#system-status')
        ? (await import('./components/SystemStatusWindow.vue')).default
        : (await import('./App.vue')).default
  const app = createApp(root)
  app.use(createPinia())
  app.mount('#app')
}
void mount().catch(() => {
  const host = document.getElementById('app')
  if (!host) return
  host.replaceChildren()
  const message = document.createElement('p')
  message.textContent = 'Luczor konnte die gerätegebundenen Einstellungen nicht laden. Bitte erneut versuchen.'
  const retry = document.createElement('button')
  retry.textContent = 'Erneut laden'
  retry.onclick = () => window.location.reload()
  host.append(message, retry)
})
