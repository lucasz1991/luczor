import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, createSSRApp, h, nextTick, shallowReactive, type Component } from 'vue'
import * as VueRuntime from 'vue'
import { renderToString } from 'vue/server-renderer'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import ResearchRunCard from '@/components/ai/ResearchRunCard.vue'
import source from '@/components/ai/ResearchRunCard.vue?raw'
import type { ResearchRun } from '@/services/research/types'
import { researchEvidenceFingerprint } from '@/services/research/evidence'

const base: ResearchRun = {
  id: 'r',
  principalId: 'p',
  projectId: 'project',
  conversationId: 'chat',
  topic: 'Aktuelle Quellen',
  depth: 'deep',
  stage: 'collecting',
  status: 'running',
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
  asOf: '2026-09-23',
  outputDir: 'C:\\Research\\Quellen',
  questions: [],
  sources: [],
  claims: [],
  artifacts: [],
  blockers: [],
}
const descriptor = parse(source, { filename: 'ResearchRunCard.vue' }).descriptor
const compiled = compileScript(descriptor, {
  id: 'research-card-test',
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
      if (id === '@/services/research/evidence') return { researchEvidenceFingerprint }
      throw new Error(`Unexpected import ${id}`)
    },
  }
)
const Card = compiledModule.exports.default as Component
class Node {
  children: Node[] = []
  parent: Node | null = null
  props = new Map<string, unknown>()
  text = ''
  constructor(readonly tag: string) {}
}
const renderer = createRenderer<Node, Node>({
  patchProp: (node, key, _previous, next) => {
    node.props.set(key, next)
  },
  insert: (node, parent, anchor) => {
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove: node => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
  },
  createElement: tag => new Node(tag),
  createText: text => Object.assign(new Node('#text'), { text }),
  createComment: () => new Node('#comment'),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
    node.children = []
  },
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  setScopeId: () => {},
  insertStaticContent: (text, parent) => {
    const node = Object.assign(new Node('#static'), { text, parent })
    parent.children.push(node)
    return [node, node]
  },
})
const descendants = (node: Node): Node[] => node.children.flatMap(child => [child, ...descendants(child)])
const text = (node: Node): string => [node.text, ...node.children.map(text)].join('')

describe('research progress and user controls', () => {
  it('keeps pause and stop reachable during active work and resumes only a paused/blocked run', async () => {
    const props = shallowReactive({ run: structuredClone(base) })
    const pause = vi.fn(),
      resume = vi.fn(),
      stop = vi.fn(),
      openFolder = vi.fn(),
      openReport = vi.fn()
    const root = new Node('root')
    const app = renderer.createApp({
      render: () =>
        h(Card, {
          ...props,
          onPause: pause,
          onResume: resume,
          onStop: stop,
          'onOpen-folder': openFolder,
          'onOpen-report': openReport,
        }),
    })
    app.mount(root)
    const click = (label: string) => {
      const button = descendants(root).find(node => node.tag === 'button' && text(node).trim() === label)
      const handler = button?.props.get('onClick')
      if (typeof handler !== 'function') throw new Error(`Missing ${label}`)
      handler()
    }
    click('Pausieren')
    click('Stoppen')
    click('Ordner öffnen')
    expect(pause).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(openFolder).toHaveBeenCalledOnce()
    props.run = { ...props.run, status: 'paused' }
    await nextTick()
    click('Fortsetzen')
    expect(resume).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenLastCalledWith('')
    const input = descendants(root)
      .find(node => node.tag === 'textarea')
      ?.props.get('onInput')
    if (typeof input !== 'function') throw new Error('Missing clarification input')
    input({ target: { value: '  Deutschland, September 2026  ' } })
    await nextTick()
    click('Fortsetzen')
    expect(resume).toHaveBeenLastCalledWith('Deutschland, September 2026')
    props.run = { ...props.run, clarifications: ['Deutschland, September 2026'] }
    await nextTick()
    expect(
      descendants(root)
        .find(node => node.tag === 'textarea')
        ?.props.get('value')
    ).toBe('')
    expect(descendants(root).some(node => node.tag === 'button' && text(node) === 'Pausieren')).toBe(false)
    props.run = {
      ...props.run,
      status: 'completed',
      report: { htmlPath: 'report.html', markdownPath: 'report.md', verifiedAt: 3 },
    }
    await nextTick()
    click('Bericht öffnen')
    expect(openReport).toHaveBeenCalledOnce()
    expect(
      descendants(root).some(node => node.tag === 'button' && ['Stoppen', 'Fortsetzen'].includes(text(node)))
    ).toBe(false)
    app.unmount()
  })

  it('renders status and source/file gaps as escaped text with accessible native disclosure', async () => {
    const run: ResearchRun = {
      ...structuredClone(base),
      topic: '<script>topic</script>',
      status: 'blocked',
      stage: 'reviewing',
      blockers: ['<img src=x onerror=bad> Kernfrage unbelegt'],
      report: { htmlPath: 'report.html', markdownPath: 'report.md' },
      sources: [
        {
          id: 's',
          title: 'Offizieller Stand',
          url: 'https://example.com',
          capturedAt: 2,
          contentHash: 'hash',
          readReceiptId: 'receipt',
          kind: 'web',
          coverage: 'partial',
          segments: [],
        },
      ],
      artifacts: [{ id: 'a', path: 'downloads/Beleg.pdf', kind: 'download', contentHash: 'hash', verifiedAt: 2 }],
    }
    const html = await renderToString(createSSRApp({ render: () => h(ResearchRunCard, { run }) }))
    expect(html).toContain('Zwischenstand · Klärung nötig')
    expect(html).toContain('Aussagen und Aktualität prüfen')
    expect(html).toContain('1 Quellen')
    expect(html).toContain('downloads/Beleg.pdf · geprüft')
    expect(html).toContain('Zwischenbericht öffnen')
    expect(html).toContain('<details')
    expect(html).toContain('role="status"')
    expect(html).toContain('Ergänzung zur Recherche')
    expect(html).toContain('maxlength="20000"')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('distinguishes stopped from completed and does not claim restart after cancellation', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(ResearchRunCard, { run: { ...base, status: 'cancelled' } }) })
    )
    expect(html).toContain('Gestoppt')
    expect(html).not.toContain('>Fortsetzen<')
    expect(html).not.toContain('>Abgeschlossen<')
  })
})
