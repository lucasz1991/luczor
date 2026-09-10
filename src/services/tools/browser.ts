import type { ToolDef, ToolContext } from './types'
import { getToolSession } from './toolSessionCoordinator'
import { validateToolArguments } from './validateArguments'

const url = { type: 'string', minLength: 1, maxLength: 2048 }
const selector = { type: 'string', minLength: 1, maxLength: 4096 }
const sessionProperties = {
  url,
  selector,
  value: { type: 'string', maxLength: 20000 },
  name: { type: 'string', maxLength: 160 },
  allowed_hosts: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 253 } },
}
const sessionSchema = (required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties: sessionProperties,
  required,
})

function hosts(args: Record<string, unknown>): readonly string[] {
  return Array.isArray(args.allowed_hosts)
    ? args.allowed_hosts
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim())
    : []
}

function assertAllowedHost(action: string, args: Record<string, unknown>, allowedHosts: readonly string[]): void {
  if (!['navigate', 'download'].includes(action) || typeof args.url !== 'string') return
  if (!allowedHosts.length)
    throw new Error('Für Browser-Navigation muss mindestens ein bestätigter Host angegeben werden.')
  let hostname: string
  try {
    hostname = new URL(args.url).hostname.toLowerCase()
  } catch {
    throw new Error('Browser-URL ist ungültig.')
  }
  const allowed = allowedHosts.some(host => {
    const normalized = host
      .toLowerCase()
      .replace(/^https?:\/\//u, '')
      .split('/')[0]
    return hostname === normalized || hostname.endsWith(`.${normalized}`)
  })
  if (!allowed) throw new Error('Browser-URL liegt außerhalb der bestätigten Hosts.')
}

async function browser(ctx: ToolContext, action: string, args: Record<string, unknown>) {
  const allowedHosts = hosts(args)
  assertAllowedHost(action, args, allowedHosts)
  const session = await getToolSession(ctx, 'browser', allowedHosts)
  const browser = session.browser
  if (!browser) throw new Error('Browser-Sitzung konnte nicht initialisiert werden.')
  switch (action) {
    case 'open':
      return browser.open(typeof args.url === 'string' ? args.url : undefined)
    case 'navigate':
      return browser.navigate(String(args.url), { expectedUrl: String(args.url) })
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
    case 'close':
      return browser.close()
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
    description,
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
      return browser(ctx, action, args)
    },
  }
}

export const browserTools: ToolDef[] = [
  define('browser_open', 'Öffnet eine gebundene Luczor-Browser-Sitzung.', 'open', sessionSchema(), true, true),
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
