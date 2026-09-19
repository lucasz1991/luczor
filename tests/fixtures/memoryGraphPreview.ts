// Synthetic acceptance harness for the knowledge-space view; no model calls, no user data.
import { createApp, h, ref, computed, watch } from 'vue'
import MemoryGraphView, { type DreamView } from '@/features/memory/MemoryGraphView.vue'
import { buildMemoryGraph, type MemoryInventory } from '@/features/memory/graph'
import { DEFAULT_MEMORY_GRAPH_DISPLAY, type MemoryGraphDisplay } from '@/features/memory/graphDisplay'
import type { DreamRun, DreamStage } from '@/services/memory/dreamTrace'
import type { MemoryLink, MemoryLinkState, ModelPhase } from '@/services/memory/modelActivity'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/styles/liquid-glass.css'

const params = new URLSearchParams(location.search)
const nodeCount = Number(params.get('nodes') ?? 120)
const records = Array.from({ length: Math.max(1, Math.floor(nodeCount * 0.55)) }, (_, index) => ({
  id: `m${index}`,
  content: `Erinnerung ${index}: ${['Nutzer bevorzugt kurze Antworten', 'Projekt nutzt pnpm', 'Deploy nur aus main', 'Tauri 2 mit Vue 3'].at(index % 4)}`,
  type: ['fact', 'preference', 'decision'].at(index % 3) ?? 'fact',
  scope: 'project',
  status: 'active',
  source: 'chat',
  visibility: 'private',
  retention: 'durable',
  confidence: 0.9,
  updatedAt: Date.now() - index * 60_000,
  synced: index % 3 === 0,
  sourceIds: index > 2 && index % 5 === 0 ? [`m${index - 1}`, `m${index - 2}`] : [],
}))
const files = Array.from({ length: Math.max(1, Math.floor(nodeCount * 0.08)) }, (_, index) => ({
  id: `f${index}`,
  path: `src/features/area${index}/Component${index}.vue`,
  language: 'vue',
  truncated: false,
  symbols: Array.from({ length: 3 }, (_, sym) => ({
    kind: 'function',
    name: `handler${sym}`,
    start_line: sym * 10,
    end_line: sym * 10 + 8,
  })),
  relations: [{ kind: 'import', target: './helper' }],
}))
const graph = buildMemoryGraph(
  { records } as unknown as MemoryInventory,
  { total: files.length, offset: 0, files } as never,
  {
    revision: '1',
    persona: { name: 'Luczor', slug: 'luczor', prompt: 'x' },
    skills: Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, name: `Skill ${index}`, description: '' })),
  } as never,
  Array.from({ length: 4 }, (_, index) => ({
    id: `a${index}`,
    content: `Kontextpaket ${index}: verdichtete Projektnotizen`,
    modelId: 'local',
    createdAt: Date.now(),
    sources: [{ kind: 'memory', id: `m${index}` }],
  })) as never,
  { label: 'Qwen3 8B · lokal', detail: 'Lokales Modell' }
)

const selected = ref('system:0')
const transient = ref<'none' | 'on'>('none')
const shownGraph = computed(() => {
  if (transient.value === 'none') return graph
  const nodes = graph.nodes.map(node =>
    node.id === 'memory:m20' || node.id === 'memory:m21' ? { ...node, state: 'born' as const } : node
  )
  const ghost = {
    ...graph.nodes.find(node => node.id === 'memory:m22')!,
    id: 'memory:ghost',
    state: 'removed' as const,
  }
  return {
    nodes: [...nodes, ghost],
    edges: [...graph.edges, { from: 'system:0', to: 'memory:ghost', kind: 'ersetzt', grouping: true }],
  }
})
const theme = ref<'dark' | 'light'>((params.get('theme') as 'light') === 'light' ? 'light' : 'dark')
watch(theme, value => document.documentElement.setAttribute('data-theme', value), { immediate: true })
const ambient = ref(params.get('ambient') === '1')
const phase = ref<ModelPhase>('idle')
const links = ref<MemoryLink[]>([])
const display = ref<MemoryGraphDisplay>({ ...DEFAULT_MEMORY_GRAPH_DISPLAY, autoRotate: params.get('rotate') === '1' })
const run = ref<DreamRun | null>(null)
const dream = computed<DreamView>(() => {
  const current = run.value
  const reading = new Set<string>()
  const removing = new Set<string>()
  const conflicts = new Set<string>()
  const touched = new Set<string>()
  if (current) {
    for (const decision of current.decisions)
      for (const target of decision.targets) {
        const id = `memory:${target.id}`
        touched.add(id)
        if (decision.op === 'read' && !current.endedAt) reading.add(id)
        if (decision.op === 'remove') removing.add(id)
        if (decision.op === 'conflict') conflicts.add(id)
      }
  }
  return { active: !!current && !current.endedAt, run: current, reading, removing, conflicts, touched }
})
function stageTo(stage: DreamStage) {
  const current = run.value
  if (!current) return
  run.value = {
    ...current,
    steps: [...current.steps, { at: Date.now(), stage, title: stage }],
    endedAt: stage === 'done' || stage === 'failed' ? Date.now() : undefined,
    outcome: stage === 'done' ? 'success' : stage === 'failed' ? 'failed' : undefined,
  }
}
function startDream() {
  run.value = {
    id: `run-${Date.now()}`,
    startedAt: Date.now(),
    jobKey: 'memory',
    task: 'memory',
    scope: 'project',
    steps: [{ at: Date.now(), stage: 'scanning', title: 'Quellen sichten' }],
    decisions: [
      {
        at: Date.now(),
        op: 'read',
        targets: [0, 1, 2, 3, 4, 5, 6].map(index => ({ kind: 'memory', id: `m${index}` })),
      },
      { at: Date.now(), op: 'conflict', targets: [{ kind: 'memory', id: 'm8' }] },
      { at: Date.now(), op: 'remove', targets: [{ kind: 'memory', id: 'm9' }] },
    ],
  }
}
function link(state: MemoryLinkState, ids: number[]) {
  const now = Date.now()
  const next = links.value.filter(item => !ids.includes(Number(item.id.slice(1))))
  for (const id of ids) next.push({ id: `m${id}`, state, origin: 'chat', at: now })
  links.value = next
}
const stages: DreamStage[] = ['scanning', 'selecting', 'preparing', 'generating', 'verifying', 'committing', 'done']
const button = (label: string, onClick: () => void) =>
  h('button', { onClick, style: 'padding:4px 10px;font:12px system-ui' }, label)
createApp({
  render: () =>
    h(
      'main',
      { style: 'padding:16px;font:14px system-ui;background:var(--ai-page);color:var(--ai-ink);min-height:100vh' },
      [
        h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px' }, [
          button(`Theme: ${theme.value}`, () => (theme.value = theme.value === 'dark' ? 'light' : 'dark')),
          button(`Ambient: ${ambient.value}`, () => (ambient.value = !ambient.value)),
          button('Traum starten', startDream),
          ...stages.map(stage => button(stage, () => stageTo(stage))),
          button('Traum aus', () => (run.value = null)),
          ...(['idle', 'recalling', 'thinking', 'tools', 'answering'] as ModelPhase[]).map(item =>
            button(item, () => (phase.value = item))
          ),
          button('recalled', () => link('recalled', [10, 11, 12, 13])),
          button('included', () => link('included', [10, 11])),
          button('omitted', () => link('omitted', [12, 13])),
          button('written', () => link('written', [14, 15])),
          button('updated', () => link('updated', [16])),
          button('removed', () => link('removed', [17])),
          button('links leeren', () => (links.value = [])),
          button('born/ghost', () => (transient.value = transient.value === 'none' ? 'on' : 'none')),
          button(`labels: ${display.value.labels}`, () => {
            const order: MemoryGraphDisplay['labels'][] = ['hubs', 'selected', 'all']
            display.value = {
              ...display.value,
              labels: order.at((order.indexOf(display.value.labels) + 1) % 3) ?? 'hubs',
            }
          }),
          button(`rotate: ${display.value.autoRotate}`, () => {
            display.value = { ...display.value, autoRotate: !display.value.autoRotate }
          }),
        ]),
        h(
          'div',
          {
            style: ambient.value
              ? 'position:relative;height:70vh;overflow:hidden;border:1px dashed var(--ai-line-strong)'
              : 'max-width:1100px',
          },
          [
            h(MemoryGraphView, {
              graph: shownGraph.value,
              selected: selected.value,
              dream: dream.value,
              display: display.value,
              phase: phase.value,
              links: links.value,
              ambient: ambient.value,
              style: ambient.value ? 'position:absolute;inset:0;height:100%' : '',
              onSelect: (id: string) => (selected.value = id),
            }),
          ]
        ),
        h('p', { style: 'margin-top:8px;color:var(--ai-muted)' }, `Auswahl: ${selected.value}`),
      ]
    ),
}).mount('#app')
