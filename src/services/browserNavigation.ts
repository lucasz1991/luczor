/** Navigation only; this never grants a visited page access to native IPC. */
export function browserNavigationUrl(input: string): string {
  const value = input.trim()
  if (!value || /[\u0000-\u001f]/u.test(value)) throw new Error('workflow_browser_url_invalid')
  let normalized = value
  if (/^[a-z]:[\\/]/iu.test(value)) {
    normalized = `file:///${value
      .replaceAll('\\', '/')
      .split('/')
      .map(encodeURIComponent)
      .join('/')
      .replace(/^([a-z])%3A/iu, '$1:')}`
  } else if (value.startsWith('\\\\')) {
    normalized = `file://${value.slice(2).replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')}`
  } else if (value.startsWith('/')) {
    normalized = `file://${value.split('/').map(encodeURIComponent).join('/')}`
  } else if (!/^[a-z][a-z\d+.-]*:/iu.test(value) || /^[^/:\s]+:\d+(?:\/|$)/u.test(value)) {
    normalized = `${/^(localhost|127\.0\.0\.1)(?::|\/|$)/iu.test(value) ? 'http' : 'https'}://${value}`
  }
  let target: URL
  try {
    target = new URL(normalized)
  } catch {
    throw new Error('workflow_browser_url_invalid')
  }
  if (
    (!['http:', 'https:', 'file:'].includes(target.protocol) && target.href !== 'about:blank') ||
    target.username ||
    target.password ||
    (['http:', 'https:'].includes(target.protocol) && !target.hostname)
  )
    throw new Error('workflow_browser_url_invalid')
  return target.href
}
