import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, h, nextTick, shallowReactive, type Component } from 'vue'
import * as VueRuntime from 'vue'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import source from '@/components/projects/AutonomousGoalControl.vue?raw'
import { useDismissible } from '@/composables/useDismissible'

const descriptor = parse(source, { filename: 'AutonomousGoalControl.vue' }).descriptor
const compiled = compileScript(descriptor, {
  id: 'autonomous-goal-control-test',
  inlineTemplate: true,
  templateOptions: { ssr: false },
})
const compiledModule: { exports: Record<string, unknown> } = { exports: {} }
runInNewContext(
  ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: compiledModule.exports,
    module: compiledModule,
    require: (id: string) => {
      if (id === 'vue') return VueRuntime
      // This client-renderer harness tests interactions; the decorative SVG has
      // separate SSR coverage and must not load Vite's server-only component.
      if (id === '@/components/ai/AiIcon.vue') return { default: () => h('svg', { 'aria-hidden': 'true' }) }
      if (id === '@/composables/useDismissible') return { useDismissible }
      throw new Error(`Unexpected import ${id}`)
    },
  }
)
const GoalControl = compiledModule.exports.default as Component

class HostNode {
  children: HostNode[] = []
  parent: HostNode | null = null
  props = new Map<string, unknown>()
  text = ''
  value = ''
  focus = vi.fn()
  constructor(readonly tag: string) {}
}

function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null): void {
  if (child.parent) {
    const previous = child.parent.children.indexOf(child)
    if (previous >= 0) child.parent.children.splice(previous, 1)
  }
  child.parent = parent
  const index = anchor ? parent.children.indexOf(anchor) : -1
  if (index >= 0) parent.children.splice(index, 0, child)
  else parent.children.push(child)
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(element, key, _previous, next) {
    element.props.set(key, next)
    if (key === 'value') element.value = String(next ?? '')
  },
  insert,
  remove(child) {
    if (!child.parent) return
    const index = child.parent.children.indexOf(child)
    if (index >= 0) child.parent.children.splice(index, 1)
    child.parent = null
  },
  createElement: tag => new HostNode(tag),
  createText(text) {
    const node = new HostNode('#text')
    node.text = text
    return node
  },
  createComment: () => new HostNode('#comment'),
  setText(node, text) {
    node.text = text
  },
  setElementText(node, text) {
    node.children = []
    node.text = text
  },
  parentNode: node => node.parent,
  nextSibling(node) {
    return node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null
  },
  setScopeId: (node, id) => node.props.set(id, ''),
  insertStaticContent(content, parent, anchor) {
    const node = new HostNode('#static')
    node.text = content
    insert(node, parent, anchor)
    return [node, node]
  },
})

function descendants(node: HostNode): HostNode[] {
  return node.children.flatMap(child => [child, ...descendants(child)])
}
function text(node: HostNode): string {
  return [node.text, ...node.children.map(text)].join('')
}
function find(node: HostNode, predicate: (candidate: HostNode) => boolean): HostNode {
  const match = descendants(node).find(predicate)
  if (!match) throw new Error('Control was not rendered')
  return match
}
function withClass(node: HostNode, value: string): HostNode {
  return find(node, candidate => String(candidate.props.get('class')).split(' ').includes(value))
}
async function dispatch(node: HostNode, type: string, event: Record<string, unknown> = {}): Promise<void> {
  const handler = node.props.get(`on${type}`)
  if (typeof handler !== 'function') throw new Error(`Missing ${type} handler`)
  await handler({ target: node, stopPropagation: vi.fn(), preventDefault: vi.fn(), ...event })
  await nextTick()
}

type Model = {
  text: string
  active: boolean
  status: 'idle' | 'running' | 'checking' | 'waiting' | 'blocked' | 'completed'
  revision: number
  iterations: number
  phase: 'work' | 'review'
  updatedAt: number
  progress?: string
  evidence?: string
  reason?: string
}
const saved: Model = {
  text: 'Erstelle einen geprüften Optimierungsplan.',
  active: false,
  status: 'idle',
  revision: 1,
  iterations: 0,
  phase: 'work',
  updatedAt: 1,
}

function mount(model: Model | undefined = saved, busy = false) {
  const props = shallowReactive<{ model: Model | undefined; busy: boolean }>({ model, busy })
  const save = vi.fn()
  const toggle = vi.fn()
  const root = new HostNode('root')
  renderer.createApp({ render: () => h(GoalControl, { ...props, onSave: save, onToggle: toggle }) }).mount(root)
  return { root, props, save, toggle }
}

describe('AutonomousGoalControl', () => {
  it('starts collapsed, opens an accessible saved goal and focuses its editor', async () => {
    const { root } = mount()
    const trigger = withClass(root, 'goal-control__trigger')
    expect(trigger.props.get('aria-expanded')).toBe(false)
    expect(descendants(root).some(node => node.tag === 'textarea')).toBe(false)
    await dispatch(trigger, 'Click')
    const region = find(root, node => node.props.get('role') === 'region')
    const editor = find(root, node => node.tag === 'textarea')
    expect(region.props.get('id')).toBe(trigger.props.get('aria-controls'))
    expect(editor.value).toBe(saved.text)
    expect(editor.props.get('maxlength')).toBe('6000')
    expect(editor.focus).toHaveBeenCalledOnce()
    expect(text(root)).toContain('Pausiert')
  })

  it('keeps pause and edit/save usable throughout a busy goal run', async () => {
    const { root, save, toggle } = mount({ ...saved, active: true, status: 'running' }, true)
    await dispatch(withClass(root, 'goal-control__pause'), 'Click')
    expect(toggle).toHaveBeenLastCalledWith(false)
    await dispatch(withClass(root, 'goal-control__trigger'), 'Click')
    const editor = find(root, node => node.tag === 'textarea')
    editor.value = '  Neues prüfbares Ziel  '
    await dispatch(editor, 'Input')
    const saveButton = withClass(root, 'goal-control__save')
    expect(saveButton.props.get('disabled')).toBe(false)
    await dispatch(saveButton, 'Click')
    expect(save).toHaveBeenCalledWith('Neues prüfbares Ziel')
    const toggleButton = withClass(root, 'goal-control__switch')
    expect(toggleButton.props.get('disabled')).toBe(false)
    expect(toggleButton.props.get('aria-checked')).toBe(true)
    await dispatch(toggleButton, 'Click')
    expect(toggle).toHaveBeenLastCalledWith(false)
  })

  it('retains an unsaved draft across progress changes and closing, then accepts the save acknowledgement', async () => {
    const { root, props } = mount()
    const trigger = withClass(root, 'goal-control__trigger')
    await dispatch(trigger, 'Click')
    const editor = find(root, node => node.tag === 'textarea')
    editor.value = 'Mein neuer Entwurf'
    await dispatch(editor, 'Input')
    props.model = { ...saved, active: true, status: 'checking', iterations: 3, updatedAt: 5 }
    await nextTick()
    expect(editor.value).toBe('Mein neuer Entwurf')
    expect(text(root)).toContain('3 Durchläufe')
    await dispatch(trigger, 'Click')
    await dispatch(trigger, 'Click')
    expect(find(root, node => node.tag === 'textarea').value).toBe('Mein neuer Entwurf')
    props.model = { ...saved, text: 'Mein neuer Entwurf', revision: 2 }
    await nextTick()
    expect(withClass(root, 'goal-control__save').props.get('disabled')).toBe(true)
    expect(text(root)).toContain('Ziel gespeichert')
  })

  it('does not discard edits if a different saved goal arrives and permits explicit adoption', async () => {
    const { root, props } = mount()
    await dispatch(withClass(root, 'goal-control__trigger'), 'Click')
    const editor = find(root, node => node.tag === 'textarea')
    editor.value = 'Lokaler Entwurf'
    await dispatch(editor, 'Input')
    props.model = { ...saved, text: 'Anderes gespeichertes Ziel', revision: 2 }
    await nextTick()
    expect(editor.value).toBe('Lokaler Entwurf')
    await dispatch(
      find(root, node => node.tag === 'button' && text(node) === 'Gespeichertes Ziel übernehmen'),
      'Click'
    )
    expect(editor.value).toBe('Anderes gespeichertes Ziel')
    expect(withClass(root, 'goal-control__save').props.get('disabled')).toBe(true)
  })

  it('does not activate an unsaved goal or save blank/oversized content', async () => {
    const { root, save, props } = mount()
    props.model = undefined
    await nextTick()
    await dispatch(withClass(root, 'goal-control__trigger'), 'Click')
    expect(withClass(root, 'goal-control__switch').props.get('disabled')).toBe(true)
    const editor = find(root, node => node.tag === 'textarea')
    for (const value of ['   ', 'x'.repeat(6001)]) {
      editor.value = value
      await dispatch(editor, 'Input')
      expect(withClass(root, 'goal-control__save').props.get('disabled')).toBe(true)
      await dispatch(withClass(root, 'goal-control__save'), 'Click')
    }
    expect(save).not.toHaveBeenCalled()
  })

  it('shows completed separately from paused, renders evidence as text and restores focus on Escape', async () => {
    const { root } = mount({ ...saved, status: 'completed', iterations: 2, evidence: '<script>test</script>' })
    const trigger = withClass(root, 'goal-control__trigger')
    await dispatch(trigger, 'Click')
    expect(text(root)).toContain('Ziel erreicht')
    expect(text(root)).toContain('<script>test</script>')
    expect(descendants(root).some(node => node.tag === 'script')).toBe(false)
    await dispatch(withClass(root, 'goal-control'), 'Keydown', { key: 'Escape' })
    expect(trigger.props.get('aria-expanded')).toBe(false)
    expect(trigger.focus).toHaveBeenCalledOnce()
  })
})
