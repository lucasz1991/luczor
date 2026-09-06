import { createApp } from 'vue'
import AgentTeamLab from './AgentTeamLab.vue'

if (!import.meta.env.DEV) throw new Error('Das Simulationslabor ist nur im lokalen Entwicklungsserver verfügbar.')
createApp(AgentTeamLab).mount('#team-lab')
