// Real Vue components, synthetic transport and public token events. No model or device effects.
import { createApp, h, ref } from 'vue'
import WorkflowEditorIsland from '@/components/workflows/WorkflowEditorIsland.vue'
import ThinkingBudgetControl from '@/components/ai/ThinkingBudgetControl.vue'
import ThinkingSelector from '@/components/ai/ThinkingSelector.vue'
import type { ThinkingBudgetProgress, ThinkingTier } from '@/services/inference/thinking'
import type { WorkflowEditorState } from '@/services/workflows/webSession'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

const workflow = {
  id: 1,
  name: 'Formular prüfen und Ergebnis auswerten',
  version: 2,
  status: 'active',
  is_locked: false,
  definition: {
    schema_version: 2 as const,
    thinking_tier: 'balanced' as const,
    steps: [
      {
        key: 'formular',
        type: 'browser.open',
        version: 1,
        payload: { title: 'Testformular öffnen', url: 'https://example.test/form' },
      },
      {
        key: 'auswerten',
        type: 'node.run',
        version: 1,
        depends_on: ['formular'],
        payload: {
          title: 'Ergebnis auswerten',
          code: 'process.stdout.write(JSON.stringify({ok:true}))',
          input: {},
          output_schema: { type: 'object' },
        },
      },
    ],
  },
  revisions: [],
}
const catalog = [
  {
    key: 'browser.open',
    label: 'Browser öffnen',
    kind: 'task',
    runner: 'client',
    mutating: true,
    requires_approval: true,
    allowed_in_definition: true,
    params: { url: { type: 'string', required: true } },
  },
  {
    key: 'node.run',
    label: 'Node-Skript',
    kind: 'task',
    runner: 'client',
    mutating: true,
    requires_approval: true,
    allowed_in_definition: true,
    params: { code: { type: 'string', required: true } },
    input_schema: { type: 'object', properties: { input: { type: 'object' }, output_schema: { type: 'object' } } },
  },
]
const state = {
  workflow,
  catalog,
  tests: [],
  repairs: [],
  runs: [],
  triggers: [],
  testCases: [
    {
      id: 1,
      name: 'Formular-Erfolg',
      input: {},
      fixtures: {},
      assertions: [{ path: 'steps.auswerten.data.ok', operator: 'equals', value: true }],
    },
  ],
  capabilities: { deviceBound: false, canRunRealTests: false, canConfigureRepairPolicy: false },
  urls: {
    save: '/dashboard/workflows/1/editor',
    testCases: '/dashboard/workflows/1/test-cases',
    tests: '/dashboard/workflows/1/tests',
    repairs: '/dashboard/workflows/1/repairs',
    operation: '/dashboard/workflows/1/operations',
  },
} as unknown as WorkflowEditorState
const calls = ref<string[]>([])
const operations = new Map<string, unknown>()
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname
  if (!path.startsWith('/dashboard/workflows/1/')) throw new Error('Fixture does not allow external requests')
  const data = init?.body ? JSON.parse(String(init.body)) : {}
  if (!init?.method || init.method === 'GET') {
    if (path.includes('/operations/')) {
      const found = operations.get(path.split('/').pop()!)
      return Response.json(found === undefined ? { status: 'not_found' } : { status: 'completed', response: found })
    }
    return Response.json(state)
  }
  calls.value.push(`${init.method} ${path}`)
  if (path === state.urls.save) {
    if (data.expected_version !== state.workflow.version)
      return Response.json({ message: 'Versionskonflikt' }, { status: 409 })
    state.workflow.name = data.name
    state.workflow.definition = JSON.parse(data.definition_json)
    state.workflow.version++
    state.workflow.revisions = [
      {
        id: state.workflow.version,
        version: state.workflow.version,
        definition: structuredClone(state.workflow.definition),
        change_summary: 'Synthetischer UI-Speichertest',
      },
      ...(state.workflow.revisions ?? []),
    ]
  } else if (path === state.urls.tests) {
    state.tests.push({ id: state.tests.length + 1, mode: data.mode, status: 'passed' })
  } else throw new Error('Fixture mutation not implemented')
  const response = { data: structuredClone(state.workflow) }
  operations.set(data.operation_id, response)
  return Response.json(response)
}
const width = ref(1080)
const tier = ref<ThinkingTier>('ultra')
const message = ref('')
const progress = ref<ThinkingBudgetProgress>({
  requestId: 'fixture-request',
  tier: 'ultra',
  phase: 'thinking',
  generatedTokens: 7200,
  softTargetTokens: 8192,
  thinkingLimitTokens: 14500,
  requestedThinkingLimitTokens: 65536,
  outputLimitTokens: 30884,
  responseReserveTokens: 16384,
  warning: true,
  canExtend: false,
  canAnswer: true,
  answerRequested: false,
  elapsedMs: 72300,
  sequence: 1,
})
createApp({
  render: () =>
    h(
      'main',
      { style: 'padding:20px;max-width:100%;font:14px system-ui;color:#e7e9f0;background:#15171d;min-height:100vh' },
      [
        h('h1', { style: 'font-size:24px;margin-bottom:12px' }, 'Workflow- und Denkbudgetprüfung'),
        h(
          'p',
          { style: 'margin-bottom:20px' },
          'Synthetische UI-Prüfung mit echten Vue-Komponenten. Keine Modellaufrufe, Gerätejobs oder echte Testnachweise.'
        ),
        h('nav', { style: 'display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px' }, [
          h(
            'button',
            {
              onClick: () => {
                width.value = 320
              },
            },
            '320 px'
          ),
          h(
            'button',
            {
              onClick: () => {
                width.value = 1080
              },
            },
            'Breit'
          ),
          h(
            'button',
            {
              onClick: () => {
                progress.value = { ...progress.value, phase: 'answering', generatedTokens: 8100, canAnswer: false }
              },
            },
            'Öffentliche Antwort simulieren'
          ),
        ]),
        h(
          'div',
          { 'data-review-surface': true, style: `width:${width.value}px;max-width:100%;display:grid;gap:18px` },
          [
            h(ThinkingSelector, {
              modelValue: tier.value,
              'onUpdate:modelValue': (value: ThinkingTier) => {
                tier.value = value
              },
            }),
            h(ThinkingBudgetControl, {
              progress: progress.value,
              control: async () => {
                progress.value = { ...progress.value, answerRequested: true, sequence: progress.value.sequence + 1 }
                return progress.value
              },
              onStop: () => {
                message.value = 'Stopp angefordert (Fixture)'
              },
            }),
            h('p', { role: 'status' }, message.value),
            h(WorkflowEditorIsland, { stateUrl: '/dashboard/workflows/1/editor-state' }),
            h('output', { 'aria-label': 'Synthetische Schreiboperationen' }, calls.value.join(' · ')),
          ]
        ),
      ]
    ),
}).mount('#app')
