// Synthetic UI fixture; no model, account, native command or external API is used.
import { createApp, h, ref } from 'vue'
import ChatProjectOverlay from '@/components/ChatProjectOverlay.vue'
import ChatComposer from '@/components/ai/ChatComposer.vue'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/styles/app-shell.css'

const contextExpanded = ref(false)
const checklistExpanded = ref(false)
const projectId = ref('preview-a')
const hasChecklist = ref(true)
const actionCount = ref(0)
const note = ref('Bleibt beim Einklappen erhalten')

const overlay = () =>
  h(
    ChatProjectOverlay,
    {
      projectId: projectId.value,
      goalCount: 12,
      goalsDone: 3,
      hasChecklist: hasChecklist.value,
      checklistCount: 9,
      checklistDone: 4,
      contextExpanded: contextExpanded.value,
      checklistExpanded: checklistExpanded.value,
      'onUpdate:contextExpanded': value => (contextExpanded.value = value),
      'onUpdate:checklistExpanded': value => (checklistExpanded.value = value),
    },
    {
      context: () =>
        h('div', { class: 'info-strip' }, [
          h('div', { class: 'info-block' }, [
            h('h2', 'Projektziele'),
            ...Array.from({ length: 12 }, (_, index) =>
              h('p', { style: 'padding:12px 0' }, `Ziel ${index + 1}: Eine nachvollziehbare Aufgabe bearbeiten.`)
            ),
          ]),
          h('div', { class: 'info-block' }, [
            h('h2', 'Projektkontext'),
            h('label', [
              'Notiz',
              h('input', {
                value: note.value,
                'aria-label': 'Notiz',
                onInput: (event: Event) => (note.value = (event.target as HTMLInputElement).value),
              }),
            ]),
          ]),
        ]),
      checklist: () =>
        h('section', [
          h('h2', 'Checkliste'),
          ...Array.from({ length: 9 }, (_, index) => h('p', `Schritt ${index + 1}`)),
          h('button', { class: 'ai-button', onClick: () => actionCount.value++ }, 'Planaktion testen'),
          h('output', { 'data-testid': 'plan-action-count' }, String(actionCount.value)),
        ]),
    }
  )

createApp({
  render: () =>
    h('main', { style: 'height:100dvh;display:flex;flex-direction:column;color:var(--ai-text);font-family:Segoe UI' }, [
      h('header', { style: 'padding:12px;display:flex;gap:8px;flex-wrap:wrap' }, [
        h('span', 'Synthetische Overlay-Prüfung'),
        h(
          'button',
          { class: 'ai-button', onClick: () => (projectId.value = `${projectId.value}-next`) },
          'Projekt wechseln'
        ),
        h(
          'button',
          { class: 'ai-button', onClick: () => (hasChecklist.value = !hasChecklist.value) },
          'Plan umschalten'
        ),
      ]),
      h(
        ChatComposer,
        { scrollId: 'preview-messages' },
        {
          overlay,
          default: () =>
            Array.from({ length: 20 }, (_, index) =>
              h('article', { class: 'ai-message', 'data-testid': `message-${index}` }, [
                h('h2', `Nachricht ${index + 1}`),
                h(
                  'p',
                  'Diese Nachricht bleibt beim Auf- und Einklappen an ihrer Position. Die Projektbereiche liegen über dem Chat und scrollen intern.'
                ),
              ])
            ),
          composer: () =>
            h('textarea', { 'aria-label': 'Chatnachricht', placeholder: 'Nachricht eingeben …', style: 'width:100%' }),
        }
      ),
    ]),
}).mount('#app')
