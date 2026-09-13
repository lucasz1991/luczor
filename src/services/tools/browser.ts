import type { ToolDef, ToolContext } from './types'
import { closeToolSession, findToolSession, getToolSession } from './toolSessionCoordinator'
import { validateToolArguments } from './validateArguments'
import { browserPanel, browserFailure, revealBrowserPanel } from '@/services/browserPanel'
import { loadDesktopControl } from '@/services/desktopControl'

const url = { type: 'string', minLength: 1, maxLength: 2048 }
const selector = { type: 'string', minLength: 1, maxLength: 4096 }
const sessionProperties = {
  url,
  selector,
  value: { type: 'string', maxLength: 20000 },
  name: { type: 'string', maxLength: 160 },
  allowed_hosts: {
    type: 'array',
    minItems: 1,
    maxItems: 30,
    items: { type: 'string', minLength: 1, maxLength: 253 },
    description:
      'Bestätigte Hosts ohne Protokoll/Pfad, z. B. example.com. Beim Öffnen erforderlich; Folgeaufrufe übernehmen die Sitzung.',
  },
}
const sessionSchema = (required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties: sessionProperties,
  required,
})

function hosts(args: Record<string, unknown>): readonly string[] {
  const values = Array.isArray(args.allowed_hosts)
    ? args.allowed_hosts
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim().toLowerCase())
    : []
  if (values.some(host => !/^[a-z0-9.:-]+$/u.test(host))) throw new Error('workflow_browser_allowed_hosts_invalid')
  return [...new Set(values)].sort()
}

function assertAllowedHost(action: string, args: Record<string, unknown>, allowedHosts: readonly string[]): void {
  if (!['open', 'navigate', 'download'].includes(action) || typeof args.url !== 'string') return
  if (!allowedHosts.length) throw new Error('workflow_browser_host_boundary_required')
  let hostname: string
  try {
    const target = new URL(args.url)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error()
    hostname = target.host.toLowerCase()
  } catch {
    throw new Error('workflow_browser_url_invalid')
  }
  if (!allowedHosts.includes(hostname)) throw new Error('workflow_browser_host_not_allowed')
}

async function browser(ctx: ToolContext, action: string, args: Record<string, unknown>) {
  const existing = findToolSession(ctx, 'browser')
  if (action === 'status') {
    const control = await loadDesktopControl().catch(() => null)
    return {
      ok: true,
      surface: 'luczor_internal_browser',
      system_pointer_used: false,
      preferred: control?.config?.preferInternalBrowser ?? true,
      session: existing
        ? { id: existing.meta.id, status: existing.meta.status, allowed_hosts: existing.meta.allowedHosts }
        : null,
      next_tool: existing ? 'browser_dom_read' : 'browser_open',
      guidance:
        'Die Bindung gilt nur für diesen Auftrag. Zum Schließen browser_close mit {} verwenden. Keine Hosts raten.',
    }
  }
  if (action === 'close') {
    const closed = existing ? await closeToolSession(existing.meta.id) : false
    return { ok: true, closed, already_closed: !closed }
  }
  if (action !== 'open' && !existing) throw new Error('workflow_browser_session_unavailable')
  const allowedHosts = hosts(args)
  // Validate before reserving a session. An invalid URL must not freeze the wrong host set.
  assertAllowedHost(action, args, allowedHosts.length ? allowedHosts : (existing?.meta.allowedHosts ?? []))
  const session = await getToolSession(ctx, 'browser', allowedHosts)
  const browser = session.browser
  if (!browser) throw new Error('Browser-Sitzung konnte nicht initialisiert werden.')
  switch (action) {
    case 'open':
      try {
        return await browser.open(typeof args.url === 'string' ? args.url : undefined)
      } catch (error) {
        await closeToolSession(session.meta.id)
        throw error
      }
    case 'navigate':
      return browser.navigate(String(args.url))
    case 'read':
      return browser.read(typeof args.selector === 'string' ? args.selector : undefined)
    case 'screenshot':
      return browser.screenshot(typeof args.name === 'string' ? args.name : undefined)
    case 'click':
      return browser.click(String(args.selector))
    case 'fill':
      return browser.fill(String(args.selector), String(args.value))
    case 'select':
      return browser.select(String(args.selector), String(args.value))
    case 'download':
      return browser.download(String(args.url), typeof args.name === 'string' ? args.name : undefined)
    default:
      throw new Error(`Unbekannte Browseraktion: ${action}`)
  }
}

function define(
  name: string,
  description: string,
  action: string,
  parameters: Record<string, unknown>,
  mutating: boolean,
  requiresApproval: boolean
): ToolDef {
  return {
    name,
    category: 'app',
    description: `${description} Ausschließlich die interne Luczor-Sitzung; keine fremden Browserfenster. DOM-Eingaben verwenden nicht die Systemmaus oder Systemtastatur.`,
    parameters,
    mutating,
    requiresApproval,
    dataHandling: 'ephemeral',
    risk: mutating ? 'sensitive' : 'sensitive',
    scope: 'project',
    effects: [mutating ? 'input' : 'read'],
    capabilityKey: `browser.${action}`,
    sessionKind: 'browser',
    approvalMode: requiresApproval ? 'session' : 'call',
    async execute(args, ctx) {
      validateToolArguments(parameters, args)
      if (action === 'open') revealBrowserPanel(ctx.projectId)
      browserPanel.error = ''
      try {
        return await browser(ctx, action, args)
      } catch (error) {
        const message = browserFailure(error)
        browserPanel.error = message
        throw new Error(message)
      }
    },
  }
}

export const browserTools: ToolDef[] = [
  define(
    'browser_status',
    'Liest die Browser-Sitzung dieses Auftrags und ihre bestätigten Hosts. Bei Sitzungsfehlern zuerst mit {} aufrufen; keine Hostlisten erraten. Öffnet keine Sitzung.',
    'status',
    { type: 'object', additionalProperties: false, properties: {} },
    false,
    false
  ),
  define(
    'browser_close',
    'Beendet nur die Browser-Sitzung dieses Auftrags, auch nach einem fehlgeschlagenen Öffnen. Mit {} aufrufen; allowed_hosts wird beim Schließen nicht benötigt. Zum Ausblenden das Panel einklappen.',
    'close',
    sessionSchema(),
    true,
    true
  ),
  define(
    'browser_open',
    'Öffnet den internen Browser rechts neben dem Chat. allowed_hosts muss die bestätigten Zielhosts enthalten.',
    'open',
    sessionSchema(['allowed_hosts']),
    true,
    true
  ),
  define(
    'browser_navigate',
    'Navigiert die bestätigte Browser-Sitzung zu einer HTTP(S)-URL.',
    'navigate',
    sessionSchema(['url']),
    true,
    true
  ),
  define(
    'browser_dom_read',
    'Liest DOM-Text oder ein ausgewähltes Element aus der gebundenen Browser-Sitzung.',
    'read',
    sessionSchema(),
    false,
    true
  ),
  define(
    'browser_screenshot',
    'Erstellt einen temporären Screenshot der gebundenen Browser-Sitzung.',
    'screenshot',
    sessionSchema(),
    false,
    true
  ),
  define(
    'browser_click',
    'Klickt ein CSS-Selektor in der bestätigten Browser-Sitzung.',
    'click',
    sessionSchema(['selector']),
    true,
    true
  ),
  define(
    'browser_fill',
    'Füllt ein Formularfeld in der bestätigten Browser-Sitzung.',
    'fill',
    sessionSchema(['selector', 'value']),
    true,
    true
  ),
  define(
    'browser_select',
    'Wählt einen Wert in einem Select-Feld der Browser-Sitzung.',
    'select',
    sessionSchema(['selector', 'value']),
    true,
    true
  ),
  define(
    'browser_download',
    'Lädt eine URL als temporäres Browser-Artefakt herunter.',
    'download',
    sessionSchema(['url']),
    true,
    true
  ),
]
