import { presentToolCall } from './chatActivity'
import { redactProviderSecrets } from './prompt/promptContextAssembler'
import type { PendingToolCall } from '@/state/types'

/** A local UI preview only: never injected into prompts, speech, sync or telemetry. */
export function presentLocalToolResult(call: PendingToolCall) {
  const step = presentToolCall(call)
  if (!call.result || !['executed', 'failed'].includes(call.status)) return step
  let result: string
  try {
    const value = call.result.ok ? call.result.output : call.result.error
    result = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
  } catch {
    result = 'Ergebnis kann nicht als Text angezeigt werden.'
  }
  const redacted = redactProviderSecrets(result)
  const preview = redacted.length > 1600 ? `${redacted.slice(0, 1600)}…` : redacted
  return {
    ...step,
    detail: [
      call.dataHandling === 'ephemeral' ? 'Temporäres lokales Zwischenergebnis' : 'Zwischenergebnis',
      preview || (call.result.ok ? 'Erfolgreich abgeschlossen.' : 'Ausführung fehlgeschlagen.'),
    ].join('\n'),
  }
}
