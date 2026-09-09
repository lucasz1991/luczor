import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { query, type Options, type HookCallback, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const
export const WRITE_TOOLS = [...READ_TOOLS, 'Write', 'Edit', 'NotebookEdit', 'Bash'] as const
export type WorkerInput = {
  type: 'start'
  token: string
  model: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  prompt: string
  cwd: string
  permission: 'read-only' | 'workspace-write'
  maxTurns: number
  maxBudgetUsd?: number
}
type Gate = (tool: string, input: unknown, signal: AbortSignal) => Promise<boolean>

/** Blocking hook callbacks are mandatory even for tools the SDK otherwise auto-approves. */
export function workerOptions(
  input: WorkerInput,
  gate: Gate,
  abortController: AbortController,
  cliPath: string,
  report: (event: Record<string, unknown>) => void = () => {}
): Options {
  const tools = input.permission === 'workspace-write' ? [...WRITE_TOOLS] : [...READ_TOOLS]
  const preTool: HookCallback = async (event, _toolUseId, context) => {
    if (event.hook_event_name !== 'PreToolUse') return {}
    if (event.effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(event.effort.level))
      report({ type: 'effort', level: event.effort.level })
    const permitted =
      !abortController.signal.aborted &&
      tools.includes(event.tool_name as (typeof tools)[number]) &&
      (await gate(event.tool_name, event.tool_input, context.signal))
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: permitted && !abortController.signal.aborted && !context.signal.aborted ? 'allow' : 'deny',
        permissionDecisionReason: 'Luczor-Auftragsfreigabe',
      },
    }
  }
  const env: Record<string, string | undefined> = { ...process.env }
  // Ignore global effort/model substitutions; preserve the user's own authentication without exposing it.
  for (const key of [
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_EXTRA_BODY',
    'NODE_OPTIONS',
    'NODE_PATH',
  ])
    delete env[key]
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(
    existsSync
  )
  if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash
  return {
    cwd: input.cwd,
    model: input.model === 'default' ? undefined : input.model,
    effort: input.effort ?? undefined,
    tools,
    allowedTools: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    hooks: { PreToolUse: [{ hooks: [preTool], timeout: 30 }] },
    canUseTool: async (name, toolInput, context) => {
      const allow =
        !abortController.signal.aborted &&
        tools.includes(name as (typeof tools)[number]) &&
        (await gate(name, toolInput, context.signal))
      return allow && !abortController.signal.aborted && !context.signal.aborted
        ? { behavior: 'allow', updatedInput: toolInput }
        : { behavior: 'deny', message: 'Luczor-Auftragsfreigabe nicht mehr gültig.' }
    },
    abortController,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    persistSession: false,
    includePartialMessages: true,
    forwardSubagentText: false,
    pathToClaudeCodeExecutable: cliPath,
    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd ?? undefined,
    env,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append:
        'Du arbeitest als verwalteter Luczor-Agent direkt auf Windows mit Benutzerrechten. Der Projektordner ist keine Dateisandbox. Bleibe beim freigegebenen Auftrag. Starte keine dauerhaften Hintergrunddienste, zusätzlichen Agenten oder Zeitpläne. Berichte nur öffentliche Ergebnisse, ausgeführte Prüfungen und verbleibende Grenzen.',
    },
  }
}

/** Never forward thinking blocks, raw tool bodies, credentials, or arbitrary SDK diagnostics. */
export function publicWorkerEvent(message: SDKMessage): Record<string, unknown> | undefined {
  if (message.type === 'system' && message.subtype === 'init') return { type: 'model', model: message.model }
  if (
    message.type === 'stream_event' &&
    message.event.type === 'content_block_delta' &&
    message.event.delta.type === 'text_delta'
  )
    return { type: 'text', text: message.event.delta.text }
  if (message.type === 'result')
    return {
      type: 'result',
      ok: message.subtype === 'success' && !message.is_error,
      text: message.subtype === 'success' ? message.result : '',
      code: message.subtype,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        costUsd: message.total_cost_usd,
      },
    }
  return undefined
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const abort = new AbortController()
  const pending = new Map<string, { resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> }>()
  let started = false
  let token = ''
  const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ...event, token }) + '\n')
  const stop = () => {
    abort.abort()
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.resolve(false)
    }
    pending.clear()
  }
  process.once('SIGTERM', stop)
  lines.once('close', stop)
  const gate: Gate = async (tool, input, signal) => {
    if (abort.signal.aborted || signal.aborted || pending.size >= 32) return false
    const serialized = JSON.stringify(input)
    if (!serialized || serialized.length > 100_000) return false
    const id = randomUUID()
    return new Promise(resolve => {
      const finish = (allowed: boolean) => {
        const current = pending.get(id)
        if (!current) return
        clearTimeout(current.timer)
        pending.delete(id)
        signal.removeEventListener('abort', cancel)
        resolve(allowed && !abort.signal.aborted && !signal.aborted)
      }
      const cancel = () => finish(false)
      const timer = setTimeout(cancel, 25_000)
      pending.set(id, { resolve: finish, timer })
      signal.addEventListener('abort', cancel, { once: true })
      emit({ type: 'gate', id, tool })
    })
  }
  for await (const line of lines) {
    if (line.length > 250_000) {
      stop()
      break
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line)
    } catch {
      stop()
      break
    }
    if (!started) {
      started = true
      const input = message as unknown as WorkerInput
      if (
        input.type !== 'start' ||
        typeof input.token !== 'string' ||
        typeof input.prompt !== 'string' ||
        typeof input.model !== 'string'
      ) {
        stop()
        break
      }
      token = input.token
      void (async () => {
        let running: ReturnType<typeof query> | undefined
        try {
          const cli = join(dirname(fileURLToPath(import.meta.url)), 'claude.exe')
          running = query({ prompt: input.prompt, options: workerOptions(input, gate, abort, cli, emit) })
          for await (const message of running) {
            if (abort.signal.aborted) break
            const event = publicWorkerEvent(message)
            if (event) emit(event)
          }
        } catch {
          emit({ type: 'failure', code: abort.signal.aborted ? 'cancelled' : 'claude_execution_failed' })
        } finally {
          running?.close()
          stop()
          lines.close()
        }
      })()
    } else if (message.token === token && message.type === 'gate_result' && typeof message.id === 'string') {
      pending.get(message.id)?.resolve(message.allowed === true)
    } else if (message.token === token && message.type === 'cancel') stop()
    else {
      stop()
      break
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
