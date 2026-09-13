import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createWorkflowBrowser, type WorkflowNativeInvoke } from '@/services/workflows/browser'
import { runWorkflowImage } from '@/services/workflows/image'

// eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed checked-in protocol source, never user input.
const script = readFileSync(new URL('../../src-tauri/src/commands/workflow_browser_script.js', import.meta.url), 'utf8')
type Params = {
  action: string
  expectedUrl: string
  selector?: string
  value?: string
  timeoutMs?: number
  maxChars?: number
  url?: string
  maxBytes?: number
  showCursor?: boolean
}
function page() {
  class Element {
    isConnected = true
    disabled = false
    readOnly = false
    valueText = ''
    clicked = false
    innerText = ''
    options = [{ value: 'one', disabled: false }]
    get value() {
      return this.valueText
    }
    set value(value: string) {
      this.valueText = value
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 20, height: 20 }
    }
    getAttribute() {
      return null
    }
    contains() {
      return false
    }
    dispatchEvent = vi.fn()
    click() {
      this.clicked = true
    }
  }
  class Input extends Element {
    type = 'text'
    override get value() {
      return this.valueText
    }
    override set value(value: string) {
      this.valueText = value
    }
  }
  class Select extends Element {
    override get value() {
      return this.valueText
    }
    override set value(value: string) {
      this.valueText = value
    }
  }
  class Textarea extends Element {
    override get value() {
      return this.valueText
    }
    override set value(value: string) {
      this.valueText = value
    }
  }
  const element = new Input()
  const marker = {
    style: { cssText: '', setProperty: vi.fn() },
    setAttribute: vi.fn(),
    attachShadow: vi.fn(() => ({ innerHTML: '' })),
    remove: vi.fn(),
  }
  const document = {
    readyState: 'complete',
    querySelectorAll: vi.fn(() => [element] as Element[]),
    elementFromPoint: () => element,
    querySelector: vi.fn(() => null as typeof marker | null),
    createElement: vi.fn(() => marker),
    documentElement: { append: vi.fn() },
  }
  const context = {
    location: { href: 'https://example.test/form', origin: 'https://example.test' },
    document,
    innerWidth: 800,
    innerHeight: 600,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    HTMLInputElement: Input,
    HTMLSelectElement: Select,
    HTMLTextAreaElement: Textarea,
    Event: class {
      constructor(readonly type: string) {}
    },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: (time: number) => void) => callback(0),
    fetch: vi.fn(),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
  }
  const execute = vm.runInNewContext(`${script}\nluczorWorkflowBrowser`, context) as (
    params: Params
  ) => Promise<Record<string, unknown>>
  return { execute, context, document, element, Select, marker }
}
const base = { expectedUrl: 'https://example.test/form', selector: '#field', maxChars: 20 }

describe('fixed native browser DOM protocol', () => {
  it('renders a non-intercepting private cursor only after validating the target and never uses native input', async () => {
    const fixture = page()
    fixture.element.disabled = true
    await fixture.execute({ ...base, action: 'click', showCursor: true })
    expect(fixture.document.createElement).not.toHaveBeenCalled()
    fixture.element.disabled = false
    expect(await fixture.execute({ ...base, action: 'click', showCursor: true })).toEqual({ ok: true, clicked: true })
    expect(fixture.marker.style.cssText).toContain('pointer-events:none!important')
    expect(fixture.marker.attachShadow).toHaveBeenCalledWith({ mode: 'closed' })
    expect(fixture.marker.style.setProperty).toHaveBeenCalledWith('left', '10px', 'important')
    expect(fixture.document.documentElement.append).toHaveBeenCalledWith(fixture.marker)
    fixture.document.querySelector.mockReturnValue(fixture.marker)
    await fixture.execute({ ...base, action: 'fill', value: 'test', showCursor: false })
    expect(fixture.marker.remove).toHaveBeenCalledOnce()
  })
  it('refuses a target that moves while the cursor frame is painted', async () => {
    const fixture = page()
    fixture.context.requestAnimationFrame = callback => {
      fixture.element.getBoundingClientRect = () => ({ left: 80, top: 0, width: 20, height: 20 })
      callback(0)
    }
    expect(await fixture.execute({ ...base, action: 'click', showCursor: true })).toMatchObject({
      ok: false,
      code: 'browser_target_not_actionable',
    })
    expect(fixture.element.clicked).toBe(false)
  })
  it('fills through the native setter and treats code-like content as literal data', async () => {
    const fixture = page()
    const value = '"; globalThis.attacked = true; //'
    expect(await fixture.execute({ ...base, action: 'fill', value })).toEqual({ ok: true, applied: true })
    expect(fixture.element.value).toBe(value)
    expect(fixture.element.dispatchEvent).toHaveBeenCalledTimes(2)
    expect(Reflect.get(fixture.context, 'attacked')).toBeUndefined()
  })
  it('refuses ambiguous, disabled, obscured and stale targets', async () => {
    const fixture = page()
    expect(await fixture.execute({ ...base, action: 'click', expectedUrl: 'https://other.test' })).toMatchObject({
      ok: false,
      code: 'browser_url_changed',
    })
    fixture.document.querySelectorAll.mockReturnValueOnce([fixture.element, fixture.element])
    expect(await fixture.execute({ ...base, action: 'click' })).toMatchObject({ ok: false })
    fixture.element.disabled = true
    expect(await fixture.execute({ ...base, action: 'click' })).toMatchObject({ ok: false })
    expect(fixture.element.clicked).toBe(false)
  })
  it('selects only an existing enabled option and returns bounded visible text', async () => {
    const fixture = page()
    const select = new fixture.Select()
    fixture.document.querySelectorAll.mockReturnValue([select])
    expect(await fixture.execute({ ...base, action: 'select', value: 'missing' })).toMatchObject({
      ok: false,
      code: 'browser_option_missing',
    })
    expect(await fixture.execute({ ...base, action: 'select', value: 'one' })).toEqual({ ok: true, applied: true })
    select.innerText = 'x'.repeat(30)
    expect(await fixture.execute({ ...base, action: 'read' })).toEqual({
      ok: true,
      text: 'x'.repeat(20),
      truncated: true,
    })
  })
  it('downloads within the same session origin and cancels oversized responses', async () => {
    const fixture = page()
    expect(
      await fixture.execute({
        ...base,
        action: 'download',
        url: 'https://foreign.test/file',
        timeoutMs: 50,
        maxBytes: 20,
      })
    ).toMatchObject({ ok: false, code: 'browser_download_same_origin_required' })
    expect(fixture.context.fetch).not.toHaveBeenCalled()
    const cancel = vi.fn(async () => undefined)
    fixture.context.fetch.mockResolvedValue({
      ok: true,
      url: 'https://example.test/file',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(30) }), cancel }) },
    })
    expect(
      await fixture.execute({
        ...base,
        action: 'download',
        url: 'https://example.test/file',
        timeoutMs: 100,
        maxBytes: 20,
      })
    ).toMatchObject({ ok: false, code: 'browser_download_size_exceeded' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(fixture.context.fetch).toHaveBeenCalledWith(
      'https://example.test/file',
      expect.objectContaining({ redirect: 'error', credentials: 'same-origin' })
    )
  })
})

describe('workflow session and image IPC contracts', () => {
  const scope = {
    principalId: 'user',
    projectId: 'project',
    expectedRootPath: 'E:\\project',
    expectedWorkspaceUpdatedAt: 4,
    runId: 'run',
  }
  it('reuses a verified session and sends the immutable run identity for every operation', async () => {
    const invokeTask = vi.fn(async () => ({
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: base.expectedUrl,
      data: { text: 'Page', truncated: false },
    }))
    const browser = createWorkflowBrowser({ scope, invokeTask: invokeTask as WorkflowNativeInvoke })
    await browser.open(base.expectedUrl)
    await browser.fill('#field', 'hello')
    await browser.read()
    expect(invokeTask).toHaveBeenNthCalledWith(
      2,
      'wf_browser_action',
      expect.objectContaining({ scope, sessionId: 'session', action: 'fill', value: 'hello' }),
      true
    )
    expect(invokeTask).toHaveBeenNthCalledWith(
      3,
      'wf_browser_action',
      expect.objectContaining({ scope, sessionId: 'session', action: 'read' }),
      false
    )
  })
  it('rejects a mismatched returned session instead of continuing in a different tab', async () => {
    const invokeTask = vi.fn(async () => ({
      ok: true,
      sessionId: 'other',
      tabId: 'tab',
      url: base.expectedUrl,
      data: {},
    }))
    await expect(
      createWorkflowBrowser({ scope, invokeTask: invokeTask as WorkflowNativeInvoke }).click('#field', {
        sessionId: 'reviewed',
      })
    ).rejects.toThrow('session_changed')
  })
  it('copies reviewed host restrictions and cannot expand them through an operation payload', async () => {
    const invokeTask = vi.fn(async () => ({
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: base.expectedUrl,
      data: {},
    }))
    const hosts = ['example.test']
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
      automated: true,
      allowedHosts: hosts,
    })
    hosts.push('foreign.test')
    await browser.open(base.expectedUrl, {
      ...{ allowedHosts: ['foreign.test'], automated: false },
      expectedTabId: 'reviewed-tab',
    })
    expect(invokeTask).toHaveBeenCalledWith(
      'wf_browser_action',
      expect.objectContaining({ allowedHosts: ['example.test'], automated: true, expectedTabId: 'reviewed-tab' }),
      true
    )
  })
  it('uses artifact IDs for OCR and never sends a screenshot to the text-only inference path', async () => {
    const invokeTask = vi.fn(async () => ({ ok: true, text: 'Recognized' }))
    await runWorkflowImage(
      { action: 'ocr', artifactId: 'image', language: 'de-DE' },
      { scope, invokeTask: invokeTask as WorkflowNativeInvoke }
    )
    expect(invokeTask).toHaveBeenCalledWith(
      'wf_image_action',
      { scope, action: 'ocr', artifactId: 'image', language: 'de-DE' },
      false
    )
    await expect(
      runWorkflowImage(
        { action: 'vision', artifactId: 'image' },
        { scope, invokeTask: invokeTask as WorkflowNativeInvoke }
      )
    ).rejects.toThrow('multimodal_runtime_unavailable')
    expect(invokeTask).toHaveBeenCalledTimes(1)
  })
})
