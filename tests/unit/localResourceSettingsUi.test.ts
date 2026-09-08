import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, nextTick, type Component } from 'vue'
import * as VueRuntime from 'vue'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { LocalResourceSettingsClient } from '@/components/LocalResourceSettings.vue'
import source from '@/components/LocalResourceSettings.vue?raw'
import * as ResourceApi from '@/services/inference/resources'
import { DEFAULT_LOCAL_RESOURCE_CONFIG, type LocalResourceConfigState } from '@/services/inference/resources'
import type { HardwareSnapshot } from '@/services/inference/capacity'

const compiled = compileScript(parse(source, { filename: 'LocalResourceSettings.vue' }).descriptor, {
  id: 'resource-settings-test',
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
    require: (id: string) => {
      if (id === 'vue') return VueRuntime
      if (id === '@/services/inference/resources') return ResourceApi
      throw new Error(`Unexpected test module: ${id}`)
    },
  }
)
const LocalResourceSettings = compiledModule.exports.default as Component

class Node {
  children: Node[] = []
  parent: Node | null = null
  props: Record<string, unknown> = {}
  text = ''
  value: unknown = ''
  checked = false
  constructor(readonly tag: string) {}
  addEventListener() {}
  removeEventListener() {}
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
  createComment: text => Object.assign(new Node('#comment'), { text }),
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
  patchProp(node, key, _previous, value) {
    // Renderer keys come exclusively from Vue's compiled fixture template.
    // eslint-disable-next-line security/detect-object-injection
    node.props[key] = value
    if (key === 'value') node.value = value
  },
  setScopeId() {},
  insertStaticContent(content, parent, anchor) {
    const node = Object.assign(new Node('#text'), { text: content })
    insert(node, parent, anchor)
    return [node, node]
  },
})
const text = (node: Node): string => node.text + node.children.map(text).join('')
const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)]
const flush = async () => {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
    await nextTick()
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const state = (): LocalResourceConfigState => ({
  requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
  applied: { ...DEFAULT_LOCAL_RESOURCE_CONFIG },
  revision: 4,
  appliedRevision: 4,
  pending: false,
  reasonCode: null,
})
const hardware: HardwareSnapshot = {
  schemaVersion: 1,
  snapshotId: 'example',
  capturedAtMs: 1,
  platform: 'windows',
  arch: 'x86_64',
  cpu: { logicalCores: 20, loadPercent: null, features: [] },
  memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 },
  accelerators: [
    {
      id: 'dxgi-example',
      name: 'Example GPU',
      backend: 'unknown',
      totalBytes: 24 * 1024 ** 3,
      availableBytes: null,
      sharedSystemLimitBytes: 16 * 1024 ** 3,
    },
  ],
  storage: [],
}
async function mount(initial = state(), hardwareSnapshot = hardware) {
  let listener: (value: LocalResourceConfigState) => void = () => {}
  const unsubscribe = vi.fn()
  const client: LocalResourceSettingsClient = {
    read: vi.fn(async () => clone(initial)),
    hardware: vi.fn(async () => clone(hardwareSnapshot)),
    save: vi.fn(async config => ({ ...clone(initial), requested: clone(config), revision: 5, pending: true })),
    subscribe: vi.fn(async callback => {
      listener = callback
      return unsubscribe
    }),
  }
  const root = new Node('root')
  const app = renderer.createApp(LocalResourceSettings, { client })
  app.mount(root)
  await flush()
  const button = (label: string) => nodes(root).find(node => node.tag === 'button' && text(node).includes(label))!
  const click = async (label: string) => {
    ;(button(label).props.onClick as () => void)()
    await flush()
  }
  const mode = async (value: string) => {
    const radio = nodes(root).find(node => node.tag === 'input' && node.props.value === value)!
    ;(radio.props['onUpdate:modelValue'] as (value: string) => void)(value)
    await flush()
  }
  return {
    root,
    app,
    client,
    unsubscribe,
    button,
    click,
    mode,
    publish: (value: LocalResourceConfigState) => listener(value),
  }
}

describe('device resources settings UI', () => {
  it('loads without saving and shows unknown GPU memory/backend honestly', async () => {
    const view = await mount()
    expect(text(view.root)).toContain('Freier VRAM unbekannt')
    expect(text(view.root)).toContain('Inferenz-Backend noch ungeprüft')
    expect(text(view.root)).toContain('kein zusätzlicher VRAM')
    expect(view.client.save).not.toHaveBeenCalled()
    expect(view.button('Ressourcen speichern').props.disabled).toBe(true)
    view.app.unmount()
    expect(view.unsubscribe).toHaveBeenCalledOnce()
  })

  it('saves a mode with the observed revision and keeps the applied mode while pending', async () => {
    const view = await mount()
    await view.mode('gpu')
    await view.click('Ressourcen speichern')
    expect(view.client.save).toHaveBeenCalledWith({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, 4)
    expect(text(view.root)).toContain('Gewählt GPU – Automatik als Ersatz')
    expect(text(view.root)).toContain('Angewandt Automatisch')
    expect(text(view.root)).toContain('Laufende Chats und Agenten arbeiten mit den bisherigen Einstellungen weiter')
    view.app.unmount()
  })

  it('preserves an unsaved draft but refuses to overwrite a concurrent configuration change', async () => {
    const view = await mount()
    await view.mode('cpu')
    view.publish({ ...state(), requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'gpu' }, revision: 8 })
    await flush()
    await view.click('Ressourcen speichern')
    expect(view.client.save).not.toHaveBeenCalled()
    expect(text(view.root)).toContain('zwischenzeitlich geändert')
    view.app.unmount()
  })

  it('ignores stale pending notifications after that revision has already been applied', async () => {
    const view = await mount({ ...state(), revision: 5, appliedRevision: 5 })
    view.publish({ ...state(), revision: 5, appliedRevision: 4, pending: true })
    await flush()
    expect(text(view.root)).not.toContain('Änderung vorgemerkt')
    view.app.unmount()
  })

  it('validates thread counts and reserve minima before invoking native persistence', async () => {
    const view = await mount()
    const number = nodes(view.root).find(node => node.tag === 'input' && node.props.type === 'number')!
    ;(number.props.onInput as (event: unknown) => void)({ target: { value: '21' } })
    await flush()
    expect(text(view.root)).toContain('zwischen 1 und 20 Threads')
    await view.click('Ressourcen speichern')
    expect(view.client.save).not.toHaveBeenCalled()
    ;(number.props.onInput as (event: unknown) => void)({ target: { value: '' } })
    const ram = nodes(view.root).filter(node => node.tag === 'input' && node.props.type === 'number')[2]!
    ;(ram.props.onInput as (event: unknown) => void)({ target: { value: '0' } })
    await flush()
    expect(text(view.root)).toContain('RAM-Puffer: mindestens 1 GiB')
    expect(view.button('Ressourcen speichern').props.disabled).toBe(true)
    view.app.unmount()
  })

  it('limits threads to available process cores even when the CPU exposes more logical cores', async () => {
    const view = await mount(state(), { ...hardware, cpu: { ...hardware.cpu, availableLogicalCores: 8 } })
    const number = nodes(view.root).find(node => node.tag === 'input' && node.props.type === 'number')!
    expect(number.props.max).toBe(8)
    ;(number.props.onInput as (event: unknown) => void)({ target: { value: '9' } })
    await flush()
    expect(text(view.root)).toContain('zwischen 1 und 8 Threads')
    await view.click('Ressourcen speichern')
    expect(view.client.save).not.toHaveBeenCalled()
    ;(number.props.onInput as (event: unknown) => void)({ target: { value: '8' } })
    await flush()
    await view.click('Ressourcen speichern')
    expect(view.client.save).toHaveBeenCalledWith({ ...DEFAULT_LOCAL_RESOURCE_CONFIG, threads: 8 }, 4)
    view.app.unmount()
  })

  it('reset is a reviewable draft and only saving persists the automatic configuration', async () => {
    const custom = { ...state(), requested: { ...DEFAULT_LOCAL_RESOURCE_CONFIG, mode: 'cpu' as const, threads: 8 } }
    const view = await mount(custom)
    await view.click('Auf Automatik zurücksetzen')
    expect(view.client.save).not.toHaveBeenCalled()
    await view.click('Ressourcen speichern')
    expect(view.client.save).toHaveBeenCalledWith({ ...DEFAULT_LOCAL_RESOURCE_CONFIG }, 4)
    view.app.unmount()
  })

  it('does not expose raw IPC errors or falsely confirm a failed save', async () => {
    const view = await mount()
    vi.mocked(view.client.save).mockRejectedValue(new Error('secret-path-and-token'))
    await view.mode('gpu')
    await view.click('Ressourcen speichern')
    expect(text(view.root)).toContain('Die Einstellung wurde nicht bestätigt')
    expect(text(view.root)).not.toContain('secret-path-and-token')
    expect(text(view.root)).not.toContain('Gespeichert.')
    view.app.unmount()
  })
})
