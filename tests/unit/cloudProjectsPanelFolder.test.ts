import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, nextTick, reactive, type Component } from 'vue'
import * as VueRuntime from 'vue'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import source from '@/components/projects/CloudProjectsPanel.vue?raw'

const appState = reactive({
  projects: [
    {
      id: 'local',
      name: 'Shared project',
      cloud: { principalId: 'owner', projectId: 7, externalId: 'global', revision: 2, folderShared: false },
    },
  ],
})
const cloudApi = {
  cloudProjectsState: reactive({
    principalId: 'owner',
    busy: false,
    projects: [{ id: 7, external_id: 'global', name: 'Shared project', folder_shared: false }],
    status: {} as Record<string, unknown>,
    error: '',
  }),
  listCloudProjects: vi.fn(async () => []),
  publishCloudProject: vi.fn(),
  syncCloudProjects: vi.fn(),
  importCloudProject: vi.fn(),
  copyCloudProject: vi.fn(),
  pauseCloudProject: vi.fn(),
}
const mirrorApi = {
  projectMirrorState: reactive({} as Record<string, unknown>),
  setProjectFolderShared: vi.fn(async (_id: string, shared: boolean) => {
    appState.projects[0]!.cloud.folderShared = shared
  }),
  syncProjectMirror: vi.fn(async () => undefined),
  pauseProjectMirror: vi.fn(async () => undefined),
}
const compiled = compileScript(parse(source, { filename: 'CloudProjectsPanel.vue' }).descriptor, {
  id: 'cloud-projects-panel-test',
  inlineTemplate: true,
  templateOptions: { ssr: false },
})
const compiledModule: { exports: Record<string, unknown> } = { exports: {} }
class Element {}
runInNewContext(
  ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    module: compiledModule,
    exports: compiledModule.exports,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { activeElement: null },
    HTMLElement: Element,
    require: (id: string) => {
      if (id === 'vue') return VueRuntime
      if (id === '@/state/store') return { state: appState }
      if (id === '@/services/api/cloudProjects') return cloudApi
      if (id === '@/services/coordination/mirror') return mirrorApi
      if (id === '@/components/ai/AiIcon.vue') return { default: { name: 'AiIcon', render: () => null } }
      throw new Error(`Unexpected test module: ${id}`)
    },
  }
)
const Panel = compiledModule.exports.default as Component

class Node {
  children: Node[] = []
  parent: Node | null = null
  props: Record<string, unknown> = {}
  text = ''
  open = false
  constructor(readonly tag: string) {}
  showModal() {
    this.open = true
  }
  close() {
    this.open = false
  }
  focus() {}
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
type Workspace = { rootPath: string; status: 'ready' | 'missing' } | null
async function mount(workspace: Workspace = null) {
  const root = new Node('root')
  const props = reactive({
    open: true,
    projectId: 'local',
    busy: false,
    workspace,
    workspaceBusy: false,
    selected: [] as string[],
    'onSelect-folder': () => props.selected.push('folder'),
    'onUpdate:open': (value: boolean) => {
      props.open = value
    },
  })
  const app = renderer.createApp({ render: () => VueRuntime.h(Panel, props) })
  app.mount(root)
  await flush()
  const button = (label: string) => nodes(root).find(node => node.tag === 'button' && text(node).includes(label))
  const click = async (label: string) => {
    ;(button(label)!.props.onClick as () => void)()
    await flush()
  }
  const toggle = () => nodes(root).find(node => node.tag === 'input' && node.props.role === 'switch')
  return { root, props, button, click, toggle, body: () => text(root) }
}

beforeEach(() => {
  vi.clearAllMocks()
  appState.projects[0]!.cloud.folderShared = false
  delete mirrorApi.projectMirrorState.local
})

describe('global project folder tab', () => {
  it('selects whole folders only and switches sharing on the server for every device', async () => {
    const view = await mount()
    await view.click('Projektdateien')
    expect(view.body()).toContain('Projektordner auswählen')
    expect(view.body()).toContain('Einzelne Dateien werden nicht ausgewählt')
    expect(view.body()).not.toContain('Dateiinhalt')
    expect(view.toggle()?.props.checked).toBe(false)
    expect(view.body()).not.toContain('Jetzt abgleichen')
    await view.click('Projektordner auswählen')
    expect(view.props.selected).toEqual(['folder'])
    ;(view.toggle()!.props.onChange as () => void)()
    await flush()
    expect(mirrorApi.setProjectFolderShared).toHaveBeenCalledWith('local', true)
    expect(view.toggle()?.props.checked).toBe(true)
    expect(view.body()).toContain('Wähle jetzt den lokalen Projektordner')
    expect(view.body()).toContain('Lokalen Projektordner zuordnen')
    // Without a bound folder there is nothing to sync on this device yet.
    expect(mirrorApi.syncProjectMirror).not.toHaveBeenCalled()
  })

  it('starts the download on a second device as soon as its folder is chosen', async () => {
    appState.projects[0]!.cloud.folderShared = true
    const view = await mount()
    await view.click('Projektdateien')
    expect(view.toggle()?.props.checked).toBe(true)
    expect(mirrorApi.syncProjectMirror).not.toHaveBeenCalled()
    view.props.workspace = { rootPath: 'D:\\Projekte\\shared', status: 'ready' }
    await flush()
    expect(mirrorApi.syncProjectMirror).toHaveBeenCalledWith('local')
    expect(view.body()).toContain('D:\\Projekte\\shared')
    expect(view.body()).toContain('Anderen Ordner wählen')
    mirrorApi.projectMirrorState.local = {
      stage: 'Ordner vollständig abgeglichen',
      revision: 5,
      files: 12,
      transferred: 2 * 1048576,
      conflicts: 1,
      busy: false,
      paused: false,
      error: '',
      shared: true,
    }
    await flush()
    expect(view.body()).toContain('Ordner vollständig abgeglichen')
    expect(view.body()).toContain('Revision 5')
    expect(view.body()).toContain('1 überlappende Änderung:')
    await view.click('Jetzt abgleichen')
    expect(mirrorApi.syncProjectMirror).toHaveBeenCalledTimes(2)
    ;(view.toggle()!.props.onChange as () => void)()
    await flush()
    expect(mirrorApi.setProjectFolderShared).toHaveBeenLastCalledWith('local', false)
    expect(view.body()).toContain('Serverkopie bleiben erhalten')
    expect(view.body()).not.toContain('Jetzt abgleichen')
  })
})
