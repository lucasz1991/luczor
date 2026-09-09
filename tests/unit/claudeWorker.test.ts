import { describe, expect, it, vi } from 'vitest'
import { publicWorkerEvent, workerOptions, type WorkerInput } from '../../scripts/claude-worker'
import type { HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const input: WorkerInput = {
  type: 'start',
  token: 'private-token',
  model: 'claude-opus-4-7',
  effort: 'high',
  prompt: 'Private prompt',
  cwd: 'E:\\project',
  permission: 'workspace-write',
  maxTurns: 8,
}
const toolEvent = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'private command' },
  session_id: 's',
  transcript_path: 'private',
  cwd: input.cwd,
  tool_use_id: 'id',
} as Parameters<HookCallback>[0]
const hook = (options: ReturnType<typeof workerOptions>) => options.hooks!.PreToolUse![0]!.hooks[0]!

describe('app-owned Claude worker contract without starting a model', () => {
  it('uses a scoped callback gate, explicit tools and no user/project settings or permission bypass', () => {
    const options = workerOptions(input, async () => true, new AbortController(), 'owned/claude.exe')
    expect(options).toMatchObject({
      model: input.model,
      effort: 'high',
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      env: expect.objectContaining({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }),
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      allowedTools: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      persistSession: false,
    })
    expect(options.tools).not.toContain('Agent')
    expect(options.tools).not.toContain('CronCreate')
    expect(options.tools).not.toContain('Skill')
    expect(options.pathToClaudeCodeExecutable).toBe('owned/claude.exe')
  })
  it('blocks SDK auto-approved tools until the synchronous gate answers and rejects approval after abort', async () => {
    let approve!: (value: boolean) => void
    const gate = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          approve = resolve
        })
    )
    const abort = new AbortController()
    const options = workerOptions(input, gate, abort, 'owned')
    let settled = false
    const result = Promise.resolve(hook(options)(toolEvent, 'id', { signal: abort.signal })).then(value => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(gate).toHaveBeenCalledOnce()
    abort.abort()
    approve(true)
    expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
  it('denies write and shell tools for read-only jobs before asking the native gate', async () => {
    const gate = vi.fn(async () => true)
    const abort = new AbortController()
    const options = workerOptions({ ...input, permission: 'read-only' }, gate, abort, 'owned')
    expect(await hook(options)(toolEvent, 'id', { signal: abort.signal })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    })
    expect(gate).not.toHaveBeenCalled()
    expect(
      await options.canUseTool!('Bash', {}, { signal: abort.signal, toolUseID: 'id' } as Parameters<
        NonNullable<typeof options.canUseTool>
      >[2])
    ).toMatchObject({ behavior: 'deny' })
  })
  it('reports only allowed measured effort metadata and strips private SDK events', async () => {
    const report = vi.fn()
    const abort = new AbortController()
    const options = workerOptions(input, async () => true, abort, 'owned', report)
    await hook(options)({ ...toolEvent, effort: { level: 'medium' } }, 'id', { signal: abort.signal })
    expect(report).toHaveBeenCalledWith({ type: 'effort', level: 'medium' })
    expect(JSON.stringify(report.mock.calls)).not.toContain('private')
    expect(
      publicWorkerEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } },
      } as SDKMessage)
    ).toBeUndefined()
    expect(
      publicWorkerEvent({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'public' } },
      } as SDKMessage)
    ).toEqual({ type: 'text', text: 'public' })
  })
})
