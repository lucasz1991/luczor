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

import { workflowLlmInput, checkWorkflowLlmResult } from '@/services/workflows/taskInputs'
import { validateToolArguments } from '@/services/tools/validateArguments'
import type { ThinkingTier } from '@/services/inference/thinking'
import { isThinkingTier } from '@/services/inference/thinking'

export type WorkflowTaskBundle = {
  task_version?: number
  task_key: string
  params: Record<string, unknown>
  workflow: {
    run: string
    /** Root run owns browser/image artifacts shared by frozen child runs. */
    resource_run?: string
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
    thinking_tier?: ThinkingTier
    test_mode?: 'real'
    test_run?: string
    test_binding?: Record<string, unknown>
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
    projectDir?: string,
    options?: import('@/services/agents/types').AgentExecutionOptions & { model?: string }
  ) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>
  runLlm?: (input: import('@/services/workflows/llm').WorkflowLlmInput) => Promise<Record<string, unknown>>
  runAgentFlow?: (team: boolean, params: Record<string, unknown>) => Promise<Record<string, unknown>>
  browserSession?: ReturnType<typeof import('@/services/workflows/browser').createWorkflowBrowser>
  runImage?: (input: import('@/services/workflows/image').WorkflowImageInput) => Promise<Record<string, unknown>>
  /** Read/write a file inside the confined workflow files root (P15b). */
  fileRead: (path: string) => Promise<{ content: string; bytes: number; truncated: boolean }>
  fileWrite: (path: string, content: string) => Promise<{ path: string; bytes: number }>
  /** Run a Python/Node snippet headlessly with a timeout (P15b). */
  runScript: (
    runtime: 'python' | 'node',
    code: string,
    timeoutSeconds?: number,
    input?: Record<string, unknown>
  ) => Promise<{
    ok: boolean
    code: number
    stdout: string
    stderr: string
    timed_out: boolean
    stdout_truncated?: boolean
    stderr_truncated?: boolean
    duration_ms?: number
    runtime?: string
    interpreter?: string
    runtime_version?: string
    execution_profile?: 'host-user'
    input_mode?: 'json-stdin' | 'code-stdin'
    code_sha256?: string
  }>
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
  if (bundle.task_version !== undefined && bundle.task_version !== 1)
    throw new Error('workflow_task_version_unsupported')
  if (bundle.task_key.startsWith('browser.') && primitives.browserSession)
    return runBrowserTask(bundle.task_key, params, primitives.browserSession)

  switch (bundle.task_key) {
    case 'llm':
    case 'llm.text':
    case 'llm.json':
    case 'llm.classify':
    case 'llm.extract':
    case 'llm.evaluate': {
      if (!primitives.runLlm) throw new Error('workflow_llm_executor_unavailable')
      const input = workflowLlmInput(bundle.task_key, params)
      return checkWorkflowLlmResult(bundle.task_key, input, await primitives.runLlm(input))
    }
    case 'agent.single':
    case 'agent.team': {
      if (!primitives.runAgentFlow) throw new Error('workflow_agent_executor_unavailable')
      return primitives.runAgentFlow(bundle.task_key === 'agent.team', params)
    }
    case 'image.capture':
    case 'image.ocr':
    case 'image.vision':
    case 'image.compare': {
      if (!primitives.runImage) throw new Error('workflow_image_executor_unavailable')
      return primitives.runImage({
        action: bundle.task_key.slice(6) as import('@/services/workflows/image').WorkflowImageInput['action'],
        artifactId: str(params.artifact_id) || undefined,
        otherArtifactId: str(params.other_artifact_id) || undefined,
        language: str(params.language) || undefined,
        monitorId: typeof params.monitor_id === 'number' ? params.monitor_id : undefined,
        maxChars: typeof params.max_chars === 'number' ? params.max_chars : undefined,
        instruction: typeof params.instruction === 'string' ? params.instruction : undefined,
        inference: params.inference === 'external' ? 'external' : params.inference === 'local' ? 'local' : undefined,
        outputFormat: params.output_format === 'json' ? 'json' : params.output_format === 'text' ? 'text' : undefined,
        maxOutputChars: typeof params.max_output_chars === 'number' ? params.max_output_chars : undefined,
      })
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
      const requested =
        params.thinking_tier === 'inherit' || params.thinking_tier === undefined
          ? bundle.workflow.thinking_tier
          : params.thinking_tier
      if (requested !== undefined && !isThinkingTier(requested)) throw new Error('workflow_thinking_tier_invalid')
      const options = { thinkingTier: requested, model: typeof params.model === 'string' ? params.model : undefined }
      const res =
        requested !== undefined || options.model
          ? await primitives.runAgent(agent, prompt, projectDir, options)
          : await primitives.runAgent(agent, prompt, projectDir)
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
      if (
        params.input !== undefined &&
        (!params.input || typeof params.input !== 'object' || Array.isArray(params.input))
      )
        throw new Error('workflow_script_input_invalid')
      const res =
        params.input !== undefined
          ? await primitives.runScript(runtime, code, timeout, params.input as Record<string, unknown>)
          : await primitives.runScript(runtime, code, timeout)
      let data: unknown
      if (params.input !== undefined || params.output_schema !== undefined) {
        if (!res.ok || res.timed_out || res.stdout_truncated || res.stdout.length > MAX_RESPONSE_CHARS)
          throw new Error('workflow_script_json_output_incomplete')
        try {
          data = JSON.parse(res.stdout)
        } catch {
          throw new Error('workflow_script_json_output_invalid')
        }
        if (params.output_schema) validateToolArguments(params.output_schema as Record<string, unknown>, data)
      }
      return {
        ok: res.ok,
        code: res.code,
        timed_out: res.timed_out,
        stdout: res.stdout.slice(0, MAX_RESPONSE_CHARS),
        stderr: res.stderr.slice(0, MAX_RESPONSE_CHARS),
        ...(data !== undefined ? { data, execution_environment: 'windows_user' } : {}),
        ...Object.fromEntries(
          [
            'duration_ms',
            'runtime',
            'interpreter',
            'runtime_version',
            'execution_profile',
            'input_mode',
            'code_sha256',
          ].flatMap(key => (Reflect.get(res, key) === undefined ? [] : [[key, Reflect.get(res, key)]]))
        ),
      }
    }

    default:
      throw new Error(`Unsupported workflow client task: ${bundle.task_key}`)
  }
}

async function runBrowserTask(
  task: string,
  params: Record<string, unknown>,
  browser: NonNullable<WorkflowTaskPrimitives['browserSession']>
): Promise<Record<string, unknown>> {
  const options = {
    sessionId: str(params.browser_session_id) || undefined,
    expectedTabId: str(params.tab_id) || undefined,
    expectedUrl: str(params.expected_url || params.url) || undefined,
    timeoutMs: typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
  }
  const selector = str(params.selector).trim()
  const url = str(params.url).trim()
  if (['browser.click', 'browser.fill', 'browser.select'].includes(task) && !selector)
    throw new Error(`${task} requires a selector.`)
  switch (task) {
    case 'browser.open':
      return browser.open(url ? assertHttpUrl(url) : undefined, { ...options, expectedUrl: undefined })
    case 'browser.open_url':
    case 'browser.navigate':
      return browser.navigate(assertHttpUrl(url), { ...options, expectedUrl: str(params.expected_url) || undefined })
    case 'browser.click':
      return browser.click(selector, options)
    case 'browser.fill':
    case 'browser.select': {
      if (typeof params.value !== 'string') throw new Error(`${task} requires a string value.`)
      return task === 'browser.fill'
        ? browser.fill(selector, params.value, options)
        : browser.select(selector, params.value, options)
    }
    case 'browser.wait':
      return browser.wait(selector || undefined, options)
    case 'browser.read':
      return browser.read(selector || undefined, options)
    case 'browser.screenshot':
      return browser.screenshot(str(params.name) || undefined, options)
    case 'browser.download':
      return browser.download(assertHttpUrl(url), str(params.name) || undefined, {
        ...options,
        expectedUrl: str(params.expected_url) || undefined,
      })
    default:
      throw new Error(`Unsupported workflow browser task: ${task}`)
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
