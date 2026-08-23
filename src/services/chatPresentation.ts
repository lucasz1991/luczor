import type { WireMessage } from './openrouter.service'

/** Pure presentation helpers shared by the chat shell and its child views. */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function safeTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Keep the newest complete messages within the inexpensive client-side token
 * estimate. The newest message is always retained, even when it alone exceeds
 * the budget, so a user turn can never disappear from the provider request.
 */
export function compactHistory(messages: WireMessage[], maxTokens: number): WireMessage[] {
  let used = 0
  const selected: WireMessage[] = []

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue

    const content = 'content' in message ? String(message.content ?? '') : ''
    const estimatedTokens = Math.max(1, Math.ceil(content.length / 4))
    if (selected.length > 0 && used + estimatedTokens > maxTokens) break

    selected.unshift(message)
    used += estimatedTokens
  }

  return selected
}

export function formatChatTime(timestamp: number, seconds = false): string {
  return new Date(timestamp).toLocaleTimeString(
    [],
    seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' }
  )
}

export function goalStatusLabel(status: string): string {
  switch (status) {
    case 'done':
      return 'Done'
    case 'in_progress':
      return 'In Arbeit'
    case 'blocked':
      return 'Blockiert'
    default:
      return 'Offen'
  }
}

export function previewToolArguments(args: Record<string, unknown>, maxLength = 400): string {
  try {
    const serialized = JSON.stringify(args, null, 1)
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized
  } catch {
    return ''
  }
}
