import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, defineComponent, h, nextTick, shallowReactive, type Component } from 'vue'
import * as VueRuntime from 'vue'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuczorMode } from '@/services/inference/types'
import * as PlanningTypes from '@/services/planning/types'
import * as PlanningValidation from '@/services/planning/validation'
import type {
  PlanningAnalyzeInput,
  PlanningExecuteInput,
  PlanningHub,
  PlanningPlan,
  PlanningSession,
} from '@/services/planning/types'

const mocks = vi.hoisted(() => ({
  approvals: { value: [] as unknown[] },
  jobs: vi.fn((): unknown[] => []),
  approvalRevision: { value: 0 },
  resolveApproval: vi.fn(),
}))

vi.mock('@/services/agents/hub', () => ({
  agentExternalApprovals: mocks.approvals,
  agentHub: { listJobs: mocks.jobs },
  agentHubRevision: mocks.approvalRevision,
  resolveAgentExternalApproval: mocks.resolveApproval,
}))
import planningWorkspaceSource from '@/components/planning/PlanningWorkspace.vue?raw'

class HostDocument {
  activeElement: HostNode | null = null
}

class HostShadowRoot {}

const browserWindow = new EventTarget()
const browserDocument = new HostDocument()
const descriptor = parse(planningWorkspaceSource, { filename: 'PlanningWorkspace.vue' }).descriptor
const compiled = compileScript(descriptor, {
  id: 'planning-workspace-test',
  inlineTemplate: true,
  templateOptions: { ssr: false },
})
const transpiled = ts.transpileModule(compiled.content, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const compiledModule: { exports: Record<string, unknown> } = { exports: {} }

function compiledRequire(id: string): unknown {
  switch (id) {
    case 'vue':
      return VueRuntime
    case '@/services/agents/hub':
      return {
        agentExternalApprovals: mocks.approvals,
        agentHub: { listJobs: mocks.jobs },
        agentHubRevision: mocks.approvalRevision,
        resolveAgentExternalApproval: mocks.resolveApproval,
      }
    case '@/services/agents/codexAgent':
      return { getCodexRuntimeStatus: async () => ({ available: false }) }
    case '@/services/agents/modelAgent':
      return { listModelAgentOptions: () => [] }
    case '@/services/planning/hub':
      return { planningHub: {} }
    case '@/services/planning/types':
      return PlanningTypes
    case '@/services/planning/validation':
      return PlanningValidation
    default:
      throw new Error(`Unerwarteter Component-Import: ${id}`)
  }
}

runInNewContext(transpiled, {
  AbortController,
  AbortSignal,
  Blob,
  Event,
  URL,
  clearTimeout,
  console,
  document: browserDocument,
  exports: compiledModule.exports,
  module: compiledModule,
  require: compiledRequire,
  setTimeout,
  window: browserWindow,
})
const ClientPlanningWorkspace = compiledModule.exports.default as Component

type HostKind = 'element' | 'text' | 'comment'
type HostListener = (event: { target: HostNode; type: string }) => void

class HostNode {
  readonly children: HostNode[] = []
  readonly props = new Map<string, unknown>()
  readonly listeners = new Map<string, Set<HostListener>>()
  parent: HostNode | null = null
  text = ''
  value: unknown = ''
  _value: unknown = undefined
  open = false
  selected = false
  selectedIndex = -1

  constructor(
    readonly kind: HostKind,
    readonly tag = ''
  ) {}

  get options(): HostNode[] {
    return this.children.filter(child => child.kind === 'element' && child.tag === 'option')
  }

  getRootNode(): HostNode | HostDocument {
    return this.parent?.getRootNode() ?? browserDocument
  }

  addEventListener(type: string, listener: HostListener): void {
    const listeners = this.listeners.get(type) ?? new Set<HostListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: HostListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, type })
  }

  setAttribute(name: string, value: unknown): void {
    this.props.set(name, value)
    if (name === 'open') this.open = true
  }

  removeAttribute(name: string): void {
    this.props.delete(name)
    if (name === 'open') this.open = false
  }

  showModal(): void {
    this.open = true
    this.props.set('open', '')
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.props.delete('open')
    this.dispatch('close')
  }
}

function insert(child: HostNode, parent: HostNode, anchor: HostNode | null = null): void {
  if (child.parent) {
    const previousIndex = child.parent.children.indexOf(child)
    if (previousIndex >= 0) child.parent.children.splice(previousIndex, 1)
  }
  child.parent = parent
  const index = anchor ? parent.children.indexOf(anchor) : -1
  if (index >= 0) parent.children.splice(index, 0, child)
  else parent.children.push(child)
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(element, key, _previous, next) {
    if (key === 'value') {
      element.value = next ?? ''
      element._value = next
    }
    if (next === null || next === undefined || next === false) element.props.delete(key)
    else element.props.set(key, next)
  },
  insert,
  remove(child) {
    if (!child.parent) return
    const index = child.parent.children.indexOf(child)
    if (index >= 0) child.parent.children.splice(index, 1)
    child.parent = null
  },
  createElement(tag) {
    return new HostNode('element', tag)
  },
  createText(text) {
    const node = new HostNode('text')
    node.text = text
    return node
  },
  createComment(text) {
    const node = new HostNode('comment')
    node.text = text
    return node
  },
  setText(node, text) {
    node.text = text
  },
  setElementText(element, text) {
    element.children.splice(0)
    element.text = text
  },
  parentNode: node => node.parent,
  nextSibling(node) {
    if (!node.parent) return null
    const index = node.parent.children.indexOf(node)
    return node.parent.children[index + 1] ?? null
  },
  querySelector: () => null,
  setScopeId(element, id) {
    element.props.set(id, '')
  },
  cloneNode(node) {
    const clone = new HostNode(node.kind, node.tag)
    clone.text = node.text
    clone.value = node.value
    for (const [key, value] of node.props) clone.props.set(key, value)
    return clone
  },
  insertStaticContent(content, parent, anchor) {
    const node = new HostNode('text')
    node.text = content
    insert(node, parent, anchor)
    return [node, node]
  },
})

function nodeText(node: HostNode): string {
  return [node.text, ...node.children.map(nodeText)].join('')
}

function descendants(node: HostNode): HostNode[] {
  return node.children.flatMap(child => [child, ...descendants(child)])
}

function tokenMatches(node: HostNode, token: string): boolean {
  if (node.kind !== 'element') return false
  const attribute = /\[([^=\]]+)="([^"]*)"\]$/u.exec(token)
  const [, attributeName, attributeValue] = attribute ?? []
  const withoutAttribute = attribute ? token.slice(0, attribute.index) : token
  const className = /\.([a-z0-9_-]+)$/iu.exec(withoutAttribute)?.[1]
  const tag = withoutAttribute.split(/[.[]/u)[0]
  if (tag && node.tag !== tag) return false
  if (
    className &&
    !String(node.props.get('class') ?? '')
      .split(/\s+/u)
      .includes(className)
  )
    return false
  if (attributeName && String(node.props.get(attributeName)) !== attributeValue) return false
  return true
}

function selectorMatches(node: HostNode, selector: string): boolean {
  const tokens = selector.trim().split(/\s+/u)
  const last = tokens.pop()
  if (!last || !tokenMatches(node, last)) return false
  let parent = node.parent
  for (const token of tokens.reverse()) {
    while (parent && !tokenMatches(parent, token)) parent = parent.parent
    if (!parent) return false
    parent = parent.parent
  }
  return true
}

function invoke(handler: unknown, argument: unknown): void {
  if (Array.isArray(handler)) handler.forEach(entry => invoke(entry, argument))
  else if (typeof handler === 'function') void handler(argument)
}

class HostWrapper {
  constructor(
    readonly element: HostNode,
    private readonly rootHarness: TestHarness
  ) {}

  text(): string {
    return nodeText(this.element)
  }

  findAll(selector: string): HostWrapper[] {
    return descendants(this.element)
      .filter(node => selectorMatches(node, selector))
      .map(node => new HostWrapper(node, this.rootHarness))
  }

  find(selector: string): HostWrapper {
    const match = this.findAll(selector)[0]
    if (!match) throw new Error(`Element fehlt: ${selector}`)
    return match
  }

  attributes(name: string): string | undefined {
    const value = this.element.props.get(name)
    return value === undefined || value === false ? undefined : String(value)
  }

  async setValue(value: string): Promise<void> {
    this.element.value = value
    if (this.element.tag === 'select') {
      this.element.options.forEach((option, index) => {
        option.selected = String(option._value ?? option.value) === value
        if (option.selected) this.element.selectedIndex = index
      })
      this.element.dispatch('change')
    } else {
      this.element.dispatch('input')
    }
    await nextTick()
  }

  async trigger(event: string): Promise<void> {
    if (event === 'click') invoke(this.element.props.get('onClick'), { target: this.element, type: event })
    else this.element.dispatch(event)
    await nextTick()
  }

  emitted(name: string): unknown[][] | undefined {
    return this.rootHarness.emissions.get(name)
  }

  unmount(): void {
    this.rootHarness.unmount()
  }
}

type TestHarness = {
  emissions: Map<string, unknown[][]>
  unmount: () => void
}

const analysis = (questions: readonly string[] = []) => ({
  summary: 'Die bestehende Struktur wurde gegen das Ziel geprüft.',
  findings: ['Der Ablauf benötigt zwei klar getrennte Schritte.'],
  evidence: ['src/example.ts:10 belegt den aktuellen Einstieg.'],
  assumptions: ['Die bestehende Schnittstelle bleibt stabil.'],
  risks: ['Ein Abhängigkeitswechsel kann die Reihenfolge beeinflussen.'],
  openQuestions: questions,
})

const plan = (questions: readonly string[] = []): PlanningPlan => ({
  objective: 'Planbares Ziel',
  analysis: analysis(questions),
  steps: [
    {
      id: 'inspect',
      title: 'Bestand prüfen',
      description: 'Relevante Verträge und Grenzen prüfen.',
      dependencies: [],
      acceptanceCriteria: ['Verträge sind belegt.'],
      verification: ['Fokussierten Test ausführen.'],
    },
  ],
  completionCriteria: ['Alle Abnahmekriterien sind mit Nachweisen bewertet.'],
  outOfScope: ['Produktionsdeployment'],
})

class TestPlanningHub implements PlanningHub {
  current: PlanningSession | null
  listeners = new Set<() => void>()
  analyzeCalls: PlanningAnalyzeInput[] = []
  executeCalls: PlanningExecuteInput[] = []
  reviseCalls: PlanningPlan[] = []
  restoreCalls: string[] = []
  cancelCalls = 0
  nextQuestions: readonly string[]
  analyzeBarrier?: Promise<void>

  constructor(
    options: {
      session?: PlanningSession | null
      questions?: readonly string[]
      analyzeBarrier?: Promise<void>
    } = {}
  ) {
    this.current = options.session ?? null
    this.nextQuestions = options.questions ?? []
    this.analyzeBarrier = options.analyzeBarrier
  }

  get(projectId: string) {
    return this.current?.project.projectId === projectId ? this.current : null
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish() {
    this.listeners.forEach(listener => listener())
  }

  async analyze(projectId: string, input: PlanningAnalyzeInput) {
    this.analyzeCalls.push(input)
    await this.analyzeBarrier
    const nextPlan = { ...plan(this.nextQuestions), objective: input.objective }
    this.current = {
      id: 'planning-1',
      revision: (this.current?.revision ?? 0) + 1,
      project: {
        principalId: 'principal-1',
        projectId,
        projectName: 'Planungsprojekt',
        rootPath: 'E:\\project',
        workspaceUpdatedAt: 1,
      },
      objective: input.objective,
      status: 'review',
      analysis: nextPlan.analysis,
      plan: nextPlan,
      execution: null,
      error: '',
      output: '',
    }
    this.publish()
  }

  revise(_projectId: string, nextPlan: PlanningPlan) {
    this.reviseCalls.push(nextPlan)
    if (!this.current) throw new Error('Keine Sitzung')
    this.current = {
      ...this.current,
      revision: this.current.revision + 1,
      plan: nextPlan,
      objective: nextPlan.objective,
    }
    this.publish()
  }

  async execute(_projectId: string, input: PlanningExecuteInput) {
    this.executeCalls.push(input)
    if (!this.current) throw new Error('Keine Sitzung')
    this.current = { ...this.current, status: 'completed', output: 'Lauf beendet; Nachweise müssen geprüft werden.' }
    this.publish()
  }

  cancel() {
    this.cancelCalls++
  }

  export() {
    if (!this.current) throw new Error('Keine Sitzung')
    return JSON.stringify({ version: 1, exportedAt: '2026-09-06T08:00:00.000Z', session: this.current })
  }

  async restore(projectId: string, json: string) {
    this.restoreCalls.push(json)
    const restoredPlan = plan()
    this.current = {
      id: 'restored-1',
      revision: 1,
      project: { principalId: 'principal-1', projectId, projectName: 'Planungsprojekt' },
      objective: restoredPlan.objective,
      status: 'review',
      analysis: restoredPlan.analysis,
      plan: restoredPlan,
      execution: null,
      error: '',
      output: '',
    }
    this.publish()
  }
}

function findButton(wrapper: HostWrapper, label: string) {
  const button = wrapper.findAll('button').find(candidate => candidate.text().includes(label))
  if (!button) throw new Error(`Button fehlt: ${label}`)
  return button
}

async function render(hub: TestPlanningHub, extra: Record<string, unknown> = {}) {
  const props = shallowReactive({
    open: true,
    projectId: 'project-1',
    mode: 'act' as LuczorMode,
    killSwitch: false,
    initialObjective: 'Planbares Ziel',
    hubProp: hub as PlanningHub,
    ...extra,
  })
  const emissions = new Map<string, unknown[][]>()
  const Root = defineComponent(
    () => () =>
      h(ClientPlanningWorkspace, {
        ...props,
        'onUpdate:open': (value: boolean) => {
          const entries = emissions.get('update:open') ?? []
          entries.push([value])
          emissions.set('update:open', entries)
          props.open = value
        },
      })
  )
  const root = new HostNode('element', 'test-root')
  const app = renderer.createApp(Root)
  const harness: TestHarness = { emissions, unmount: () => app.unmount() }
  app.mount(root)
  await nextTick()
  await nextTick()
  return new HostWrapper(root, harness)
}

describe('PlanningWorkspace UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.approvals.value = []
    mocks.jobs.mockReturnValue([])
    mocks.approvalRevision.value = 0
    vi.stubGlobal('window', browserWindow)
    vi.stubGlobal('document', browserDocument)
    vi.stubGlobal('Document', HostDocument)
    vi.stubGlobal('ShadowRoot', HostShadowRoot)
  })

  it('plans on click, requires a saved revision after editing, and executes read-only by default', async () => {
    const hub = new TestPlanningHub()
    const wrapper = await render(hub)

    expect(wrapper.find('textarea').element.value).toBe('Planbares Ziel')
    await wrapper.findAll('textarea')[1]!.setValue('Nur die bestehende Projektschnittstelle berücksichtigen.')
    await findButton(wrapper, 'Analysieren und planen').trigger('click')
    await nextTick()

    expect(hub.analyzeCalls).toEqual([
      expect.objectContaining({
        objective: 'Planbares Ziel',
        adapterId: 'local',
        clarifications: 'Nur die bestehende Projektschnittstelle berücksichtigen.',
      }),
    ])
    expect(wrapper.text()).toContain('Plan prüfen und bearbeiten')
    expect(wrapper.text()).toContain('src/example.ts:10')

    const title = wrapper.find('.planning-workspace__step input[aria-label="Schritttitel"]')
    await title.setValue('Bestand und Verträge prüfen')
    const execute = findButton(wrapper, 'Geprüften Plan ausführen')
    expect(execute.attributes('disabled')).toBeDefined()

    await findButton(wrapper, 'Planänderungen übernehmen').trigger('click')
    await nextTick()
    expect(hub.reviseCalls[0]?.steps[0]?.title).toBe('Bestand und Verträge prüfen')
    expect(findButton(wrapper, 'Revision 2').attributes('disabled')).toBeUndefined()

    await wrapper.find('textarea').setValue('Geändertes Planungsziel')
    expect(findButton(wrapper, 'Revision 2').attributes('disabled')).toBeDefined()
    expect(findButton(wrapper, 'Analysieren und planen').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('Bitte erneut analysieren und planen')
    await findButton(wrapper, 'Analysieren und planen').trigger('click')
    await vi.waitFor(() => expect(hub.analyzeCalls).toHaveLength(2))
    expect(hub.analyzeCalls[1]).toEqual(
      expect.objectContaining({ objective: 'Geändertes Planungsziel', clarifications: undefined })
    )

    await findButton(wrapper, 'Geprüften Plan ausführen').trigger('click')
    expect(hub.executeCalls).toEqual([
      {
        expectedSessionId: 'planning-1',
        expectedRevision: 3,
        adapterId: 'codex',
        model: undefined,
        permission: 'read-only',
      },
    ])
    await vi.waitFor(() => expect(wrapper.text()).toContain('Nachweise und Restgrenzen prüfen'))
    wrapper.unmount()
  })

  it('blocks execution for open questions and replans only after explicit clarifications', async () => {
    const hub = new TestPlanningHub({ questions: ['Welche Zielplattform ist verbindlich?'] })
    const wrapper = await render(hub)
    await findButton(wrapper, 'Analysieren und planen').trigger('click')
    await nextTick()

    expect(wrapper.text()).toContain('Offene Fragen blockieren die Ausführung')
    expect(findButton(wrapper, 'Geprüften Plan ausführen').attributes('disabled')).toBeDefined()
    expect(findButton(wrapper, 'Mit Präzisierungen neu planen').attributes('disabled')).toBeDefined()

    const textareas = wrapper.findAll('textarea')
    await textareas[1]!.setValue('Windows 11 ist die verbindliche Zielplattform.')
    await findButton(wrapper, 'Mit Präzisierungen neu planen').trigger('click')
    expect(hub.analyzeCalls[1]).toEqual(
      expect.objectContaining({ clarifications: 'Windows 11 ist die verbindliche Zielplattform.' })
    )
    expect(hub.executeCalls).toHaveLength(0)
    wrapper.unmount()
  })

  it('restores a plan for review without auto-execution and closing does not cancel it', async () => {
    const hub = new TestPlanningHub()
    const wrapper = await render(hub)
    const textareas = wrapper.findAll('textarea')
    await textareas[textareas.length - 1]!.setValue('{"version":1}')
    await findButton(wrapper, 'Plan zur Prüfung importieren').trigger('click')
    await nextTick()

    expect(hub.restoreCalls).toEqual(['{"version":1}'])
    expect(hub.executeCalls).toHaveLength(0)
    await vi.waitFor(() => expect(wrapper.text()).toContain('startet nicht automatisch'))
    await findButton(wrapper, 'Schließen').trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    expect(hub.cancelCalls).toBe(0)
    wrapper.unmount()
  })

  it('shows and resolves only external approvals belonging to the current planning session', async () => {
    const activePlan = plan()
    const hub = new TestPlanningHub({
      session: {
        id: 'planning-1',
        revision: 1,
        project: { principalId: 'principal-1', projectId: 'project-1', projectName: 'Planungsprojekt' },
        objective: activePlan.objective,
        status: 'review',
        analysis: activePlan.analysis,
        plan: activePlan,
        execution: null,
        error: '',
        output: '',
      },
    })
    mocks.jobs.mockReturnValue([
      { id: 'planning-job', teamRunId: 'planning-1' },
      { id: 'foreign-job', teamRunId: 'other' },
    ])
    mocks.approvals.value = [
      {
        jobId: 'planning-job',
        projectId: 'project-1',
        taskType: 'planning.agent',
        destination: 'https://provider.example.test',
        packetHash: 'a'.repeat(64),
        messageCount: 2,
        characterCount: 42,
        expiresAt: '2026-09-06T09:00:00.000Z',
        toolsAllowed: false,
        messages: [{ role: 'user', content: 'Nur dieses Client-Paket.' }],
      },
      {
        jobId: 'foreign-job',
        projectId: 'project-1',
        taskType: 'chat.agent',
        destination: 'https://foreign.example.test',
        packetHash: 'b'.repeat(64),
        messageCount: 1,
        characterCount: 10,
        expiresAt: '2026-09-06T09:00:00.000Z',
        toolsAllowed: false,
        messages: [{ role: 'user', content: 'Fremd' }],
      },
    ]

    const wrapper = await render(hub)
    expect(wrapper.text()).toContain('https://provider.example.test')
    expect(wrapper.text()).toContain('Nur dieses Client-Paket.')
    expect(wrapper.text()).not.toContain('https://foreign.example.test')
    await findButton(wrapper, 'Dieses Paket freigeben').trigger('click')
    expect(mocks.resolveApproval).toHaveBeenCalledWith('planning-job', true)
    wrapper.unmount()
  })

  it('clears private form data on an identity change and ignores a late analysis completion', async () => {
    let release = () => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const hub = new TestPlanningHub({ analyzeBarrier: barrier })
    const wrapper = await render(hub)
    const initialTextareas = wrapper.findAll('textarea')
    await initialTextareas[0]!.setValue('Vertrauliches Ziel des alten Kontos')
    await initialTextareas[1]!.setValue('Private Präzisierung')
    await initialTextareas[initialTextareas.length - 1]!.setValue('{"private":"import"}')
    await findButton(wrapper, 'Analysieren und planen').trigger('click')

    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    await nextTick()
    const clearedTextareas = wrapper.findAll('textarea')
    expect(clearedTextareas.map(field => field.element.value)).toEqual(['', '', ''])
    expect(wrapper.text()).not.toContain('Vertrauliches Ziel des alten Kontos')

    release()
    await vi.waitFor(() => expect(hub.current?.status).toBe('review'))
    await nextTick()
    expect(wrapper.text()).not.toContain('Plan prüfen und bearbeiten')
    expect(wrapper.text()).not.toContain('src/example.ts:10')
    expect(clearedTextareas[0]!.element.value).toBe('')
    wrapper.unmount()
  })

  it('does not mark missing analysis or plan phases as completed after an early failure', async () => {
    const hub = new TestPlanningHub({
      session: {
        id: 'failed-session',
        revision: 1,
        project: { principalId: 'principal-1', projectId: 'project-1', projectName: 'Planungsprojekt' },
        objective: 'Fehlgeschlagene Planung',
        status: 'failed',
        analysis: null,
        plan: null,
        execution: null,
        error: 'Analyse fehlgeschlagen.',
        output: '',
      },
    })
    const wrapper = await render(hub)
    const phases = wrapper.findAll('.planning-workspace__phases li')
    expect(phases.map(phase => phase.attributes('data-state'))).toEqual(['pending', 'pending', 'pending'])
    wrapper.unmount()
  })
})
