import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'
import { asString } from './shared'
import type { ToolDef } from './types'

/* Public coordinate schemas and command payloads intentionally use x/y. */
/* eslint id-length: ['error', { exceptions: ['x', 'y'] }] */

/** Last screenshot captured by os_screen_capture, as a data URL (for the UI). */
export const lastScreenshot = ref<string | null>(null)

function coordinate(value: unknown, name: 'x' | 'y'): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 100_000) {
    throw new Error(`${name} must be a finite screen coordinate.`)
  }
  return Math.round(parsed)
}

export const osTools: ToolDef[] = [
  {
    name: 'os_read_clipboard',
    category: 'os',
    description: 'Read the current text content of the system clipboard.',
    mutating: false,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'sensitive',
    scope: 'desktop',
    effects: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: 2000,
          description: 'Maximum returned characters; defaults to 2000.',
        },
      },
      required: [],
    },
    async execute(args) {
      const text = (await invoke<string>('read_clipboard')) ?? ''
      const requested = Number(args.max_chars)
      const maxChars = Number.isFinite(requested) ? Math.max(1, Math.min(2000, Math.round(requested))) : 2000
      const clipped = text.length > maxChars ? text.slice(0, maxChars) + '…' : text
      return { text: clipped, length: text.length }
    },
  },
  {
    name: 'os_list_windows',
    category: 'os',
    description: 'List currently open windows with their title, owning app, and whether they are focused.',
    mutating: false,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'sensitive',
    scope: 'desktop',
    effects: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        focused_only: { type: 'boolean', description: 'Return only the focused window. Defaults to false.' },
      },
      required: [],
    },
    async execute(args) {
      const windows = await invoke<Array<Record<string, unknown>>>('list_windows')
      return {
        windows: args.focused_only === true ? windows.filter(window => window.focused === true) : windows,
      }
    },
  },
  {
    name: 'os_screen_capture',
    category: 'os',
    description:
      'Capture a screenshot of the primary monitor. Returns image dimensions; the image itself is shown in the app.',
    mutating: false,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'sensitive',
    scope: 'desktop',
    effects: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        monitor: {
          type: 'string',
          enum: ['primary'],
          description: 'Monitor to capture; currently only primary is supported.',
        },
      },
      required: [],
    },
    async execute() {
      const shot = await invoke<{ base64: string; mime: string; width: number; height: number }>('capture_screen')
      // Publish the image for the UI, but only return metadata to the model
      // (a full base64 screenshot would flood the context window).
      lastScreenshot.value = `data:${shot.mime};base64,${shot.base64}`
      return { captured: true, width: shot.width, height: shot.height }
    },
  },
  {
    name: 'os_move_mouse',
    category: 'os',
    description: 'Move the mouse cursor to an absolute screen position (pixels).',
    mutating: true,
    requiresApproval: true,
    risk: 'critical',
    scope: 'desktop',
    effects: ['input'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', description: 'Absolute X in pixels.' },
        y: { type: 'number', description: 'Absolute Y in pixels.' },
      },
      required: ['x', 'y'],
    },
    async execute(args) {
      await invoke('move_mouse', { payload: { x: coordinate(args.x, 'x'), y: coordinate(args.y, 'y') } })
      return { ok: true }
    },
  },
  {
    name: 'os_click',
    category: 'os',
    description: 'Click the mouse. Optionally move to (x,y) first. button = left|right|middle.',
    mutating: true,
    requiresApproval: true,
    risk: 'critical',
    scope: 'desktop',
    effects: ['input'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        x: { type: 'number' },
        y: { type: 'number' },
        double: { type: 'boolean' },
      },
      required: [],
    },
    async execute(args) {
      if ((args.x == null) !== (args.y == null)) throw new Error('x and y must be supplied together.')
      await invoke('mouse_click', {
        payload: {
          button: asString(args.button) || 'left',
          x: args.x == null ? null : coordinate(args.x, 'x'),
          y: args.y == null ? null : coordinate(args.y, 'y'),
          double: !!args.double,
        },
      })
      return { ok: true }
    },
  },
  {
    name: 'os_type_text',
    category: 'os',
    description: 'Type text into the currently focused application via simulated keystrokes.',
    mutating: true,
    requiresApproval: true,
    risk: 'critical',
    scope: 'desktop',
    effects: ['input'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(args) {
      const text = asString(args.text)
      if (!text || [...text].length > 10_000) throw new Error('text must contain 1 to 10000 characters.')
      await invoke('type_text', { payload: { text } })
      return { ok: true }
    },
  },
  {
    name: 'os_press_key',
    category: 'os',
    description:
      'Press a single key: enter, tab, escape, space, backspace, delete, up, down, left, right, home, end, or a single character.',
    mutating: true,
    requiresApproval: true,
    risk: 'critical',
    scope: 'desktop',
    effects: ['input'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    async execute(args) {
      await invoke('press_key', { payload: { key: asString(args.key) } })
      return { ok: true }
    },
  },
  {
    name: 'os_scroll',
    category: 'os',
    description: 'Scroll the currently focused application vertically or horizontally by a bounded number of steps.',
    mutating: true,
    requiresApproval: true,
    risk: 'critical',
    scope: 'desktop',
    effects: ['input'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        amount: { type: 'integer', minimum: -100, maximum: 100, description: 'Signed, non-zero scroll steps.' },
        axis: {
          type: 'string',
          enum: ['vertical', 'horizontal'],
          description: 'Scroll axis. Defaults to vertical.',
        },
      },
      required: ['amount'],
    },
    async execute(args) {
      const amount = Math.round(Number(args.amount))
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100) {
        throw new Error('amount must be a non-zero integer between -100 and 100.')
      }
      const axis = asString(args.axis).trim().toLowerCase() || 'vertical'
      if (axis !== 'vertical' && axis !== 'horizontal') throw new Error('axis must be vertical or horizontal.')
      await invoke('scroll', { payload: { amount, axis } })
      return { ok: true }
    },
  },
  {
    name: 'os_hotkey',
    category: 'os',
    description:
      'Press one keyboard shortcut using 1-4 modifiers (control, alt, shift, meta) and one safe named or character key.',
    mutating: true,
    requiresApproval: true,
    risk: 'critical',
    scope: 'desktop',
    effects: ['input'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        modifiers: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string', enum: ['control', 'alt', 'shift', 'meta'] },
        },
        key: { type: 'string', description: 'Safe key name accepted by os_press_key, or one character.' },
      },
      required: ['modifiers', 'key'],
    },
    async execute(args) {
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers.map(value => asString(value).trim().toLowerCase())
        : []
      if (
        modifiers.length < 1 ||
        modifiers.length > 4 ||
        new Set(modifiers).size !== modifiers.length ||
        modifiers.some(value => !['control', 'alt', 'shift', 'meta'].includes(value))
      ) {
        throw new Error('modifiers must contain 1-4 unique values: control, alt, shift, meta.')
      }
      const key = asString(args.key).trim()
      if (!key) throw new Error('key is empty.')
      await invoke('hotkey', { payload: { modifiers, key } })
      return { ok: true }
    },
  },
  {
    name: 'os_open_url',
    category: 'os',
    description: "Open an http(s) URL with the operating system's default browser.",
    mutating: true,
    requiresApproval: true,
    risk: 'sensitive',
    scope: 'network',
    effects: ['execute'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async execute(args) {
      const url = asString(args.url).trim()
      if (!/^https?:\/\/[^\s\u0000-\u001f]+$/i.test(url)) throw new Error('Only a valid http(s) URL is allowed.')
      await invoke('open_url', { payload: { url } })
      return { ok: true }
    },
  },
  {
    name: 'os_environment',
    category: 'os',
    description:
      'Read a lightweight snapshot of the local environment (open windows, display size, basic system metrics) WITHOUT taking a screenshot. Use to orient before acting.',
    mutating: false,
    requiresApproval: true,
    dataHandling: 'ephemeral',
    risk: 'sensitive',
    scope: 'desktop',
    effects: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      // Keep one optional property: the Nvidia/OpenRouter grammar rejects
      // function schemas whose properties object is empty.
      properties: {
        include_windows: { type: 'boolean', description: 'Include the open-window list. Defaults to true.' },
      },
      required: [],
    },
    async execute(args) {
      const includeWindows = (args as { include_windows?: boolean }).include_windows !== false
      const [windows, metrics] = await Promise.all([
        includeWindows ? invoke('list_windows').catch(() => []) : Promise.resolve([]),
        invoke('system_metrics').catch(() => null),
      ])
      const screen =
        typeof window !== 'undefined' && window.screen
          ? { width: window.screen.width, height: window.screen.height, color_depth: window.screen.colorDepth }
          : null
      return { ok: true, screenshot: false, windows, metrics, screen }
    },
  },
]
