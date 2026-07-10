import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import './styles/theme.css'

if (import.meta.env.DEV) {
  void import('@vue/devtools').then(({ devtools }) => devtools.connect('http://localhost', 8098))
}
const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')
