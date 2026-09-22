import type { WireMessage, WireToolCall } from '@/services/inference/types'

/** A checkpoint can be taken between calls in one assistant tool batch. Complete
 * the wire protocol without inventing a success or executing any saved call.
 * The checkpoint itself stays untouched; callers resume this complete copy.
 */
export function resumeCheckpointMessages(source: readonly WireMessage[]): WireMessage[] {
  const messages: WireMessage[] = []
  let pending: WireToolCall[] = []
  const close = () => {
    for (const call of pending)
      messages.push({
        role: 'tool',
        name: call.function.name,
        tool_call_id: call.id,
        content: JSON.stringify({
          ok: false,
          code: 'checkpoint_outcome_unknown',
          executed: 'unknown',
          error:
            'Zum gespeicherten Werkzeugaufruf liegt kein bestätigtes Ergebnis vor. Zuerst ausschließlich lesend prüfen; eine mögliche Änderung nicht blind wiederholen.',
        }),
      })
    pending = []
  }
  for (const message of source) {
    if (message.role !== 'tool') close()
    messages.push(structuredClone(message))
    if (message.role === 'assistant') pending = [...(message.tool_calls ?? [])]
    if (message.role === 'tool') pending = pending.filter(call => call.id !== message.tool_call_id)
  }
  close()
  return messages
}

/** Historic calls without a receipt cannot be retried under a new call ID. */
export function unresolvedCheckpointCalls(source: readonly WireMessage[]): WireToolCall[] {
  const pending = new Map<string, WireToolCall>()
  for (const message of source) {
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) pending.set(call.id, call)
    if (message.role === 'tool') {
      try {
        if (JSON.parse(message.content)?.code === 'checkpoint_outcome_unknown') continue
      } catch {
        /* A textual receipt is still a recorded result. */
      }
      pending.delete(message.tool_call_id)
    }
  }
  return [...pending.values()]
}

/** Refresh only host-provided retrieval material. This cannot replace task text,
 * retained tool evidence or turn arbitrary caller prose into a system prompt.
 */
export function refreshContinuationContext(messages: WireMessage[], context: string): void {
  // Broker records are one JSON line each. Marker text inside a JSON string is
  // data; only complete framing lines can open/close the host-owned envelope.
  const envelope = /^\[LUCZOR-SCOPE-KONTEXT\]\r?\n[\s\S]*?^\[LUCZOR-SCOPE-KONTEXT-END\]\r?$/gmu
  const block = context.match(envelope)?.[0] ?? ''
  if (!block && context.trim()) return
  let replaced = false
  for (const message of messages) {
    if (message.role !== 'system') continue
    message.content = message.content.replace(envelope, () => {
      if (replaced) return ''
      replaced = true
      return block
    })
  }
  if (!replaced && block) messages.unshift({ role: 'system', content: block })
}
