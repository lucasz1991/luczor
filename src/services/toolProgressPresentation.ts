import { presentToolCall } from './chatActivity'
import { previewToolArguments } from './chatPresentation'
import { redactProviderSecrets } from './prompt/promptContextAssembler'
import type { PendingToolCall } from '@/state/types'

const REQUEST_LIMIT = 4_000
const RESPONSE_LIMIT = 8_000

function bounded(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (${(text.length - limit).toLocaleString('de-DE')} Zeichen gekürzt)`
    : text
}

/** A local UI preview only: never injected into prompts, speech, sync or telemetry. */
export function presentLocalToolResult(call: PendingToolCall) {
  const step = presentToolCall(call)
  // The request is known from the moment the call is proposed — show it even while it's pending.
  const request = bounded(redactProviderSecrets(previewToolArguments(call.args, REQUEST_LIMIT + 200)), REQUEST_LIMIT)
  if (!call.result || !['executed', 'failed'].includes(call.status)) return { ...step, request }
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
    request,
    response:
      bounded(redacted, RESPONSE_LIMIT) ||
      (call.result.ok ? 'Erfolgreich abgeschlossen.' : 'Ausführung fehlgeschlagen.'),
    responseOk: call.result.ok,
    detail: [
      call.dataHandling === 'ephemeral' ? 'Temporäres lokales Zwischenergebnis' : 'Zwischenergebnis',
      preview || (call.result.ok ? 'Erfolgreich abgeschlossen.' : 'Ausführung fehlgeschlagen.'),
    ].join('\n'),
  }
}
