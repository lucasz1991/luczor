// src/services/workflowTaskRunner.ts
//
// SOLL §14 P15b (client side) — executes a `workflow.task` device-job bundle on
// the device. The server compiled a vetted workflow client task into the bundle
// { task_key, params, workflow: { run, step_id, step_key } } and signed it; the
// device job pipeline already verified the signature before we get here.
//
// This module is pure and dependency-injected (no direct Tauri imports) so it is
// unit-testable: the effectful primitives (open a URL, do an HTTP request, run a
// coding agent) are passed in. deviceJobs.ts wires the real Tauri-backed ones.
//
// Security posture (SOLL §0): the device only performs the fixed set of client
// tasks below. Anything the device build cannot do safely yet (a controlled
// browser for click/read, a local Python/Node runtime, filesystem access)
// fails cleanly with an explanatory error, which the server records as a failed
// step — never a silent success.

export type WorkflowTaskBundle = {
  task_key: string
  params: Record<string, unknown>
  workflow: {
    run: string
    step_id: number
    step_key: string
    execution_id?: string
    definition_id?: number
    child_definition_id?: number
    child_revision?: number
    revision?: number
    project_id?: string | null
    device_id?: string
    file_scope?: 'legacy' | 'workspace'
    workspace_root_id?: string | null
    workspace_root_path?: string | null
    input_sources?: string[]
    output_keys?: string[]
    automatic?: boolean
    grant?: unknown
  }
}

export type WorkflowTaskPrimitives = {
  /** Open an http(s) URL in the OS default browser. */
  openUrl: (url: string) => Promise<void>
  /** Perform an HTTP request and return a compact, capped result. */
  httpFetch: (
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | null
  ) => Promise<{ status: number; ok: boolean; body: string }>
  /** Run a locally installed coding agent headlessly. */
  runAgent: (
    agent: string,
    prompt: string,
    projectDir?: string
  ) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>
  runLlm?: (input: import('@/services/workflows/llm').WorkflowLlmInput) => Promise<Record<string, unknown>>
  /** Read/write a file inside the confined workflow files root (P15b). */
  fileRead: (path: string) => Promise<{ content: string; bytes: number; truncated: boolean }>
  fileWrite: (path: string, content: string) => Promise<{ path: string; bytes: number }>
  /** Run a Python/Node snippet headlessly with a timeout (P15b). */
  runScript: (
    runtime: 'python' | 'node',
    code: string,
    timeoutSeconds?: number
  ) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string; timed_out: boolean }>
  /** Drive the in-app browser window (P24). */
  browserOpen: (url?: string) => Promise<unknown>
  browserClick: (selector: string, expectedUrl?: string) => Promise<unknown>
  browserRead: (selector?: string, expectedUrl?: string) => Promise<{ ok: boolean; text: string; truncated: boolean }>
}

const MAX_RESPONSE_CHARS = 20_000

export function isWorkflowTaskBundle(value: unknown): value is WorkflowTaskBundle {
  if (!value || typeof value !== 'object') return false
  const bundle = value as Record<string, unknown>
  return (
    typeof bundle.task_key === 'string' &&
    bundle.task_key.length <= 100 &&
    typeof bundle.params === 'object' &&
    bundle.params !== null &&
    !Array.isArray(bundle.params)
  )
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value)
}

function assertHttpUrl(url: string): string {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed) || /[\u0000-\u001F]/.test(trimmed)) {
    throw new Error('Only valid http(s) URLs are allowed.')
  }
  return trimmed
}

/**
 * Execute one workflow client task. Returns the result object that the device
 * reports back via completeDeviceJob; throws to fail the step.
 */
export async function runWorkflowTask(
  bundle: WorkflowTaskBundle,
  primitives: WorkflowTaskPrimitives
): Promise<Record<string, unknown>> {
  const params = bundle.params ?? {}

  switch (bundle.task_key) {
    case 'llm': {
      if (!primitives.runLlm) throw new Error('workflow_llm_executor_unavailable')
      // Laravel resolves input_bindings into payload target fields; retain those values as data-only model inputs.
      const controlKeys = new Set([
        'instruction',
        'input_bindings',
        'output_format',
        'output_schema',
        'inference',
        'timeout_seconds',
        'max_output_chars',
        'title',
        'list',
        'routes',
        'device_id',
        'project_id',
        'file_scope',
        'workspace_root_id',
        'workspace_root_path',
      ])
      const inputs = Object.fromEntries(Object.entries(params).filter(([key]) => !controlKeys.has(key)))
      return primitives.runLlm({
        ...params,
        input_bindings: {
          ...(params.input_bindings &&
          typeof params.input_bindings === 'object' &&
          !Array.isArray(params.input_bindings)
            ? params.input_bindings
            : {}),
          ...inputs,
        },
      } as import('@/services/workflows/llm').WorkflowLlmInput)
    }
    case 'browser.open':
    case 'browser.open_url': {
      const raw = str(params.url).trim()
      // "browser.open" may carry no URL — just bring a browser up on a blank
      // page. "browser.open_url" requires a real http(s) target.
      if (!raw && bundle.task_key === 'browser.open') {
        await primitives.openUrl('about:blank')
        return { ok: true, opened: 'about:blank' }
      }
      const url = assertHttpUrl(raw)
      await primitives.openUrl(url)
      return { ok: true, opened: url }
    }

    case 'api.call': {
      const url = assertHttpUrl(str(params.url))
      const method = (str(params.method, 'GET').toUpperCase() || 'GET').slice(0, 10)
      const headers = normalizeHeaders(params.headers)
      const body =
        params.body == null ? null : typeof params.body === 'string' ? params.body : JSON.stringify(params.body)
      const res = await primitives.httpFetch(method, url, headers, body)
      return {
        ok: res.ok,
        status: res.status,
        body: res.body.length > MAX_RESPONSE_CHARS ? res.body.slice(0, MAX_RESPONSE_CHARS) : res.body,
        truncated: res.body.length > MAX_RESPONSE_CHARS,
      }
    }

    case 'agent.dispatch': {
      const agent = str(params.agent, 'codex').trim() || 'codex'
      const prompt = str(params.prompt).trim()
      if (!prompt) throw new Error('agent.dispatch requires a prompt.')
      const projectDir = str(params.project_dir).trim() || undefined
      const res = await primitives.runAgent(agent, prompt, projectDir)
      return {
        ok: res.ok,
        code: res.code,
        stdout: res.stdout.slice(0, MAX_RESPONSE_CHARS),
        stderr: res.stderr.slice(0, MAX_RESPONSE_CHARS),
      }
    }

    // SOLL P24 — the in-app browser window drives click/read.
    case 'browser.click': {
      const selector = str(params.selector).trim()
      if (!selector) throw new Error('browser.click requires a selector.')
      // Ensure the window exists (open on the current or a blank page).
      await primitives.browserOpen(str(params.url).trim() || undefined)
      const result = await primitives.browserClick(selector, str(params.url).trim() || undefined)
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true)
        throw new Error('Browserklick wurde nicht bestätigt.')
      return { ok: true, clicked: selector }
    }
    case 'browser.read': {
      const selector = str(params.selector).trim() || undefined
      await primitives.browserOpen(str(params.url).trim() || undefined)
      const res = await primitives.browserRead(selector, str(params.url).trim() || undefined)
      return { ok: res.ok, text: res.text.slice(0, MAX_RESPONSE_CHARS), truncated: res.truncated }
    }

    // SOLL P15b — confined filesystem tasks.
    case 'file.read': {
      const path = str(params.path).trim()
      if (!path) throw new Error('file.read requires a path.')
      const res = await primitives.fileRead(path)
      return { ok: true, content: res.content.slice(0, MAX_RESPONSE_CHARS), bytes: res.bytes, truncated: res.truncated }
    }
    case 'file.write': {
      const path = str(params.path).trim()
      if (!path) throw new Error('file.write requires a path.')
      const res = await primitives.fileWrite(path, str(params.content))
      return { ok: true, path: res.path, bytes: res.bytes }
    }

    // Local full-access runtimes: time/output bounds are not an OS sandbox.
    case 'python.run':
    case 'node.run': {
      const runtime = bundle.task_key === 'python.run' ? 'python' : 'node'
      const code = str(params.code).trim()
      if (!code) throw new Error(`${bundle.task_key} requires code.`)
      const timeout = params.timeout_seconds != null ? Number(params.timeout_seconds) : undefined
      const res = await primitives.runScript(runtime, code, timeout)
      return {
        ok: res.ok,
        code: res.code,
        timed_out: res.timed_out,
        stdout: res.stdout.slice(0, MAX_RESPONSE_CHARS),
        stderr: res.stderr.slice(0, MAX_RESPONSE_CHARS),
      }
    }

    default:
      throw new Error(`Unsupported workflow client task: ${bundle.task_key}`)
  }
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out = Object.create(null) as Record<string, string>
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() === '' || key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    Object.defineProperty(out, key, {
      value: str(raw),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return out
}
