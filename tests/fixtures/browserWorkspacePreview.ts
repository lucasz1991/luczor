// Synthetic browser workbench preview. No browser session, model, account or device command is executed.
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import ChatComposer from '@/components/ai/ChatComposer.vue'
import PromptBar from '@/components/ai/PromptBar.vue'
import ChatProjectOverlay from '@/components/ChatProjectOverlay.vue'
import AutonomousGoalControl from '@/components/projects/AutonomousGoalControl.vue'
import BrowserPanel from '@/components/browser/BrowserPanel.vue'
import { browserPanel } from '@/services/browserPanel'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/styles/ai-workspace.css'

mockIPC(command => {
  if (command === 'browser_panel_status') return { open: false }
  if (command === 'browser_panel_layout') return undefined
  throw new Error(`Synthetic preview does not execute ${command}`)
})

browserPanel.expanded = true
const input = ref('')
const goal = ref({
  text: '',
  active: false,
  status: 'idle' as const,
  revision: 1,
  iterations: 0,
  phase: 'work' as const,
  updatedAt: Date.now(),
})

createApp({
  render: () =>
    h('main', { class: 'main-col', style: 'height:100dvh;background:var(--ai-page);font-family:var(--ai-font)' }, [
      h('header', { class: 'header', style: 'display:flex;align-items:center;gap:8px' }, [
        h('div', { class: 'header__identity', style: 'margin-right:auto' }, [
          h('span', { class: 'header__eyebrow' }, 'SYNTHETISCHE VORSCHAU'),
          h('strong', { class: 'header__title' }, 'Luczor Browser-Arbeitsfläche'),
        ]),
        h(
          'button',
          {
            class: 'mode-toggle',
            'aria-pressed': browserPanel.expanded,
            onClick: () => (browserPanel.expanded = !browserPanel.expanded),
          },
          browserPanel.expanded ? 'Browser einklappen' : 'Browser öffnen'
        ),
      ]),
      h(
        ChatComposer,
        { scrollId: 'browser-workspace-preview', follow: false },
        {
          overlay: () =>
            h(ChatProjectOverlay, {
              projectId: 'synthetic-preview',
              goalCount: 4,
              goalsDone: 1,
              hasChecklist: false,
              checklistCount: 0,
              checklistDone: 0,
            }),
          workspace: () => (browserPanel.expanded ? h(BrowserPanel, { projectId: 'synthetic-preview' }) : null),
          default: () =>
            h('div', { class: 'ai-welcome' }, [
              h('span', { class: 'ai-eyebrow' }, 'CHAT-ARBEITSFLÄCHE'),
              h('h1', 'Browser und Gespräch bleiben im selben Kontext.'),
              h(
                'p',
                'Die Browserzeile ist unter den Projektzielen eingebettet und lässt sich am unteren Griff skalieren.'
              ),
            ]),
        }
      ),
      h('div', { class: 'ai-main-composer' }, [
        h(
          PromptBar,
          {
            modelValue: input.value,
            contextLabel: 'Browser-Arbeitsfläche',
            routeMode: 'local',
            externalAllowed: true,
            onUpdateModelValue: (value: string) => (input.value = value),
          },
          {
            'heading-start': () =>
              h(AutonomousGoalControl, {
                model: goal.value,
                compact: true,
                onSave: (text: string) => (goal.value = { ...goal.value, text }),
                onToggle: (active: boolean) => (goal.value = { ...goal.value, active }),
              }),
          }
        ),
      ]),
    ]),
}).mount('#app')
