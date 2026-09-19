import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, h, nextTick, shallowReactive, shallowRef, type Component } from 'vue'
import * as VueRuntime from 'vue'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import source from '@/features/memory/MemoryDreamPanel.vue?raw'
import * as DreamApi from '@/services/memory/dreamTrace'
import * as FailureApi from '@/services/inference/localFailure'
import * as IdleRecoveryApi from '@/services/inference/idleRecovery'
import type { DreamView } from '@/features/memory/MemoryGraphView.vue'

const status = shallowRef({ phase: 'waiting', reason: 'activity' })
const idleApi = {
  idleOptimizationEnabled: shallowRef(true),
  idleOptimizationStatus: status,
  idleOptimizationBlocker: vi.fn(() => null),
  requestIdleOptimization: vi.fn(() => true),
  saveIdleOptimizationSetting: vi.fn(async () => undefined),
}
const compiled = compileScript(parse(source, { filename: 'MemoryDreamPanel.vue' }).descriptor, {
  id: 'dream-panel-test',
  inlineTemplate: true,
  templateOptions: { ssr: false },
})
const compiledModule: { exports: Record<string, unknown> } = { exports: {} }
runInNewContext(
  ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    module: compiledModule,
    exports: compiledModule.exports,
    Date,
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    require: (id: string) => {
      if (id === 'vue') return VueRuntime
      if (id === '@/services/memory/dreamTrace') return DreamApi
      if (id === '@/services/inference/localFailure') return FailureApi
      if (id === '@/services/inference/idleRecovery') return IdleRecoveryApi
      if (id === '@/services/agents/idleOptimization') return idleApi
      if (id === '@/services/agents/idleMaintenanceWorker')
        return { maintenanceProgress: shallowRef({ queued: 30, blocked: 0, checked: 0, changed: 0 }) }
      if (id === '@/services/memory/luczorMemory') return { luczorMemory: {} }
      if (id === '@/services/accountPrincipal') return { getVerifiedAccountSnapshot: vi.fn() }
      throw new Error(`Unexpected test module: ${id}`)
    },
  }
)
const Panel = compiledModule.exports.default as Component
class Node {
  children: Node[] = []
  parent: Node | null = null
  props = new Map<string, unknown>()
  text = ''
  constructor(readonly tag: string) {}
}
function insert(node: Node, parent: Node, anchor: Node | null = null) {
  if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
  const index = anchor ? parent.children.indexOf(anchor) : -1
  if (index < 0) parent.children.push(node)
  else parent.children.splice(index, 0, node)
  node.parent = parent
}
const renderer = createRenderer<Node, Node>({
  createElement: tag => new Node(tag),
  createText: text => Object.assign(new Node('#text'), { text }),
  createComment: () => new Node('#comment'),
  insert,
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
  },
  setText(node, text) {
    node.text = text
  },
  setElementText(node, text) {
    node.text = text
    node.children = []
  },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  patchProp: (node, key, _previous, value) => {
    node.props.set(key, value)
  },
  setScopeId() {},
  insertStaticContent(content, parent, anchor) {
    const node = Object.assign(new Node('#static'), { text: content })
    insert(node, parent, anchor)
    return [node, node]
  },
})
const text = (node: Node): string => node.text + node.children.map(text).join('')
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)]
const disposals: Array<() => void> = []
async function mount() {
  const empty = new Set<string>()
  const props = shallowReactive<{ dream: DreamView; trace: DreamApi.DreamTrace; projectId: string }>({
    dream: { active: false, run: null, reading: empty, removing: empty, conflicts: empty, touched: empty },
    trace: { current: null, history: [], scan: null, lastSkip: null, offload: null },
    projectId: 'project',
  })
  const root = new Node('root')
  const app = renderer.createApp({ render: () => h(Panel, props) })
  app.mount(root)
  disposals.push(() => app.unmount())
  const button = nodes(root).find(node => node.tag === 'button' && text(node) === 'Jetzt träumen')!
  await (button.props.get('onClick') as () => Promise<void>)()
  await nextTick()
  const run: DreamApi.DreamRun = {
    id: 'run',
    startedAt: Date.now(),
    jobKey: 'context:project',
    task: 'context',
    scope: 'project',
    steps: [],
    decisions: [],
  }
  const updateRun = async (outcome?: DreamApi.DreamRun['outcome'], error?: string) => {
    const current = { ...run, outcome, error, endedAt: outcome ? Date.now() : undefined }
    props.trace = { ...props.trace, current: outcome ? null : current, history: outcome ? [current] : [] }
    props.dream = { ...props.dream, active: !outcome, run: current }
    await nextTick()
  }
  const message = () => text(nodes(root).find(node => node.props.get('class') === 'dream-panel__message')!)
  const offload = () => {
    const node = nodes(root).find(node => node.props.get('class') === 'dream-panel__offload')
    return node ? text(node) : ''
  }
  const updateOffload = async (active = true) => {
    props.trace = {
      ...props.trace,
      offload: { at: Date.now(), active, freeRamMiB: 2898, swapFreeMiB: 33947 },
    }
    await nextTick()
  }
  return { root, message, updateRun, offload, updateOffload }
}
beforeEach(() => {
  status.value = { phase: 'waiting', reason: 'activity' }
  vi.clearAllMocks()
})
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose())
  vi.restoreAllMocks()
})

describe('dream panel lifecycle', () => {
  it('shows a recoverable model wait instead of reporting broken memory', async () => {
    const panel = await mount()
    await panel.updateRun('interrupted', 'idle_model_cooldown')
    status.value = { phase: 'paused', reason: 'idle_model_cooldown' }
    await nextTick()
    expect(text(panel.root)).toContain('Modell-Abkühlphase')
    expect(text(panel.root)).toContain('automatische Wiederholung')
    expect(panel.message()).not.toContain('Traum fehlgeschlagen')
  })

  it('replaces the running banner when preparation fails, including a later trace settlement', async () => {
    const panel = await mount()
    await panel.updateRun()
    status.value = { phase: 'running', reason: 'gathering_sources' }
    await nextTick()
    expect(panel.message()).toContain('das Modell hat noch nicht begonnen')
    status.value = { phase: 'running', reason: 'generating' }
    await nextTick()
    expect(panel.message()).toContain('Der Traum läuft')
    status.value = { phase: 'cooldown', reason: 'failed' }
    await nextTick()
    expect(panel.message()).not.toContain('Der Traum läuft')
    await panel.updateRun('failed', 'model_files_unavailable')
    expect(panel.message()).toContain('Installierte Modelldateien sind nicht verfügbar')
    status.value = { phase: 'paused', reason: 'activity' }
    await nextTick()
    expect(panel.message()).not.toContain('Der Traum läuft')
  })

  it('keeps interruption pending until work actually settles, also for long runs', async () => {
    const panel = await mount()
    await panel.updateRun()
    status.value = { phase: 'running', reason: 'generating' }
    await nextTick()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
    status.value = { phase: 'yielding', reason: 'foreground' }
    await nextTick()
    expect(panel.message()).toContain('noch freigegeben')
    await panel.updateRun('interrupted')
    status.value = { phase: 'paused', reason: 'activity' }
    await nextTick()
    expect(panel.message()).toContain('Traum pausiert: Eingabe erkannt')
    expect(panel.message()).not.toContain('läuft')
  })

  it('distinguishes a successful commit from a declined start', async () => {
    const panel = await mount()
    await panel.updateRun()
    status.value = { phase: 'committing', reason: 'candidate_ready' }
    await nextTick()
    expect(panel.message()).toContain('wird übernommen')
    await panel.updateRun('success')
    status.value = { phase: 'cooldown', reason: 'candidate_ready' }
    await nextTick()
    expect(panel.message()).toBe('Traum abgeschlossen und übernommen.')
    const declined = await mount()
    status.value = { phase: 'paused', reason: 'memory_disabled' }
    await nextTick()
    expect(declined.message()).toContain('Traum nicht gestartet')
  })

  it('labels free system capacity without claiming measured paging or memory demand', async () => {
    const panel = await mount()
    await panel.updateRun()
    await panel.updateOffload()
    status.value = { phase: 'running', reason: 'generating' }
    await nextTick()
    expect(panel.offload()).toContain('RAM-schonender Modus')
    expect(panel.offload()).toContain('33.947 MiB frei')
    expect(panel.offload()).toContain('systemweit verfügbare Kapazität')
    expect(panel.offload()).toContain('kein Speicherbedarf oder gemessener Verbrauch von Luczor')
    expect(panel.offload()).toContain('wird hier nicht gemessen')
    expect(panel.offload()).not.toContain('läuft langsamer')
    expect(text(panel.root)).toContain('ein begrenztes Quellenbündel')
  })

  it('does not show stale offload activity after failure, pause or while yielding', async () => {
    const panel = await mount()
    await panel.updateOffload()
    expect(panel.offload()).toBe('')
    await panel.updateRun()
    status.value = { phase: 'running', reason: 'generating' }
    await nextTick()
    expect(panel.offload()).not.toBe('')
    status.value = { phase: 'yielding', reason: 'foreground' }
    await nextTick()
    expect(panel.offload()).toBe('')
    status.value = { phase: 'paused', reason: 'activity' }
    await nextTick()
    expect(panel.offload()).toBe('')
    await panel.updateRun('failed', 'runtime_stream_failed')
    expect(panel.message()).toContain('Lokale Modellausgabe wurde unterbrochen')
    expect(panel.message()).toContain('belegt keinen RAM-Mangel')
    expect(panel.offload()).toBe('')
    expect(text(panel.root)).not.toContain('Notfall-Auslagerung aktiv')
  })

  it.each([
    ['runtime_first_progress_timeout', 'vor dem Zeitlimit keinen Fortschritt'],
    ['runtime_progress_timeout', 'zu lange keinen weiteren Fortschritt'],
    ['runtime_total_timeout', 'sein Gesamtzeitlimit erreicht'],
  ])('explains the observed timeout %s without diagnosing memory exhaustion', async (code, explanation) => {
    const panel = await mount()
    await panel.updateRun()
    status.value = { phase: 'running', reason: 'generating' }
    await nextTick()
    await panel.updateRun('failed', code)
    status.value = { phase: 'cooldown', reason: 'failed' }
    await nextTick()
    expect(panel.message()).toContain(explanation)
    expect(panel.message()).not.toContain('RAM-Mangel')
  })
})
