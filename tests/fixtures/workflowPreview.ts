// Synthetic UI fixture: no real workflow, account, device or model effects.
import { createApp, h, ref } from 'vue'
import { mockIPC } from '@tauri-apps/api/mocks'
import WorkflowWorkspace from '@/components/workflows/WorkflowWorkspace.vue'
import { WorkflowController } from '@/services/workflows/controller'
import { executionGate } from '@/services/executionGate'
import type { WorkflowApi } from '@/services/workflows/api'
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowTask,
  WorkflowTrigger,
} from '@/services/workflows/types'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'

mockIPC(command => {
  if (command === 'plugin:store|load') return 1
  if (command === 'plugin:store|get') return [null, false]
  throw new Error('Native operations disabled in synthetic fixture')
})
const open = ref(true),
  mode = ref<'act' | 'observe'>('act'),
  killSwitch = ref(false),
  discussed = ref(''),
  calls = ref<string[]>([])
const definition: WorkflowDefinition = {
  steps: [
    {
      key: 'quelle',
      type: 'file.read',
      payload: { title: 'Änderungen lesen', path: 'bericht.md', file_scope: 'workspace' },
    },
    {
      key: 'pruefung',
      type: 'condition',
      depends_on: ['quelle'],
      payload: { title: 'Inhalt vorhanden?', left: { $ref: 'steps.quelle.content' }, operator: 'exists' },
      routes: { true: { type: 'step', step_key: 'zusammenfassung' }, false: { type: 'end' } },
    },
    {
      key: 'zusammenfassung',
      type: 'llm',
      depends_on: ['pruefung'],
      payload: {
        title: 'Änderungen zusammenfassen',
        prompt: 'Fasse den deklarierten Inhalt sachlich zusammen.',
        inference: 'local',
        input_bindings: { context: 'steps.quelle.content' },
      },
    },
  ],
}
const workflow: Workflow = {
  id: 1,
  name: 'Projektänderungen zusammenfassen',
  project_id: 1,
  project_external_id: 'fixture',
  version: 2,
  status: 'active',
  is_locked: false,
  definition,
  revisions: [
    {
      id: 2,
      version: 2,
      definition,
      change_summary: 'Leere Quelldateien werden vor der Zusammenfassung erkannt.',
      created_at: '2026-09-08T18:00:00Z',
    },
    {
      id: 1,
      version: 1,
      definition: { steps: [definition.steps[0]!, definition.steps[2]!] },
      change_summary: 'Erste belegbare Fassung.',
      created_at: '2026-09-07T09:00:00Z',
    },
  ],
}
const workflows = [workflow]
const runs: WorkflowRun[] = [
  {
    id: 1,
    public_id: 'fixture-failed',
    workflow_definition_id: 1,
    project_external_id: 'fixture',
    workflow_revision_id: 1,
    status: 'failed',
    sandbox: false,
    duration_ms: 1250,
    started_at: '2026-09-08T15:30:00Z',
    steps: [
      {
        id: 1,
        step_key: 'quelle',
        type: 'file.read',
        status: 'failed',
        error: 'Synthetischer Nachweis: Quelldatei fehlt.',
        duration_ms: 34,
      },
    ],
  },
]
const triggers: WorkflowTrigger[] = [
  {
    id: 1,
    public_id: 'fixture-schedule',
    name: 'Werktags am Morgen',
    kind: 'schedule',
    enabled: true,
    config: { cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' },
    next_due_at: '2026-09-09T07:00:00Z',
  },
]
const catalog: WorkflowTask[] = [
  {
    key: 'file.read',
    label: 'Datei lesen',
    kind: 'task',
    runner: 'client',
    mutating: false,
    requires_approval: true,
    allowed_in_definition: true,
    params: { path: { type: 'string', required: true }, file_scope: { type: 'string', default: 'workflow' } },
  },
  {
    key: 'llm',
    label: 'KI-Aufgabe',
    kind: 'task',
    runner: 'client',
    mutating: false,
    requires_approval: true,
    allowed_in_definition: true,
    params: { prompt: { type: 'string', required: true }, inference: { type: 'string', default: 'local' } },
  },
  {
    key: 'condition',
    label: 'Bedingung',
    kind: 'task',
    runner: 'server',
    mutating: false,
    requires_approval: false,
    allowed_in_definition: true,
    params: {
      left: { type: 'mixed', required: true },
      operator: { type: 'string', default: 'exists' },
      right: { type: 'mixed' },
    },
  },
]
let grant: Record<string, unknown> | null = null
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const envelope = <T>(data: T) => Promise.resolve({ data: copy(data) })
const api = {
  catalog: () => envelope(catalog),
  list: () => envelope(workflows),
  sources: () =>
    envelope({
      repositories: [{ id: 1, full_name: 'demo/luczor' }],
      tasks: [],
      workflows: [{ id: 1, name: workflow.name }],
    }),
  get: (id: number) => envelope(workflows.find(item => item.id === id)!),
  revision: (id: number, version: number) =>
    envelope(workflows.find(item => item.id === id)!.revisions!.find(item => item.version === version)!),
  runs: (id: number) => envelope(runs.filter(item => item.workflow_definition_id === id)),
  run: (id: string) => envelope(runs.find(item => item.public_id === id)!),
  triggers: () => envelope(triggers),
  automation: () => envelope({ grant }),
  deliveries: () => envelope([{ id: 1, status: 'blocked', last_error: 'Synthetisch: Gerätefreigabe widerrufen.' }]),
  retryDelivery: () => envelope({ status: 'queued' }),
} as unknown as WorkflowApi
const controller = new WorkflowController({
  connect: async () => ({
    api,
    deviceId: 'synthetic-device',
    rootPath: 'E:/synthetic-workspace',
    baseUrl: 'https://example.invalid',
  }),
  async perform(name, args) {
    calls.value.push(name)
    if (name === 'workflow_validate') return { ok: true, valid: true }
    if (name === 'workflow_create' || name === 'workflow_update') {
      const existing = workflows.find(item => item.id === args.workflow_id)
      if (existing && args.expected_version !== existing.version) throw new Error('Versionskonflikt: neu laden.')
      const next: Workflow = {
        ...copy(workflow),
        id: existing?.id ?? workflows.length + 1,
        name: String(args.name),
        definition: copy(args.definition as WorkflowDefinition),
        version: (existing?.version ?? 0) + 1,
      }
      next.revisions = [
        {
          id: next.version,
          version: next.version,
          definition: copy(next.definition),
          change_summary: String(args.change_summary),
          created_at: new Date().toISOString(),
        },
        ...(existing?.revisions ?? []),
      ]
      if (existing) workflows.splice(workflows.indexOf(existing), 1, next)
      else workflows.push(next)
      return { ok: true, workflow_ref: { id: next.id } }
    }
    if (name === 'workflow_trigger_save') {
      const trigger = {
        ...args,
        id: Number(args.trigger_id ?? triggers.length + 1),
        public_id: 'synthetic-trigger',
      } as WorkflowTrigger
      const index = triggers.findIndex(item => item.id === trigger.id)
      if (index < 0) triggers.push(trigger)
      else triggers.splice(index, 1, trigger)
    }
    if (name === 'workflow_automation_configure')
      grant = {
        status: args.status,
        export_results: args.export_results,
        allowed_output_keys: args.allowed_output_keys,
      }
    let runId: string | undefined
    if (name === 'workflow_run_start') {
      runId = 'synthetic-' + (runs.length + 1)
      runs.unshift({
        id: runs.length + 1,
        public_id: runId,
        workflow_definition_id: Number(args.workflow_id),
        project_external_id: 'fixture',
        status: 'waiting_device',
        sandbox: args.sandbox === true,
        started_at: new Date().toISOString(),
        steps: [{ id: 11, step_key: 'quelle', type: 'file.read', status: 'waiting_device' }],
      })
    }
    if (name === 'workflow_run_cancel') {
      const run = runs.find(item => item.public_id === args.run_id)!
      run.status = 'cancelling'
      runId = run.public_id
    }
    return { ok: true, workflow_ref: { id: Number(args.workflow_id ?? 1), runId } }
  },
})
function controls() {
  executionGate.update({ mode: mode.value, killSwitch: killSwitch.value, scope: 'fixture' })
}
controls()
createApp({
  setup: () => () =>
    h('main', { style: 'padding:24px;font-family:Inter,system-ui;background:#f5f3ef;min-height:100vh;color:#20211e' }, [
      h('h1', 'Workflows · synthetische UI-Abnahme'),
      h('p', 'Diese Vorschau führt keine Geräte-, Modell- oder Serveraktionen aus.'),
      h(
        'button',
        {
          onClick: () => {
            open.value = true
          },
        },
        'Workflows öffnen'
      ),
      h(
        'button',
        {
          onClick: () => {
            mode.value = mode.value === 'act' ? 'observe' : 'act'
            controls()
          },
        },
        'Modus: ' + mode.value
      ),
      h(
        'button',
        {
          onClick: () => {
            killSwitch.value = !killSwitch.value
            controls()
          },
        },
        'Not-Aus: ' + killSwitch.value
      ),
      h('pre', { 'aria-label': 'Synthetischer Chatentwurf' }, discussed.value),
      h('pre', { 'aria-label': 'Synthetisches Aktionsprotokoll' }, calls.value.join('\n')),
      h(WorkflowWorkspace, {
        open: open.value,
        projectId: 'fixture',
        mode: mode.value,
        killSwitch: killSwitch.value,
        controllerProp: controller,
        initialWorkflowId: 1,
        'onUpdate:open': (value: boolean) => {
          open.value = value
        },
        onDiscuss: (text: string) => {
          discussed.value = text
        },
      }),
    ]),
}).mount('#app')
