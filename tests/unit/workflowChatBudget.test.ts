import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import cardsSource from '@/components/workflows/WorkflowChatCards.vue?raw'
import budgetSource from '@/components/workflows/WorkflowRunBudget.vue?raw'
import * as budgetApi from '@/services/workflows/runBudget'
import * as workflowTypes from '@/services/workflows/types'
import { miniWorkflowBudgetSnapshot } from '@/services/miniChat/workflowBudgetSnapshot'
import type { WorkflowRun } from '@/services/workflows/types'

const read = vi.fn()
const stop = vi.fn()
const cancel = vi.fn()
const check = vi.fn()
const change = Vue.ref({ projectId: '', sequence: 0 })
function component(source: string, filename: string): Vue.Component {
  const compiled = compileScript(parse(source, { filename }).descriptor, { id: filename, inlineTemplate: true })
  const module = { exports: {} as { default: Vue.Component } }
  runInNewContext(ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, AbortController, setInterval, clearInterval,
    document: { visibilityState: 'visible' },
    require(id: string) {
      if (id === 'vue') return Vue
      if (id.endsWith('/runBudget')) return budgetApi
      if (id.endsWith('/types')) return workflowTypes
      if (id.endsWith('/presentation')) return { workflowChanged: change }
      if (id.endsWith('/access')) return { captureWorkflowAccess: async () => ({ api: { run: read }, check }) }
      if (id.endsWith('/api')) return { stopWorkflowAfterStep: stop }
      if (id === '@/services/tools/workflows') return { workflowTools: [{ name: 'workflow_run_cancel', execute: cancel }] }
      if (id === './WorkflowRunBudget.vue') return { default: Budget }
      throw new Error(`Unexpected module ${id}`)
    },
  })
  return module.exports.default
}
const Budget = component(budgetSource, 'WorkflowRunBudget.vue')
const Cards = component(cardsSource, 'WorkflowChatCards.vue')
type Node = { tag: string; text: string; props: Record<string, unknown>; children: Node[]; parent: Node | null }
const node = (tag: string, text = ''): Node => ({ tag, text, props: {}, children: [], parent: null })
const renderer = Vue.createRenderer<Node, Node>({
  createElement: node, createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(child, parent, anchor) { child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index >= 0) parent.children.splice(index, 0, child); else parent.children.push(child) },
  remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1) },
  setText(child, text) { child.text = text }, setElementText(child, text) { child.text = text; child.children = [] },
  parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  patchProp(child, key, _old, value) { Reflect.set(child.props, key, value) }, setScopeId() {},
})
const contents = (current: Node): string => current.text + current.children.map(contents).join('')
const nodes = (current: Node): Node[] => [current, ...current.children.flatMap(nodes)]
const flush = async () => { for (let index = 0; index < 30; index++) { await Promise.resolve(); await Vue.nextTick() } }
const mounted: Vue.App[] = []
function mount(extra: Record<string, unknown> = {}) {
  const props = Vue.reactive({ workflows: [{ id: 7, name: 'Owned workflow', runId: 'run-public', status: 'running' }], projectId: 'project-1', ...extra })
  const root = node('root')
  const app = renderer.createApp({ render: () => Vue.h(Cards, props) })
  app.mount(root); mounted.push(app)
  const button = (label: string) => nodes(root).find(item => item.tag === 'button' && contents(item).includes(label))!
  return { root, props, button, click: async (label: string) => { const action = button(label); expect(action).toBeTruthy(); expect(action.props.disabled).toBeFalsy(); await (action.props.onClick as () => Promise<void>)(); await flush() } }
}
function run(extra: Record<string, unknown> = {}): WorkflowRun {
  return Object.assign({ id: 15, public_id: 'run-public', workflow_definition_id: 7, project_external_id: 'project-1', status: 'running', sandbox: false }, extra)
}
beforeEach(() => { vi.clearAllMocks(); read.mockResolvedValue({ data: run() }); cancel.mockResolvedValue({ ok: true }); check.mockResolvedValue(undefined) })
afterEach(() => { for (const app of mounted.splice(0)) app.unmount() })

describe('chat workflow budget and stop controls', () => {
  it('shows measured root counters and the 80 percent warning instead of child consumption', async () => {
    read.mockResolvedValue({ data: run({ root_workflow_run_id: 2, budgets: { max_executions: 200 }, budget_state: { executions: 0 }, root_budget: { id: 2, status: 'running', budgets: { max_executions: 200 }, budget_state: { executions: 170 } } }) })
    const { root } = mount(); await flush()
    expect(contents(root)).toContain('170 / 200')
    expect(contents(root)).toContain('Mindestens 80 %')
    expect(contents(root)).toContain('übergeordneten Laufs #2')
  })
  it('keeps an acknowledged boundary stop pending while retaining immediate cancellation', async () => {
    const { root, click, button } = mount(); await flush()
    const pending = run({ budget_state: { boundary_stop: { status: 'pending' } } })
    stop.mockImplementation(async () => { read.mockResolvedValue({ data: pending }); return pending })
    await click('Nach diesem Schritt stoppen')
    expect(stop).toHaveBeenCalledWith('project-1', 7, 'run-public', expect.any(AbortSignal))
    expect(contents(root)).toContain('Halt angefordert – laufende Schritte abschließen')
    expect(contents(root)).not.toContain('Pausiert')
    expect(button('Halt angefordert').props.disabled).toBe(true)
    await click('Sofortigen Stopp anfordern')
    expect(cancel).toHaveBeenCalledWith({ workflow_id: 7, run_id: 'run-public' }, expect.objectContaining({ projectId: 'project-1' }))
  })
  it('discards a late budget read when the project changes and refreshes the new scope', async () => {
    let finish!: (value: { data: WorkflowRun }) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { root, props } = mount(); await flush()
    props.projectId = 'project-2'
    await flush()
    read.mockResolvedValue({ data: run({ project_external_id: 'project-2' }) })
    finish({ data: run({ budgets: { max_executions: 200 }, budget_state: { executions: 199 } }) })
    await flush()
    expect(contents(root)).not.toContain('199 / 200')
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('accepts only bound host projections and emits mini actions without direct API calls', async () => {
    const emitted = vi.fn()
    const { root, click } = mount({ hostOnly: true, hostRunsVerified: true, hostRuns: [run({ budgets: { max_executions: 200 }, budget_state: { executions: 160 } })], onAction: emitted })
    await flush(); expect(contents(root)).toContain('160 / 200')
    await click('Nach diesem Schritt stoppen')
    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 'stop_after_step')
    expect(read).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })
  it('does not forward private run payloads or treat a mismatched root as measured', () => {
    const projected = miniWorkflowBudgetSnapshot(run({ output: { private: 'model content' }, context: { token: 'secret' }, root_workflow_run_id: 2, root_budget: { id: 99, budgets: { max_executions: 200 }, budget_state: { executions: 170 } } }))
    expect(projected).not.toHaveProperty('output'); expect(projected).not.toHaveProperty('context')
    expect(budgetApi.readWorkflowRunBudget(projected, [])).toMatchObject({ rootUnavailable: true, rows: [] })
  })
})
