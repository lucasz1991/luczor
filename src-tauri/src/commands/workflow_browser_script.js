// Fixed native-owned code in an isolated WebView2/WebKitGTK world. Arguments are data.
async function luczorWorkflowBrowser(p) {
  const fail = code => ({ ok: false, code })
  if (location.href !== p.expectedUrl) return fail('browser_url_changed')
  const normalize = text =>
    String(text || '')
      .replace(/\s+/gu, ' ')
      .trim()
  const attr = (el, key) => el.getAttribute?.(key) || ''
  const tag = el => String(el.tagName || '').toLowerCase()
  const doc = el => el.ownerDocument || document
  const view = el => doc(el).defaultView || globalThis
  const visible = el => {
    if (!el || el.isConnected === false || el.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false
    const r = el.getBoundingClientRect(),
      s = view(el).getComputedStyle(el)
    return (
      r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.visibility !== 'collapse' && s.display !== 'none'
    )
  }
  const disabled = el => el.disabled || el.matches?.(':disabled') || el.closest?.('[aria-disabled="true"],[inert]')
  const role = el =>
    attr(el, 'role').split(' ')[0] ||
    {
      button: 'button',
      a: attr(el, 'href') ? 'link' : '',
      select: 'combobox',
      textarea: 'textbox',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      summary: 'button',
      iframe: 'frame',
      canvas: 'canvas',
      img: 'img',
    }[tag(el)] ||
    (tag(el) === 'input'
      ? {
          checkbox: 'checkbox',
          radio: 'radio',
          range: 'slider',
          number: 'spinbutton',
          button: 'button',
          submit: 'button',
        }[el.type] || 'textbox'
      : el.isContentEditable
        ? 'textbox'
        : '')
  const name = el => {
    const root = el.getRootNode?.() || doc(el)
    const labelled = attr(el, 'aria-labelledby')
      .split(/\s+/u)
      .filter(Boolean)
      .map(id => root.getElementById?.(id)?.textContent || '')
      .join(' ')
    return normalize(
      labelled ||
        attr(el, 'aria-label') ||
        Array.from(el.labels || [])
          .map(label => label.textContent)
          .join(' ') ||
        attr(el, 'alt') ||
        attr(el, 'title') ||
        attr(el, 'placeholder') ||
        (['button', 'link', 'heading', 'option'].includes(role(el)) ? el.innerText || el.textContent : '')
    )
  }
  const fingerprint = el => JSON.stringify([tag(el), role(el), name(el), attr(el, 'href'), attr(el, 'type')])
  const state = () => {
    if (!globalThis.__luczorDomV1 || globalThis.__luczorDomV1.document !== document) {
      const random = new Uint32Array(3)
      crypto.getRandomValues(random)
      globalThis.__luczorDomV1 = {
        document,
        nonce: Array.from(random, n => n.toString(36)).join(''),
        sequence: 0,
        refs: new Map(),
        elements: new WeakMap(),
        prepared: null,
      }
    }
    return globalThis.__luczorDomV1
  }
  const observe = el => {
    const s = state(),
      print = fingerprint(el),
      previous = s.elements.get(el)
    if (previous && s.refs.get(previous)?.fingerprint === print) return previous
    const ref = `ref:${s.nonce}_${++s.sequence}`
    s.refs.set(ref, { el, fingerprint: print, url: location.href, document: doc(el) })
    s.elements.set(el, ref)
    while (s.refs.size > 2000) s.refs.delete(s.refs.keys().next().value)
    return ref
  }
  const fromRef = ref => {
    const entry = state().refs.get(ref)
    if (
      !entry ||
      !entry.el.isConnected ||
      entry.url !== location.href ||
      doc(entry.el) !== entry.document ||
      (entry.document.defaultView && entry.document.defaultView.document !== entry.document) ||
      fingerprint(entry.el) !== entry.fingerprint
    )
      throw new Error('browser_ref_stale')
    return entry.el
  }
  // Bounded walk through open shadow roots and same-origin frames, preserving exact refs.
  const walk = root => {
    const nodes = [],
      frames = [],
      stack = [root]
    let visited = 0
    while (stack.length && visited < 20000) {
      const el = stack.pop()
      if (!el || tag(el) === 'luczor-browser-pointer') continue
      visited++
      if (el.nodeType === 1) nodes.push(el)
      const children = Array.from(el.children || [])
      if (el.shadowRoot) children.push(...Array.from(el.shadowRoot.children || []))
      if (tag(el) === 'iframe' || tag(el) === 'frame') {
        try {
          if (el.contentDocument?.body) children.push(el.contentDocument.body)
          else if (frames.length < 40)
            frames.push({ name: name(el), status: 'dom_unavailable', reason: 'cross_origin_or_not_loaded' })
        } catch {
          if (frames.length < 40) frames.push({ name: name(el), status: 'dom_unavailable', reason: 'cross_origin' })
        }
      }
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
    }
    return { nodes, frames, traversalLimited: stack.length > 0, visited }
  }
  const resolve = selector => {
    if (selector?.startsWith('ref:')) return fromRef(selector)
    if (!selector) return document.body
    const semantic = /^(role|label|text)=([\s\S]+)$/u.exec(selector)
    if (!semantic) {
      const nodes = document.querySelectorAll(selector)
      if (nodes.length > 1) throw new Error('browser_target_ambiguous')
      return nodes[0] || null
    }
    const { nodes } = walk(document.body),
      type = semantic[1],
      value = semantic[2]
    let matches
    if (type === 'role') {
      const parsed = /^([a-z]+)(?:\[name=("(?:[^"\\]|\\.)*")\])?$/u.exec(value)
      if (!parsed) throw new Error('browser_selector_invalid')
      const expected = parsed[2] ? JSON.parse(parsed[2]) : undefined
      matches = nodes.filter(
        el => visible(el) && role(el) === parsed[1] && (expected === undefined || name(el) === expected)
      )
    } else if (type === 'label') {
      matches = nodes.filter(
        el => visible(el) && ['input', 'select', 'textarea'].includes(tag(el)) && name(el) === normalize(value)
      )
    } else {
      matches = nodes.filter(el => visible(el) && normalize(el.innerText || el.textContent) === normalize(value))
      matches = matches.filter(el => !matches.some(child => child !== el && el.contains(child)))
    }
    if (matches.length > 1) throw new Error('browser_target_ambiguous')
    return matches[0] || null
  }
  const locate = () => resolve(p.selector)
  const hitTarget = el => {
    const r = el.getBoundingClientRect(),
      w = view(el),
      d = doc(el)
    const x = Math.max(0, r.left) + (Math.min(w.innerWidth, r.left + r.width) - Math.max(0, r.left)) / 2
    const y = Math.max(0, r.top) + (Math.min(w.innerHeight, r.top + r.height) - Math.max(0, r.top)) / 2
    let hit = d.elementFromPoint(x, y)
    while (hit?.shadowRoot) {
      const next = hit.shadowRoot.elementFromPoint?.(x, y)
      if (!next || next === hit) break
      hit = next
    }
    if (x < 0 || y < 0 || x >= w.innerWidth || y >= w.innerHeight || !hit || (hit !== el && !el.contains(hit)))
      return false
    const frame = w.frameElement
    return !frame || hitTarget(frame)
  }
  const markPointer = el => {
    const d = doc(el),
      w = view(el)
    if (p.showCursor !== true) {
      d.querySelector?.('luczor-browser-pointer')?.remove()
      return
    }
    let host = d.querySelector('luczor-browser-pointer')
    if (!host) {
      host = d.createElement('luczor-browser-pointer')
      host.setAttribute('aria-hidden', 'true')
      host.style.cssText =
        'all:initial!important;position:fixed!important;z-index:2147483647!important;pointer-events:none!important;width:26px!important;height:34px!important;display:block!important'
      host.attachShadow({ mode: 'closed' }).innerHTML =
        '<style>:host{pointer-events:none}svg{filter:drop-shadow(0 1px 2px #0008)}span:after{content:"Luczor";font:11px system-ui;color:white;background:#1764c5;border-radius:4px;padding:2px 5px;position:absolute;left:19px;top:24px}</style><svg width="25" height="32" viewBox="0 0 25 32"><path d="M2 2L2 25L8 20L13 30L18 27L13 18L23 18Z" fill="#398cff" stroke="white" stroke-width="2"/></svg><span></span>'
      d.documentElement.append(host)
    }
    const r = el.getBoundingClientRect()
    host.style.setProperty('left', `${Math.max(0, Math.min(w.innerWidth - 26, r.left + r.width / 2))}px`, 'important')
    host.style.setProperty('top', `${Math.max(0, Math.min(w.innerHeight - 34, r.top + r.height / 2))}px`, 'important')
  }
  try {
    if (p.action === 'wait') {
      const deadline = Date.now() + p.timeoutMs
      do {
        if (location.href !== p.expectedUrl) return fail('browser_url_changed')
        if (document.readyState !== 'loading' && (!p.selector || visible(locate()))) return { ok: true, ready: true }
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      return fail('browser_wait_timeout')
    }
    if (document.readyState === 'loading') return fail('browser_page_not_ready')
    const el = locate()
    if (!el) return fail('browser_target_missing_or_ambiguous')
    if (p.action === 'scan') {
      const found = walk(el),
        query = normalize(p.query).toLocaleLowerCase(),
        offset = p.offset || 0,
        limit = p.limit || 80
      const matches = found.nodes.filter(node => {
        if (!visible(node)) return false
        const r = role(node)
        if (!r && !node.hasAttribute?.('tabindex') && !node.isContentEditable) return false
        return (
          !query ||
          `${r} ${name(node)} ${attr(node, 'id')} ${attr(node, 'placeholder')}`.toLocaleLowerCase().includes(query)
        )
      })
      let responseBytes = 0
      const candidates = matches.slice(offset, offset + limit).map(node => {
        const result = {
          ref: observe(node),
          role: role(node) || 'element',
          name: name(node),
          tag: tag(node),
          disabled: !!disabled(node),
          editable:
            !node.readOnly &&
            !disabled(node) &&
            (['input', 'textarea'].includes(tag(node)) || !!node.isContentEditable),
        }
        if (result.name.length > 1000) {
          result.name = ''
          result.nameOmitted = true
        }
        if (node.checked !== undefined) result.checked = !!node.checked
        if (attr(node, 'aria-expanded')) result.expanded = attr(node, 'aria-expanded') === 'true'
        if (attr(node, 'href') && attr(node, 'href').length <= 4096) result.href = attr(node, 'href')
        if (tag(node) === 'select') {
          result.options = Array.from(node.options)
            .slice(0, 40)
            .map(option => ({ value: option.value, label: option.label, disabled: option.disabled }))
          result.optionsTruncated = node.options.length > 40
        }
        return result
      })
      const elements = []
      for (const candidate of candidates) {
        if (JSON.stringify(candidate).length > 8000) {
          delete candidate.options
          delete candidate.href
          candidate.detailsOmitted = true
        }
        const length = JSON.stringify(candidate).length
        if (responseBytes + length > 24000 && elements.length) break
        elements.push(candidate)
        responseBytes += length
      }
      const nextOffset = offset + elements.length < matches.length ? offset + elements.length : null
      return {
        ok: true,
        version: 1,
        url: location.href,
        title: document.title,
        elements,
        total: matches.length,
        offset,
        nextOffset,
        truncated: nextOffset !== null || found.traversalLimited,
        visited: found.visited,
        frames: found.frames,
        limitations: [
          'closed_shadow_roots_not_exposed',
          ...(found.traversalLimited ? ['scan_visit_limit_use_selector_or_query'] : []),
        ],
        vision: {
          automatic: false,
          availableVia: 'browser_screenshot + image_analyze',
          reason: found.frames.length
            ? 'inaccessible_frame'
            : matches.some(node => tag(node) === 'canvas')
              ? 'canvas_present'
              : null,
        },
      }
    }
    if (p.action === 'read') {
      const text = String(el.innerText || el.textContent || ''),
        max = p.maxChars || 20000,
        offset = Math.min(p.offset || 0, text.length)
      let end = Math.min(text.length, offset + max)
      // Prefer whole lines while still advancing across a long unbroken paragraph.
      if (end < text.length) {
        const boundary = text.lastIndexOf('\n', end)
        if (boundary > offset) end = boundary + 1
        // A JSON string must not end halfway through an astral Unicode character.
        if (end > offset && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) {
          end = end - 1 > offset ? end - 1 : Math.min(text.length, end + 1)
        }
      }
      let first = 2166136261,
        second = 5381
      for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index)
        first = Math.imul(first ^ unit, 16777619)
        second = Math.imul(second, 33) ^ unit
      }
      const links = []
      const seen = new Set()
      for (const anchor of document.querySelectorAll('a[href]')) {
        try {
          const url = new URL(anchor.getAttribute('href'), document.baseURI)
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href))
            continue
          seen.add(url.href)
          links.push({ url: url.href, title: normalize(anchor.innerText || anchor.textContent).slice(0, 300) })
          if (links.length >= 200) break
        } catch {
          /* Malformed page links are data, not failed research. */
        }
      }
      const meta = name =>
        document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content?.slice(0, 160) || null
      return {
        ok: true,
        url: location.href,
        title: document.title,
        text: text.slice(offset, end),
        truncated: end < text.length,
        offset,
        totalChars: text.length,
        nextOffset: end < text.length ? end : null,
        snapshotId: `${text.length}:${first >>> 0}:${second >>> 0}`,
        links,
        publishedAt: meta('article:published_time') || meta('datePublished') || meta('date'),
        updatedAt: meta('article:modified_time') || meta('dateModified'),
      }
    }
    const operation = p.operation || p.action
    if (
      !visible(el) ||
      disabled(el) ||
      (operation !== 'click' && (el.readOnly || attr(el, 'aria-readonly') === 'true'))
    )
      return fail('browser_target_not_actionable')
    if (p.action === 'prepare') {
      if (operation === 'click') el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      const bounds = el.getBoundingClientRect(),
        s = state(),
        print = fingerprint(el)
      const signature = JSON.stringify([bounds.left, bounds.top, bounds.width, bounds.height]),
        previous = s.prepared
      s.prepared = { el, signature, fingerprint: print, operation }
      markPointer(el)
      if (
        operation === 'click' &&
        (!hitTarget(el) ||
          !previous ||
          previous.el !== el ||
          previous.signature !== signature ||
          previous.fingerprint !== print)
      )
        return fail('browser_target_not_actionable')
      return { ok: true, ready: true, ref: observe(el) }
    }
    if (p.action === 'click') {
      if (!hitTarget(el)) return fail('browser_target_not_actionable')
      if (p.prepared) {
        const r = el.getBoundingClientRect(),
          previous = state().prepared
        if (
          !previous ||
          previous.el !== el ||
          previous.signature !== JSON.stringify([r.left, r.top, r.width, r.height]) ||
          previous.fingerprint !== fingerprint(el)
        )
          return fail('browser_target_not_actionable')
      }
      // No await between native admission and effect; never auto-retry this phase.
      markPointer(el)
      if (!el.isConnected || !visible(el) || disabled(el) || !hitTarget(el))
        return fail('browser_target_not_actionable')
      el.click()
      return { ok: true, clicked: true }
    }
    if (p.action === 'fill' || p.action === 'select') {
      const w = view(el),
        select = el instanceof w.HTMLSelectElement,
        editable = el.isContentEditable
      if (
        p.action === 'select'
          ? !select
          : !(el instanceof w.HTMLInputElement || el instanceof w.HTMLTextAreaElement || editable)
      )
        return fail('browser_target_type_invalid')
      if (
        el instanceof w.HTMLInputElement &&
        ['file', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)
      )
        return fail('browser_target_type_invalid')
      if (
        select &&
        !Array.from(el.options).some(
          option => option.value === p.value && !option.disabled && !option.parentElement?.disabled
        )
      )
        return fail('browser_option_missing')
      markPointer(el)
      if (editable) el.textContent = p.value
      else {
        const prototype = select
          ? w.HTMLSelectElement.prototype
          : el instanceof w.HTMLInputElement
            ? w.HTMLInputElement.prototype
            : w.HTMLTextAreaElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (!setter) return fail('browser_setter_unavailable')
        setter.call(el, p.value)
      }
      el.dispatchEvent(new w.Event('input', { bubbles: true, composed: true }))
      el.dispatchEvent(new w.Event('change', { bubbles: true, composed: true }))
      const applied = (editable ? el.textContent : el.value) === p.value
      return { ok: applied, applied, ...(!applied ? { code: 'browser_value_not_applied' } : {}) }
    }
    return fail('browser_action_unknown')
  } catch (error) {
    return fail(/^browser_[a-z_]+$/u.test(error.message) ? error.message : 'browser_selector_invalid')
  }
}
