// Fixed native-owned DOM contract. No workflow parameter is evaluated as JavaScript.
async function luczorWorkflowBrowser(p) {
  const fail = code => ({ ok: false, code })
  if (location.href !== p.expectedUrl) return fail('browser_url_changed')
  const locate = () => {
    const nodes = document.querySelectorAll(p.selector || 'body')
    if (nodes.length !== 1) return null
    return nodes[0]
  }
  const visible = el => {
    if (!el) return false
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el)
    return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none'
  }
  if (p.action === 'wait') {
    const deadline = Date.now() + p.timeoutMs
    while (Date.now() < deadline) {
      if (location.href !== p.expectedUrl) return fail('browser_url_changed')
      if (document.readyState !== 'loading' && (!p.selector || visible(locate()))) return { ok: true, ready: true }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return fail('browser_wait_timeout')
  }
  if (p.action === 'download') {
    const url = new URL(p.url, location.href)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) return fail('browser_download_same_origin_required')
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), p.timeoutMs)
    try {
      const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'error', signal: controller.signal })
      if (!response.ok || new URL(response.url).origin !== location.origin || !response.body) return fail('browser_download_response_invalid')
      if (Number(response.headers.get('content-length')) > p.maxBytes) return fail('browser_download_size_exceeded')
      const reader = response.body.getReader(), chunks = []; let length = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > p.maxBytes) { await reader.cancel(); return fail('browser_download_size_exceeded') }
        chunks.push(value)
      }
      if (location.href !== p.expectedUrl) return fail('browser_url_changed')
      let binary = ''
      for (const chunk of chunks) for (let index = 0; index < chunk.length; index += 8192) binary += String.fromCharCode(...chunk.subarray(index, index + 8192))
      return { ok: true, base64: btoa(binary), bytes: length, mime: (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim() }
    } finally { clearTimeout(timer) }
  }
  if (document.readyState === 'loading') return fail('browser_page_not_ready')
  const el = locate()
  if (!el) return fail('browser_target_missing_or_ambiguous')
  if (p.action === 'read') {
    const text = String(el.innerText || el.textContent || '')
    return { ok: true, text: text.slice(0, p.maxChars), truncated: text.length > p.maxChars }
  }
  if (!visible(el) || el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') return fail('browser_target_not_actionable')
  if (p.action === 'click') {
    const rect = el.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hit || (hit !== el && !el.contains(hit))) return fail('browser_target_not_actionable')
    el.click()
    return { ok: true, clicked: true }
  }
  if (p.action === 'fill' || p.action === 'select') {
    const select = el instanceof HTMLSelectElement
    if (p.action === 'select' ? !select : !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return fail('browser_target_type_invalid')
    if (el instanceof HTMLInputElement && ['file', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)) return fail('browser_target_type_invalid')
    if (select && !Array.from(el.options).some(option => option.value === p.value && !option.disabled)) return fail('browser_option_missing')
    const prototype = select ? HTMLSelectElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (!setter) return fail('browser_setter_unavailable')
    setter.call(el, p.value)
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: el.value === p.value, applied: el.value === p.value }
  }
  return fail('browser_action_unknown')
}
