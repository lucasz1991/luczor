import { describe, expect, it, vi } from 'vitest'
import { createWorkflowBrowser } from '@/services/workflows/browser'
import {
  isWorkflowTaskBundle,
  runWorkflowTask,
  type WorkflowTaskBundle,
  type WorkflowTaskPrimitives,
} from '@/services/workflowTaskRunner'

const bundle = (task_key: string, params: Record<string, unknown> = {}): WorkflowTaskBundle => ({
  task_key,
  params,
  workflow: { run: 'run-1', step_id: 7, step_key: 'open' },
})

function primitives(overrides: Partial<WorkflowTaskPrimitives> = {}): WorkflowTaskPrimitives {
  return {
    openUrl: vi.fn(async () => {}),
    httpFetch: vi.fn(async () => ({ status: 200, ok: true, body: '{}' })),
    runAgent: vi.fn(async () => ({ ok: true, code: 0, stdout: 'done', stderr: '' })),
    fileRead: vi.fn(async () => ({ content: 'hello', bytes: 5, truncated: false })),
    fileWrite: vi.fn(async () => ({ path: 'note.txt', bytes: 3 })),
    runScript: vi.fn(async () => ({ ok: true, code: 0, stdout: '42', stderr: '', timed_out: false })),
    browserOpen: vi.fn(async () => ({ ok: true })),
    browserClick: vi.fn(async () => ({ ok: true })),
    browserRead: vi.fn(async () => ({ ok: true, text: 'page text', truncated: false })),
    ...overrides,
  }
}

describe('versioned workflow adapters', () => {
  it.each(['browser.open', 'browser.open_url', 'browser.navigate', 'browser.download'])(
    'allows exact local paths in the internal %s adapter without an OS-browser fallback',
    async task => {
      const native = vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a', tabId: 'tab-a', url: 'about:blank' })
      const runtime = primitives({
        browserSession: createWorkflowBrowser({
          scope: {
            principalId: 'user',
            projectId: 'project',
            runId: 'root',
            expectedRootPath: 'E:/project',
            expectedWorkspaceUpdatedAt: 2,
          },
          invokeTask: native,
        }),
      })
      await runWorkflowTask(bundle(task, { url: 'E:\\Projekt\\Prüfung #1.html' }), runtime)
      expect(native).toHaveBeenCalledWith(
        'wf_browser_action',
        expect.objectContaining({ url: 'file:///E:/Projekt/Pr%C3%BCfung%20%231.html' }),
        true
      )
      expect(runtime.openUrl).not.toHaveBeenCalled()
      native.mockClear()
      await expect(runWorkflowTask(bundle(task, { url: 'javascript:alert(1)' }), runtime)).rejects.toThrow(
        'workflow_browser_url_invalid'
      )
      expect(native).not.toHaveBeenCalled()
    }
  )
  it('rejects unknown versions before running a primitive', async () => {
    const runtime = primitives()
    await expect(runWorkflowTask({ ...bundle('node.run', { code: '42' }), task_version: 2 }, runtime)).rejects.toThrow(
      'workflow_task_version_unsupported'
    )
    expect(runtime.runScript).not.toHaveBeenCalled()
  })
  it('continues the bound browser session without opening an unrelated browser', async () => {
    const native = vi
      .fn()
      .mockResolvedValue({ ok: true, sessionId: 'session-a', tabId: 'tab-a', url: 'https://example.test/form' })
    const runtime = primitives({
      browserSession: createWorkflowBrowser({
        scope: {
          principalId: 'user',
          projectId: 'project',
          runId: 'root',
          expectedRootPath: 'E:/project',
          expectedWorkspaceUpdatedAt: 2,
        },
        invokeTask: native,
      }),
    })
    await runWorkflowTask(
      bundle('browser.fill', {
        selector: '#email',
        value: 'fixture@example.test',
        browser_session_id: 'session-a',
        tab_id: 'tab-a',
        expected_url: 'https://example.test/form',
      }),
      runtime
    )
    expect(runtime.browserOpen).not.toHaveBeenCalled()
    expect(runtime.openUrl).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledWith(
      'wf_browser_action',
      expect.objectContaining({
        action: 'fill',
        sessionId: 'session-a',
        expectedTabId: 'tab-a',
        expectedUrl: 'https://example.test/form',
        selector: '#email',
        value: 'fixture@example.test',
      }),
      true
    )
  })
  it('keeps JSON input separate from code and checks actual script output', async () => {
    const code = 'process.stdout.write(JSON.stringify({result:42}))'
    const runtime = primitives({
      runScript: vi.fn().mockResolvedValue({
        ok: true,
        code: 0,
        stdout: '{"result":42}',
        stderr: '',
        timed_out: false,
        input_mode: 'json-stdin',
        code_sha256: 'a'.repeat(64),
        internal_secret: 'not public',
      }),
    })
    const output = await runWorkflowTask(
      bundle('node.run', {
        code,
        input: { instruction: 'literal data' },
        output_schema: {
          type: 'object',
          required: ['result'],
          properties: { result: { type: 'number' } },
          additionalProperties: false,
        },
      }),
      runtime
    )
    expect(runtime.runScript).toHaveBeenCalledWith('node', code, undefined, { instruction: 'literal data' })
    expect(output).toMatchObject({ data: { result: 42 }, input_mode: 'json-stdin', code_sha256: 'a'.repeat(64) })
    expect(output).not.toHaveProperty('internal_secret')
  })
  it.each([
    { stdout: '{"result":' },
    { stdout: '{"result":42}', stdout_truncated: true },
    { stdout: '{"result":42}', timed_out: true },
  ])('never accepts incomplete JSON script output as test evidence', async overrides => {
    const runtime = primitives({
      runScript: vi.fn().mockResolvedValue({ ok: true, code: 0, stderr: '', timed_out: false, ...overrides }),
    })
    await expect(runWorkflowTask(bundle('python.run', { code: 'print(42)', input: {} }), runtime)).rejects.toThrow(
      'workflow_script_json_output_'
    )
  })
  it('enforces the classifier labels and excludes execution controls from input data', async () => {
    const runtime = primitives({ runLlm: vi.fn().mockResolvedValue({ ok: true, data: { label: 'invented' } }) })
    await expect(
      runWorkflowTask(
        bundle('llm.classify', {
          instruction: 'Classify',
          labels: ['urgent', 'normal'],
          text: 'Please read',
          thinking_tier: 'ultra',
          device_id: 'private-device',
        }),
        runtime
      )
    ).rejects.toThrow()
    const input = vi.mocked(runtime.runLlm!).mock.calls[0]![0]
    expect(input.input_bindings).toEqual({ text: 'Please read', classification_labels: ['urgent', 'normal'] })
    expect(input.thinking_tier).toBe('ultra')
  })
  it('rejects a self-reported passing evaluation with duplicate checks', async () => {
    const runtime = primitives({
      runLlm: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          passed: true,
          checks: [
            { criterion: 'accurate', passed: true },
            { criterion: 'accurate', passed: true },
          ],
        },
      }),
    })
    await expect(
      runWorkflowTask(bundle('llm.evaluate', { instruction: 'Evaluate', criteria: ['accurate', 'complete'] }), runtime)
    ).rejects.toThrow('workflow_llm_evaluation_inconsistent')
  })
  it('requires an extraction schema before any inference', async () => {
    const runtime = primitives({ runLlm: vi.fn() })
    await expect(runWorkflowTask(bundle('llm.extract', { instruction: 'Extract' }), runtime)).rejects.toThrow(
      'extraction_schema_required'
    )
    expect(runtime.runLlm).not.toHaveBeenCalled()
  })
})

describe('workflow.task bundle guard', () => {
  it('accepts a well-formed bundle and rejects junk', () => {
    expect(isWorkflowTaskBundle(bundle('api.call'))).toBe(true)
    expect(isWorkflowTaskBundle({ task_key: 'api.call' })).toBe(false)
    expect(isWorkflowTaskBundle(null)).toBe(false)
    expect(isWorkflowTaskBundle({ params: {} })).toBe(false)
  })
})

describe('browser tasks', () => {
  it('opens a validated http(s) url for browser.open_url', async () => {
    const runtime = primitives()
    const result = await runWorkflowTask(bundle('browser.open_url', { url: 'https://example.org' }), runtime)
    expect(runtime.openUrl).toHaveBeenCalledWith('https://example.org')
    expect(result).toMatchObject({ ok: true, opened: 'https://example.org' })
  })

  it('rejects a non-http url', async () => {
    const runtime = primitives()
    await expect(runWorkflowTask(bundle('browser.open_url', { url: 'file:///etc/passwd' }), runtime)).rejects.toThrow(
      /http/i
    )
    expect(runtime.openUrl).not.toHaveBeenCalled()
  })

  it('rejects URLs containing C0 control characters without making a request', async () => {
    const runtime = primitives()
    await expect(
      runWorkflowTask(bundle('browser.open_url', { url: 'https://example.org/\u0000x' }), runtime)
    ).rejects.toThrow(/http/i)
    expect(runtime.openUrl).not.toHaveBeenCalled()
  })

  it('opens about:blank for browser.open without a url', async () => {
    const runtime = primitives()
    const result = await runWorkflowTask(bundle('browser.open', {}), runtime)
    expect(runtime.openUrl).toHaveBeenCalledWith('about:blank')
    expect(result).toMatchObject({ opened: 'about:blank' })
  })
})

describe('api.call', () => {
  it('performs the request and returns a capped body', async () => {
    const runtime = primitives({ httpFetch: vi.fn(async () => ({ status: 201, ok: true, body: 'created' })) })
    const result = await runWorkflowTask(
      bundle('api.call', {
        method: 'post',
        url: 'https://api.example.org/x',
        headers: { 'X-Test': '1' },
        body: { answer: 1 },
      }),
      runtime
    )
    expect(runtime.httpFetch).toHaveBeenCalledWith(
      'POST',
      'https://api.example.org/x',
      { 'X-Test': '1' },
      '{"answer":1}'
    )
    expect(result).toMatchObject({ ok: true, status: 201, body: 'created', truncated: false })
  })

  it('truncates an oversized response body', async () => {
    const big = 'x'.repeat(25_000)
    const runtime = primitives({ httpFetch: vi.fn(async () => ({ status: 200, ok: true, body: big })) })
    const result = await runWorkflowTask(bundle('api.call', { url: 'https://api.example.org' }), runtime)
    expect((result.body as string).length).toBe(20_000)
    expect(result.truncated).toBe(true)
  })

  it('drops prototype-polluting HTTP header names', async () => {
    const runtime = primitives()
    const headers = JSON.parse('{"__proto__":"polluted","X-Safe":"1"}') as Record<string, string>

    await runWorkflowTask(bundle('api.call', { url: 'https://api.example.org', headers }), runtime)

    expect(runtime.httpFetch).toHaveBeenCalledWith('GET', 'https://api.example.org', { 'X-Safe': '1' }, null)
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('agent.dispatch', () => {
  it('runs the agent with prompt and project dir', async () => {
    const runtime = primitives()
    const result = await runWorkflowTask(
      bundle('agent.dispatch', { agent: 'codex', prompt: 'Fix the bug', project_dir: '/tmp/proj' }),
      runtime
    )
    expect(runtime.runAgent).toHaveBeenCalledWith('codex', 'Fix the bug', '/tmp/proj')
    expect(result).toMatchObject({ ok: true, code: 0, stdout: 'done' })
  })

  it('fails when the prompt is empty', async () => {
    await expect(
      runWorkflowTask(bundle('agent.dispatch', { agent: 'claude', prompt: '  ' }), primitives())
    ).rejects.toThrow(/prompt/i)
  })
})

describe('browser tasks drive the in-app browser (SOLL P24)', () => {
  it('opens the window then clicks the selector', async () => {
    const runtime = primitives()
    const result = await runWorkflowTask(
      bundle('browser.click', { selector: '#go', url: 'https://example.org' }),
      runtime
    )
    expect(runtime.browserOpen).toHaveBeenCalledWith('https://example.org')
    expect(runtime.browserClick).toHaveBeenCalledWith('#go', 'https://example.org')
    expect(result).toMatchObject({ ok: true, clicked: '#go' })
  })

  it('reads element text via the browser', async () => {
    const runtime = primitives({ browserRead: vi.fn(async () => ({ ok: true, text: 'headline', truncated: false })) })
    const result = await runWorkflowTask(bundle('browser.read', { selector: 'h1' }), runtime)
    expect(runtime.browserRead).toHaveBeenCalledWith('h1', undefined)
    expect(result).toMatchObject({ ok: true, text: 'headline' })
  })

  it('browser.click requires a selector', async () => {
    await expect(runWorkflowTask(bundle('browser.click', {}), primitives())).rejects.toThrow(/selector/i)
  })
})

describe('filesystem tasks (SOLL P15b)', () => {
  it('reads a confined file', async () => {
    const runtime = primitives()
    const result = await runWorkflowTask(bundle('file.read', { path: 'notes/a.txt' }), runtime)
    expect(runtime.fileRead).toHaveBeenCalledWith('notes/a.txt')
    expect(result).toMatchObject({ ok: true, content: 'hello', bytes: 5 })
  })

  it('writes a confined file', async () => {
    const runtime = primitives()
    const result = await runWorkflowTask(bundle('file.write', { path: 'out.txt', content: 'hi' }), runtime)
    expect(runtime.fileWrite).toHaveBeenCalledWith('out.txt', 'hi')
    expect(result).toMatchObject({ ok: true })
  })

  it('file.read requires a path', async () => {
    await expect(runWorkflowTask(bundle('file.read', {}), primitives())).rejects.toThrow(/path/i)
  })
})

describe('local runtime tasks (SOLL P15b)', () => {
  it('runs python code', async () => {
    const runtime = primitives({
      runScript: vi.fn(async () => ({ ok: true, code: 0, stdout: '42', stderr: '', timed_out: false })),
    })
    const result = await runWorkflowTask(bundle('python.run', { code: 'print(42)', timeout_seconds: 10 }), runtime)
    expect(runtime.runScript).toHaveBeenCalledWith('python', 'print(42)', 10)
    expect(result).toMatchObject({ ok: true, stdout: '42', timed_out: false })
  })

  it('maps node.run to the node runtime', async () => {
    const runtime = primitives()
    await runWorkflowTask(bundle('node.run', { code: 'console.log(1)' }), runtime)
    expect(runtime.runScript).toHaveBeenCalledWith('node', 'console.log(1)', undefined)
  })

  it('python.run requires code', async () => {
    await expect(runWorkflowTask(bundle('python.run', {}), primitives())).rejects.toThrow(/code/i)
  })
})

describe('unknown tasks fail honestly', () => {
  it('throws for an unknown task key', async () => {
    await expect(runWorkflowTask(bundle('shell.rm_rf'), primitives())).rejects.toThrow(/Unsupported/)
  })
})

describe('real workflow inference inputs', () => {
  it('passes resolved top-level binding values as model data without granting tools', async () => {
    const runLlm = vi.fn(async () => ({ ok: true, text: 'Antwort' }))
    const runtime = { ...primitives(), runLlm }
    await runWorkflowTask(
      bundle('llm', {
        instruction: 'Fasse zusammen',
        context: ['Memory evidence'],
        output_format: 'text',
        timeout_seconds: 45,
      }),
      runtime
    )
    expect(runLlm).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: 'Fasse zusammen',
        timeout_seconds: 45,
        input_bindings: { context: ['Memory evidence'] },
      })
    )
  })
})
