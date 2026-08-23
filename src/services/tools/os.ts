import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'
import { asString } from './shared'
import type { ToolDef } from './types'

/* Public coordinate schemas and command payloads intentionally use x/y. */
/* eslint id-length: ['error', { exceptions: ['x', 'y'] }] */

/** Last screenshot captured by os_screen_capture, as a data URL (for the UI). */
export const lastScreenshot = ref<string | null>(null)

export const osTools: ToolDef[] = [
  {
    name: 'os_read_clipboard',
    category: 'os',
    description: 'Read the current text content of the system clipboard.',
    mutating: false,
    requiresApproval: false,
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
    requiresApproval: false,
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
    requiresApproval: false,
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
      await invoke('move_mouse', { payload: { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) } })
      return { ok: true }
    },
  },
  {
    name: 'os_click',
    category: 'os',
    description: 'Click the mouse. Optionally move to (x,y) first. button = left|right|middle.',
    mutating: true,
    requiresApproval: true,
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
      await invoke('mouse_click', {
        payload: {
          button: asString(args.button) || 'left',
          x: args.x == null ? null : Math.round(Number(args.x)),
          y: args.y == null ? null : Math.round(Number(args.y)),
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
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async execute(args) {
      await invoke('type_text', { payload: { text: asString(args.text) } })
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
    name: 'os_open_url',
    category: 'os',
    description: "Open an http(s) URL with the operating system's default browser.",
    mutating: true,
    requiresApproval: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async execute(args) {
      await invoke('open_url', { payload: { url: asString(args.url) } })
      return { ok: true }
    },
  },
  {
    name: 'os_environment',
    category: 'os',
    description:
      'Read a lightweight snapshot of the local environment (open windows, display size, basic system metrics) WITHOUT taking a screenshot. Use to orient before acting.',
    mutating: false,
    requiresApproval: false,
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
