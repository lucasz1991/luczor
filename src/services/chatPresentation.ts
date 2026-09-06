import type { WireMessage } from './openrouter.service'

/** Pure presentation helpers shared by the chat shell and its child views. */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function safeTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Keep policy and bounded project context in one template-safe system turn. */
export function composeProviderSystemPrompt(preamble: string, providerContext: string): string {
  return [preamble.trim(), providerContext.trim()].filter(Boolean).join('\n\n')
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

/**
 * Convert UI chat events into an alternating provider transcript. Static
 * greetings and local error/status messages can precede the first real user
 * turn or occur consecutively; they are presentation state, not valid model
 * turns. Consecutive messages from the same role are combined without losing
 * their visible text.
 */
export function normalizeConversationHistory(messages: WireMessage[]): WireMessage[] {
  const normalized: WireMessage[] = []

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const content = String(message.content ?? '').trim()
    if (!content) continue
    if (
      message.role === 'assistant' &&
      (content === 'Willkommen. Was ist das Ziel dieses Projekts?' ||
        content === 'Neuer Chat. Was ist das Ziel?' ||
        content.startsWith('[Fehler]') ||
        content.startsWith('Mikrofon-Fehler:') ||
        content.startsWith('Zuhören fehlgeschlagen:'))
    ) {
      continue
    }
    if (normalized.length === 0 && message.role === 'assistant') continue

    const previous = normalized[normalized.length - 1]
    if (previous?.role === message.role && 'content' in previous) {
      previous.content = `${String(previous.content).trim()}\n\n${content}`
      continue
    }
    normalized.push({ role: message.role, content })
  }

  return normalized
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
