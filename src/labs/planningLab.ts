import { createApp } from 'vue'
import PlanningLab from './PlanningLab.vue'

if (!import.meta.env.DEV) throw new Error('Das Planungslabor ist nur im lokalen Entwicklungsserver verfügbar.')
createApp(PlanningLab).mount('#planning-lab')
