import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed native protocol source.
const script = readFileSync(new URL('../../src-tauri/src/commands/workflow_browser_script.js', import.meta.url), 'utf8')

function page(documentUrl = 'chrome-error://chromewebdata/') {
  const body = {
    nodeType: 1,
    tagName: 'BODY',
    children: [] as object[],
    isConnected: true,
    innerText: 'Synthetic navigation failure',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    getAttribute: () => null,
    closest: () => null,
  }
  const document = {
    title: 'Synthetic error document',
    readyState: 'complete',
    body,
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => [] as object[]),
  }
  const context = {
    location: { href: documentUrl },
    document,
    crypto: webcrypto,
    URL,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }
  const execute = vm.runInNewContext(`${script}\nluczorWorkflowBrowser`, context) as (
    params: Record<string, unknown>
  ) => Promise<Record<string, unknown>>
  return { execute, document, body }
}

const target = 'https://example.test/unreachable'

describe('native current-document observation', () => {
  it.each(['scan', 'read'])('observes an owned error document with %s and distinguishes its address', async action => {
    const fixture = page()
    const result = await fixture.execute({ action, expectedUrl: target, observeCurrentDocument: true })
    expect(result).toMatchObject({
      ok: true,
      url: 'chrome-error://chromewebdata/',
      documentUrl: 'chrome-error://chromewebdata/',
      browserUrl: target,
      documentUrlMatchesBrowser: false,
      observationOnly: true,
    })
    expect(result).toMatchObject(action === 'read' ? { text: 'Synthetic navigation failure' } : { elements: [] })
  })

  it('describes error document controls without issuing action refs', async () => {
    const fixture = page()
    fixture.body.children.push({ ...fixture.body, tagName: 'BUTTON', innerText: 'Synthetic retry', children: [] })
    const result = await fixture.execute({ action: 'scan', expectedUrl: target, observeCurrentDocument: true })
    expect(result).toMatchObject({ observationOnly: true, elements: [{ role: 'button', name: 'Synthetic retry' }] })
    expect((result.elements as Record<string, unknown>[])[0]).not.toHaveProperty('ref')
    expect((result.elements as Record<string, unknown>[])[0]).not.toHaveProperty('selector')
  })

  it('offers a short unique semantic selector that round-trips escaped names', async () => {
    const fixture = page(target)
    const name = 'Save "a\\b"'
    fixture.body.children.push({ ...fixture.body, tagName: 'BUTTON', innerText: name, children: [] })
    const result = await fixture.execute({ action: 'scan', expectedUrl: target })
    const element = (result.elements as Record<string, unknown>[])[0]
    if (!element) throw new Error('Expected the synthetic button in the DOM scan')
    expect(element.selector).toBe(`role=button[name=${JSON.stringify(name)}]`)
    expect(element.ref).toMatch(/^ref:/u)
    expect(await fixture.execute({ action: 'read', expectedUrl: target, selector: element.selector })).toMatchObject({
      ok: true,
      text: name,
    })
  })

  it('counts duplicate role/name pairs before query filtering and pagination', async () => {
    const fixture = page(target)
    for (const id of ['selected-id', 'other-id'])
      fixture.body.children.push({
        ...fixture.body,
        tagName: 'BUTTON',
        innerText: 'Duplicate',
        children: [],
        getAttribute: (key: string) => (key === 'id' ? id : null),
      })
    const result = await fixture.execute({ action: 'scan', expectedUrl: target, query: 'selected-id', limit: 1 })
    const elements = result.elements as Record<string, unknown>[]
    expect(elements).toHaveLength(1)
    expect(elements[0]).not.toHaveProperty('selector')
  })

  it('does not infer global uniqueness from a selector-scoped scan', async () => {
    const fixture = page(target)
    const region = {
      ...fixture.body,
      children: [{ ...fixture.body, tagName: 'BUTTON', innerText: 'Local button', children: [] }],
    }
    fixture.document.querySelectorAll.mockReturnValue([region])
    const result = await fixture.execute({ action: 'scan', expectedUrl: target, selector: '#region' })
    const elements = result.elements as Record<string, unknown>[]
    expect(elements).toHaveLength(1)
    expect(elements[0]).not.toHaveProperty('selector')
  })

  it('does not claim uniqueness when the bounded page walk omits a possible duplicate', async () => {
    const fixture = page(target)
    const button = { ...fixture.body, tagName: 'BUTTON', innerText: 'May be duplicated', children: [] }
    fixture.body.children = [
      button,
      ...Array.from({ length: 19_999 }, () => ({ ...fixture.body, tagName: 'DIV', children: [] })),
      { ...button },
    ]
    const result = await fixture.execute({ action: 'scan', expectedUrl: target })
    expect(result.limitations).toContain('scan_visit_limit_use_selector_or_query')
    expect((result.elements as Record<string, unknown>[])[0]).not.toHaveProperty('selector')
  })

  it.each(['scan', 'read'])('keeps an explicitly source-bound %s strict', async action => {
    const fixture = page()
    expect(await fixture.execute({ action, expectedUrl: target })).toEqual({ ok: false, code: 'browser_url_changed' })
  })

  it.each(['prepare', 'click', 'fill', 'select', 'wait'])(
    'never uses the observation flag to admit %s on another document',
    async action => {
      const fixture = page()
      expect(
        await fixture.execute({ action, operation: 'click', expectedUrl: target, observeCurrentDocument: true })
      ).toEqual({ ok: false, code: 'browser_url_changed' })
      expect(fixture.document.querySelectorAll).not.toHaveBeenCalled()
    }
  )

  it('does not coerce an untrusted flag or decode percent escapes into an address match', async () => {
    const fixture = page('file:///E:/synthetic/literal%2520name.html')
    expect(
      await fixture.execute({
        action: 'read',
        expectedUrl: 'file:///E:/synthetic/literal%20name.html',
        observeCurrentDocument: 'true',
      })
    ).toEqual({ ok: false, code: 'browser_url_changed' })
  })

  it('retains ordinary same-address read behavior', async () => {
    const fixture = page(target)
    expect(await fixture.execute({ action: 'read', expectedUrl: target })).toMatchObject({
      ok: true,
      documentUrl: target,
      browserUrl: target,
      documentUrlMatchesBrowser: true,
      observationOnly: false,
      text: 'Synthetic navigation failure',
    })
  })
})
