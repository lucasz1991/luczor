import { invoke } from '@tauri-apps/api/core'
import { executionGate, invokeGuarded } from '@/services/executionGate'
import { runAgent } from '@/services/agent'
import { listTools } from '@/services/tools/registry'
import type { ThinkingTier } from '@/services/inference/thinking'
import type { WireMessage } from '@/services/inference/types'
import { withRunResources } from '@/services/runs/resourceCoordinator'
import { executeDeviceProfile } from '@/services/deviceJobs'
import { binaryRequest, decodeBase64, sha256 } from './binaryTransport'
import type { CoordinatedExecutor } from './channel'

export const executeCoordinatedJob: CoordinatedExecutor = async (job, account, ticket, progress, beforeEffect) => {
  const assert = () => executionGate.assert(ticket)
  assert()
  const payload = job.payload
  if (job.tool_profile === 'chat.turn') {
    const allowed = new Set(Array.isArray(payload.tool_allowlist) ? payload.tool_allowlist.map(String) : [])
    // A remote chat cannot amplify its own delegation authority or silently expand its tools.
    const disabledTools = listTools()
      .filter(tool => !allowed.has(tool.name) || tool.name.startsWith('device_'))
      .map(tool => tool.name)
    const history = (Array.isArray(payload.history) ? payload.history : []) as Array<{
      role: 'user' | 'assistant'
      content: string
    }>
    const messages: WireMessage[] = history.map(item => ({ role: item.role, content: item.content }))
    messages.push({ role: 'user', content: String(payload.prompt ?? '') })
    const external = payload.model_mode === 'external' || payload.model_mode === 'local_external'
    let lastProgress = 0
    const result = await runAgent({
      projectId: ticket.scope!.projectId,
      conversationId: job.conversation_id ?? undefined,
      runId: job.id,
      execution: ticket,
      signal: ticket.signal,
      beforeToolExecution: beforeEffect,
      principalScopeId: account.principalId,
      baseMessages: messages,
      externalBaseMessages: messages,
      mode: executionGate.snapshot().mode,
      contextEgress: external ? 'external_allowed' : 'local_only',
      routingSettings: {
        preference: payload.model_mode === 'external' ? 'force_external' : external ? 'allow_external' : 'local_only',
      },
      thinkingTier: (payload.thinking_tier as ThinkingTier | undefined) ?? 'balanced',
      disabledTools,
      agentMode: false,
      requestExternalApproval: () => external,
      toolSession: {
        queue: () => {},
        update: () => {},
        approve: async () => {
          assert()
          return true
        },
      },
      onRoundComplete: event => {
        void progress(event.content.slice(0, 4000)).catch(() => {})
      },
      onProgress: event => {
        if (Date.now() - lastProgress < 2000) return
        lastProgress = Date.now()
        const phase = {
          routing: 'Modell vorbereiten',
          thinking: 'Antwort vorbereiten',
          regenerating: 'Antwort wird neu erstellt',
          receiving: 'Antwort wird geschrieben',
          tools: 'Werkzeuge ausführen',
        }[event.phase]
        void progress(`${phase}${event.round ? ` · Runde ${event.round}` : ''}`).catch(() => {})
      },
    })
    assert()
    return {
      ok: !result.continuation,
      answer: result.finalText,
      model: result.model,
      tokenUsage: result.tokenUsage,
      toolSuccesses: result.toolSuccesses,
      toolFailures: result.toolFailures,
      continuation_required: !!result.continuation,
    }
  }
  const keys = job.tool_profile.startsWith('desktop.') ? ['desktop'] : []
  return withRunResources(keys, ticket.signal, async () => {
    assert()
    await beforeEffect()
    if (job.tool_profile === 'desktop.observe')
      return invokeGuarded<Record<string, unknown>>(
        'desktop_observe',
        { windowId: payload.window_id ?? null },
        ticket,
        false
      )
    if (job.tool_profile === 'desktop.capture_screen') {
      const shot = await invoke<{ base64: string; mime?: string; width: number; height: number }>('capture_screen')
      assert()
      const bytes = decodeBase64(shot.base64)
      const hash = await sha256(bytes)
      await binaryRequest(account.config, `/coordination/jobs/${job.id}/artifacts/${hash}`, bytes, ticket.signal)
      assert()
      return {
        ok: true,
        width: shot.width,
        height: shot.height,
        artifact: {
          sha256: hash,
          mime: shot.mime ?? 'image/png',
          path: `/coordination/jobs/${job.id}/artifacts/${hash}`,
          bytes: bytes.length,
        },
      }
    }
    if (job.tool_profile === 'desktop.windows.list') return { ok: true, windows: await invoke('list_windows') }
    if (job.tool_profile === 'desktop.clipboard.read')
      return { ok: true, text: (await invoke<string>('read_clipboard')).slice(0, 60000) }
    return executeDeviceProfile(job, ticket, assert, account.config)
  })
}
