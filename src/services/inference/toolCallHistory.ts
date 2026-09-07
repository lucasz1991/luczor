import type { WireToolCall } from './types'

export const INVALID_TOOL_ARGUMENTS =
  'Ungültige Tool-Argumente: Erwartet wird ein vollständiges JSON-Objekt. Dieser Aufruf wurde nicht ausgeführt. ' +
  'Die Argumente sind nur im Modellverlauf durch {} ersetzt, damit das Gespräch fortgesetzt werden kann. ' +
  'Erzeuge den fehlgeschlagenen Aufruf erneut mit vollständigen, zum Tool-Schema passenden Argumenten. Bereits erfolgreiche Aufrufe nicht wiederholen.'

/** Repair only the history copy. Original arguments must still fail execution validation. */
export function prepareToolCallHistory(calls: WireToolCall[]): {
  calls: WireToolCall[]
  invalidIds: Set<string>
} {
  const invalidIds = new Set<string>()
  return {
    calls: calls.map(call => {
      try {
        const args: unknown = JSON.parse(call.function.arguments)
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Not an object')
        return { ...call, function: { ...call.function } }
      } catch {
        invalidIds.add(call.id)
        return { ...call, function: { ...call.function, arguments: '{}' } }
      }
    }),
    invalidIds,
  }
}
