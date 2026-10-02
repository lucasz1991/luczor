import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createWorkflowBrowser, type BrowserOptions, type WorkflowNativeInvoke } from '@/services/workflows/browser'
import { runWorkflowImage } from '@/services/workflows/image'
import { ExecutionGate } from '@/services/executionGate'

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
  operation?: string
  prepared?: boolean
  query?: string
  offset?: number
  limit?: number
}
function page() {
  class Element {
    nodeType = 1
    tagName = 'INPUT'
    children: Element[] = []
    attributes: Record<string, string> = {}
    scrollIntoView = vi.fn()
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
    getAttribute(key: string) {
      return Reflect.get(this.attributes, key) ?? null
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
    title: 'Fixture',
    body: element,
    querySelectorAll: vi.fn(() => [element] as Element[]),
    elementFromPoint: () => element,
    querySelector: vi.fn(() => null as typeof marker | null),
    createElement: vi.fn(() => marker),
    documentElement: { append: vi.fn() },
  }
  const context = {
    location: {
      href: 'https://example.test/form',
      origin: 'https://example.test',
    },
    document,
    crypto: webcrypto,
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
const base = {
  expectedUrl: 'https://example.test/form',
  selector: '#field',
  maxChars: 20,
}

describe('fixed native browser DOM protocol', () => {
  it('renders a non-intercepting private cursor only after validating the target and never uses native input', async () => {
    const fixture = page()
    fixture.element.disabled = true
    await fixture.execute({ ...base, action: 'click', showCursor: true })
    expect(fixture.document.createElement).not.toHaveBeenCalled()
    fixture.element.disabled = false
    expect(await fixture.execute({ ...base, action: 'click', showCursor: true })).toEqual({ ok: true, clicked: true })
    expect(fixture.marker.style.cssText).toContain('pointer-events:none!important')
    expect(fixture.marker.attachShadow).toHaveBeenCalledWith({
      mode: 'closed',
    })
    expect(fixture.marker.style.setProperty).toHaveBeenCalledWith('left', '10px', 'important')
    expect(fixture.document.documentElement.append).toHaveBeenCalledWith(fixture.marker)
    fixture.document.querySelector.mockReturnValue(fixture.marker)
    await fixture.execute({
      ...base,
      action: 'fill',
      value: 'test',
      showCursor: false,
    })
    expect(fixture.marker.remove).toHaveBeenCalledOnce()
  })
  it('refuses a target that moves after the admitted preparation', async () => {
    const fixture = page()
    expect(await fixture.execute({ ...base, action: 'prepare', operation: 'click' })).toMatchObject({ ok: false })
    const prepared = await fixture.execute({
      ...base,
      action: 'prepare',
      operation: 'click',
    })
    expect(prepared).toMatchObject({ ok: true })
    fixture.element.getBoundingClientRect = () => ({
      left: 80,
      top: 0,
      width: 20,
      height: 20,
    })
    expect(
      await fixture.execute({
        ...base,
        action: 'click',
        selector: String(prepared.ref),
        prepared: true,
      })
    ).toMatchObject({ ok: false, code: 'browser_target_not_actionable' })
    expect(fixture.element.clicked).toBe(false)
  })
  it('fills through the native setter and treats code-like content as literal data', async () => {
    const fixture = page()
    const value = '"; globalThis.attacked = true; //'
    expect(await fixture.execute({ ...base, action: 'fill', value })).toEqual({
      ok: true,
      applied: true,
    })
    expect(fixture.element.value).toBe(value)
    expect(fixture.element.dispatchEvent).toHaveBeenCalledTimes(2)
    expect(Reflect.get(fixture.context, 'attacked')).toBeUndefined()
  })
  it('refuses ambiguous, disabled, obscured and stale targets', async () => {
    const fixture = page()
    expect(
      await fixture.execute({
        ...base,
        action: 'click',
        expectedUrl: 'https://other.test',
      })
    ).toMatchObject({
      ok: false,
      code: 'browser_url_changed',
    })
    fixture.document.querySelectorAll.mockReturnValueOnce([fixture.element, fixture.element])
    expect(await fixture.execute({ ...base, action: 'click' })).toMatchObject({
      ok: false,
    })
    fixture.element.disabled = true
    expect(await fixture.execute({ ...base, action: 'click' })).toMatchObject({
      ok: false,
    })
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
    select.innerText = 'first full line\n' + 'x'.repeat(30)
    expect(await fixture.execute({ ...base, action: 'read' })).toMatchObject({
      ok: true,
      text: 'first full line\n',
      truncated: true,
      offset: 0,
      nextOffset: 16,
      title: 'Fixture',
    })
  })
  it('reads long unbroken text without gaps and changes its full-document snapshot when text changes', async () => {
    const fixture = page()
    fixture.element.innerText = 'x'.repeat(55)
    const first = await fixture.execute({ ...base, action: 'read' })
    const second = await fixture.execute({
      ...base,
      action: 'read',
      offset: Number(first.nextOffset),
    })
    const third = await fixture.execute({
      ...base,
      action: 'read',
      offset: Number(second.nextOffset),
    })
    expect(String(first.text) + String(second.text) + String(third.text)).toBe(fixture.element.innerText)
    expect(first.snapshotId).toBe(second.snapshotId)
    expect(third).toMatchObject({
      nextOffset: null,
      truncated: false,
      totalChars: 55,
    })
    fixture.element.innerText = 'y' + 'x'.repeat(54)
    expect((await fixture.execute({ ...base, action: 'read' })).snapshotId).not.toBe(first.snapshotId)
  })
  it('never splits an astral character between JSON source chunks', async () => {
    const fixture = page()
    fixture.element.innerText = 'x'.repeat(19) + '😀y'
    const first = await fixture.execute({ ...base, action: 'read' })
    expect(first).toMatchObject({ text: 'x'.repeat(19), nextOffset: 19 })
    const second = await fixture.execute({
      ...base,
      action: 'read',
      offset: 19,
      maxChars: 1,
    })
    expect(second).toMatchObject({ text: '😀', nextOffset: 21 })
  })
  it('keeps download execution out of page JavaScript', async () => {
    const fixture = page()
    expect(
      await fixture.execute({
        ...base,
        action: 'download',
        url: 'https://foreign.test/file',
      })
    ).toMatchObject({
      ok: false,
      code: 'browser_action_unknown',
    })
    expect(fixture.context.fetch).not.toHaveBeenCalled()
  })
  it('scans semantic refs without exposing form values and rejects changed or replaced targets', async () => {
    const fixture = page()
    fixture.element.value = 'private form value'
    fixture.element.attributes['aria-label'] = 'Email'
    const scan = await fixture.execute({
      expectedUrl: base.expectedUrl,
      action: 'scan',
    })
    const elements = scan.elements as Array<{ ref: string; name: string }>
    expect(elements).toHaveLength(1)
    expect(elements[0]).toMatchObject({ role: 'textbox', name: 'Email' })
    expect(JSON.stringify(scan)).not.toContain('private form value')
    expect(
      await fixture.execute({
        ...base,
        action: 'fill',
        selector: elements[0]!.ref,
        value: 'hello',
      })
    ).toMatchObject({ ok: true })
    fixture.element.attributes['aria-label'] = 'Different field'
    expect(
      await fixture.execute({
        ...base,
        action: 'fill',
        selector: elements[0]!.ref,
        value: 'wrong',
      })
    ).toMatchObject({ ok: false, code: 'browser_ref_stale' })
    expect(fixture.element.value).toBe('hello')
    expect(
      await fixture.execute({
        ...base,
        action: 'fill',
        selector: 'ref:invented',
        value: 'wrong',
      })
    ).toMatchObject({
      ok: false,
      code: 'browser_ref_stale',
    })
  })
  it('finds a unique label and never chooses an arbitrary ambiguous target', async () => {
    const fixture = page()
    fixture.element.attributes['aria-label'] = 'Email'
    expect(
      await fixture.execute({
        ...base,
        action: 'fill',
        selector: 'label=Email',
        value: 'hello',
      })
    ).toMatchObject({
      ok: true,
    })
    fixture.document.querySelectorAll.mockReturnValue([fixture.element, fixture.element])
    expect(await fixture.execute({ ...base, action: 'click' })).toMatchObject({
      ok: false,
      code: 'browser_target_ambiguous',
    })
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
  function performObservedAction(
    browser: ReturnType<typeof createWorkflowBrowser>,
    action: 'open' | 'navigate' | 'click' | 'fill' | 'select',
    options: BrowserOptions = {}
  ) {
    switch (action) {
      case 'open':
        return browser.open(base.expectedUrl, options)
      case 'navigate':
        return browser.navigate(base.expectedUrl, options)
      case 'click':
        return browser.click('ref:before', options)
      case 'fill':
        return browser.fill('ref:before', 'input value', options)
      case 'select':
        return browser.select('ref:before', 'input value', options)
    }
  }
  it('learns an admitted first-open identity only from a successful own-scope observation', async () => {
    const failure = {
      version: 1,
      code: 'workflow_browser_navigation_timeout',
      operation: 'open',
      phase: 'readiness',
      outcome: 'unknown',
      sessionId: 'untrusted-error-session',
    }
    const invokeTask = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({
      ok: true,
      sessionId: 'trusted-session',
      tabId: 'tab',
      url: 'about:blank',
      data: {},
    })
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    expect(browser.hasNativeSession()).toBe(false)
    expect(browser.hasAttemptedOpen()).toBe(false)
    await expect(browser.open()).rejects.toBe(failure)
    expect(browser.hasNativeSession()).toBe(false)
    expect(browser.hasAttemptedOpen()).toBe(true)
    await browser.scan()
    expect(invokeTask).toHaveBeenNthCalledWith(
      2,
      'wf_browser_action',
      expect.objectContaining({ scope, action: 'scan', sessionId: undefined }),
      false
    )
    expect(browser.hasNativeSession()).toBe(true)
    await browser.scan()
    expect(invokeTask).toHaveBeenNthCalledWith(
      3,
      'wf_browser_action',
      expect.objectContaining({
        scope,
        action: 'scan',
        sessionId: 'trusted-session',
      }),
      false
    )
    expect(invokeTask.mock.calls.map(([, payload]) => payload.action)).toEqual(['open', 'scan', 'scan'])
    await browser.close()
    expect(browser.hasNativeSession()).toBe(false)
  })
  it('reuses a verified session and sends the immutable run identity for every operation', async () => {
    const invokeTask = vi.fn(async () => ({
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: base.expectedUrl,
      data: { text: 'Page', truncated: false },
    }))
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    await browser.open(base.expectedUrl)
    await browser.fill('#field', 'hello')
    await browser.read()
    expect(invokeTask).toHaveBeenNthCalledWith(
      3,
      'wf_browser_action',
      expect.objectContaining({
        scope,
        sessionId: 'session',
        action: 'fill',
        value: 'hello',
      }),
      true
    )
    expect(invokeTask).toHaveBeenNthCalledWith(
      5,
      'wf_browser_action',
      expect.objectContaining({ scope, sessionId: 'session', action: 'read' }),
      false
    )
  })
  it.each(['open', 'navigate', 'click', 'fill', 'select'] as const)(
    'attaches one bounded read after %s without replacing its receipt or forwarding action inputs',
    async action => {
      const confirmed = {
        ok: true,
        sessionId: 'session',
        tabId: 'tab',
        url: base.expectedUrl,
        data: { performed: action, result: 'original' },
      }
      const observed = {
        ...confirmed,
        url: 'https://example.test/next',
        data: {
          version: 1,
          documentUrl: 'https://example.test/next',
          elements: [{ ref: 'ref:current', role: 'button', name: 'Next' }],
          offset: 0,
          nextOffset: null,
        },
      }
      const invokeTask = vi.fn().mockResolvedValueOnce(confirmed).mockResolvedValueOnce(observed)
      const browser = createWorkflowBrowser({
        scope,
        invokeTask: invokeTask as WorkflowNativeInvoke,
        automated: true,
      })
      const options = {
        expectedUrl: base.expectedUrl,
        expectedTabId: 'tab',
        timeoutMs: 20000,
      }
      const result = await performObservedAction(browser, action, options)
      expect(result).toEqual({
        ...confirmed,
        observation: { ...observed, status: 'ok' },
      })
      expect(result.data).toBe(confirmed.data)
      expect(invokeTask.mock.calls.map(([, payload, mutating]) => [payload.action, mutating])).toEqual([
        [action, true],
        ['scan', false],
      ])
      expect(invokeTask.mock.calls[1]![1]).toEqual({
        scope,
        sessionId: 'session',
        expectedTabId: 'tab',
        action: 'scan',
        limit: 40,
        timeoutMs: 3000,
        allowedHosts: undefined,
        automated: true,
      })
    }
  )
  it.each(['open', 'navigate', 'click', 'fill', 'select'] as const)(
    'preserves the original %s failure without observing or repeating the action',
    async action => {
      const error = new Error('workflow_browser_action_failed_outcome_unknown')
      const invokeTask = vi.fn().mockRejectedValue(error)
      const browser = createWorkflowBrowser({
        scope,
        invokeTask: invokeTask as WorkflowNativeInvoke,
      })
      const result = performObservedAction(browser, action)
      await expect(result).rejects.toBe(error)
      expect(invokeTask).toHaveBeenCalledOnce()
    }
  )
  it.each([
    {
      version: 1,
      operation: 'scan',
      phase: 'operation',
      backend: 'webview2',
      elapsedMs: 3000,
      outcome: 'unknown',
      code: 'workflow_browser_timeout_outcome_unknown',
      privateData: 'PRIVATE',
    },
    new Error('PRIVATE page contents'),
    'workflow_browser_session_unavailable',
  ])('keeps action success when its read fails without leaking raw error content: %j', async error => {
    const confirmed = {
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: base.expectedUrl,
      data: { clicked: true },
    }
    const invokeTask = vi.fn().mockResolvedValueOnce(confirmed).mockRejectedValueOnce(error)
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    const result = await browser.click('ref:before')
    expect(result).toMatchObject({
      ...confirmed,
      observation: {
        status: 'unavailable',
        next_tool: 'browser_dom_scan',
        guidance: expect.stringContaining('The action completed'),
      },
    })
    expect(result).not.toHaveProperty('browserFailure')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(invokeTask.mock.calls.map(([, payload]) => payload.action)).toEqual(['click', 'scan'])
    expect(browser.hasNativeSession()).toBe(true)
  })
  it.each([
    { sessionId: 'other', data: { version: 1, elements: [], offset: 0 } },
    { sessionId: 'session', data: { text: 'invalid scan' } },
    { tabId: 'other-tab', data: { version: 1, elements: [], offset: 0 } },
    { url: undefined, data: { version: 1, elements: [], offset: 0 } },
  ])('keeps the completed action and verified identity when a scan reply is invalid: %j', async invalid => {
    const confirmed = {
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: base.expectedUrl,
      data: { filled: true },
    }
    const invokeTask = vi
      .fn()
      .mockResolvedValueOnce(confirmed)
      .mockResolvedValueOnce({ ...confirmed, ...invalid })
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    await expect(browser.fill('ref:before', 'value')).resolves.toMatchObject({
      ...confirmed,
      observation: { status: 'unavailable' },
    })
    invokeTask.mockResolvedValueOnce(confirmed)
    await browser.scan()
    expect(invokeTask.mock.calls[2]![1].sessionId).toBe('session')
  })
  it('explains an empty blank page and navigates toward the task instead of a screenshot loop', async () => {
    const blank = {
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: 'about:blank',
      data: {
        version: 1,
        elements: [],
        offset: 0,
        nextOffset: null,
        documentUrl: 'about:blank',
      },
    }
    const invokeTask = vi.fn().mockResolvedValue(blank)
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    await expect(browser.open()).resolves.toMatchObject({
      observation: {
        status: 'ok',
        guidance: expect.stringContaining('use browser_navigate'),
      },
    })
    expect(invokeTask.mock.calls.map(([, payload]) => payload.action)).toEqual(['open', 'scan'])
  })
  it('keeps browser and error-document URLs separate and explains limited control', async () => {
    const receipt = {
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: 'file:///missing.html',
      data: { opened: true },
    }
    const data = {
      version: 1,
      elements: [{ role: 'heading', name: 'File not found' }],
      offset: 0,
      documentUrl: 'chrome-error://chromewebdata/',
      browserUrl: receipt.url,
      documentUrlMatchesBrowser: false,
      observationOnly: true,
    }
    const invokeTask = vi
      .fn()
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce({ ...receipt, data })
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    await expect(browser.open(receipt.url)).resolves.toEqual({
      ...receipt,
      observation: {
        ...receipt,
        data,
        status: 'ok',
        guidance: expect.stringContaining('not a normal loaded target page'),
      },
    })
  })
  it('does not add scans to explicit observation, downloads or close', async () => {
    const invokeTask = vi.fn().mockResolvedValue({
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: base.expectedUrl,
      data: { text: 'Page', truncated: false },
    })
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    await browser.scan()
    await browser.read()
    await browser.wait()
    await browser.screenshot()
    await browser.download(base.expectedUrl)
    await browser.close()
    expect(invokeTask.mock.calls.map(([, payload]) => payload.action)).toEqual([
      'scan',
      'read',
      'wait',
      'screenshot',
      'download',
      'close',
    ])
  })
  it('keeps a confirmed action when authority is revoked before its read, without invoking that read', async () => {
    const gate = new ExecutionGate()
    gate.update({ mode: 'act', killSwitch: false, scope: 'project' })
    const ticket = gate.capture()
    const confirmed = {
      ok: true,
      sessionId: 'session',
      tabId: 'tab',
      url: base.expectedUrl,
      data: { selected: true },
    }
    const native = vi.fn().mockResolvedValue(confirmed)
    const invokeTask = vi.fn(async (command: string, payload: Record<string, unknown>, mutating = true) => {
      if (payload.action === 'scan') gate.invalidate()
      gate.assert(ticket, mutating)
      return native(command, payload)
    })
    const browser = createWorkflowBrowser({
      scope,
      invokeTask: invokeTask as WorkflowNativeInvoke,
    })
    await expect(browser.select('ref:observed', 'option')).resolves.toMatchObject({
      ...confirmed,
      observation: {
        status: 'unavailable',
        guidance: expect.stringContaining('when access remains permitted'),
      },
    })
    expect(native).toHaveBeenCalledOnce()
    expect(invokeTask.mock.calls.map(([, payload, mutating]) => [payload.action, mutating])).toEqual([
      ['select', true],
      ['scan', false],
    ])
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
      createWorkflowBrowser({
        scope,
        invokeTask: invokeTask as WorkflowNativeInvoke,
      }).click('#field', {
        sessionId: 'reviewed',
      })
    ).rejects.toThrow('session_changed')
  })
  it('removes obsolete host restrictions but retains native session identity', async () => {
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
      expect.objectContaining({
        allowedHosts: undefined,
        automated: true,
        expectedTabId: 'reviewed-tab',
      }),
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
