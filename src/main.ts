import { createPinia } from 'pinia'
import { createApp } from 'vue'
import './assets/main.css'
import './styles/theme.css'
import './styles/beautiful-ui.css'

// The secondary display must not initialize another model, microphone or store.
async function mount() {
  const hash = window.location.hash
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
void mount()
