/** Defensive guard for providers putting known work-note prefixes in content.
 * This is not a semantic classifier: private provider channels stay excluded at transport level.
 */
const PRIVATE_PREFIXES = [
  'analysis:',
  'analysis :',
  'internal reasoning:',
  'internal reasoning :',
  'interne tool-überlegung',
  'interne arbeitsnotizen',
  'interne gedanken',
  'we need to respond',
  'we need to answer',
  'we need to set',
  'we need to use',
  'we need to check',
  'we need to call',
  'we need to determine',
  'the user says',
  'the user asks',
  'the user wants',
  'according to the system',
  'according to the developer',
  'according to system',
  'according to developer',
]
const PRIVATE_TAGS = ['think', 'analysis', 'reasoning']
const normalizedStart = (text: string) => text.trimStart().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')

export function looksLikeInternalReasoningLeak(text: string): boolean {
  const start = normalizedStart(text)
  return PRIVATE_PREFIXES.some(prefix => start.startsWith(prefix))
}

/** Only holds ambiguous marker fragments, never a complete answer/round. */
export function publicAnswerText(raw: string, complete = false): string {
  return guardedPrefix(stripReasoningBlocks(raw), complete)
}

export function stripReasoningBlocks(raw: string): string {
  let text = ''
  let position = 0
  const hidden: string[] = []
  const tags = /<\/?(think|analysis|reasoning)>/gi
  for (const match of raw.matchAll(tags)) {
    if (!hidden.length) text += raw.slice(position, match.index)
    const tag = match[1]!.toLowerCase()
    if (match[0].startsWith('</')) {
      if (hidden.at(-1) === tag) hidden.pop()
    } else {
      hidden.push(tag)
    }
    position = match.index + match[0].length
  }
  if (!hidden.length) text += raw.slice(position)
  // Withhold a split opening/closing marker so '<thi' never flashes in the UI.
  const tail = text.lastIndexOf('<')
  if (
    tail >= 0 &&
    PRIVATE_TAGS.some(tag =>
      [`<${tag}>`, `</${tag}>`].some(marker => marker.startsWith(text.slice(tail).toLowerCase()))
    )
  ) {
    text = text.slice(0, tail)
  }
  return text
}

function guardedPrefix(text: string, complete: boolean): string {
  const start = normalizedStart(text)
  if (looksLikeInternalReasoningLeak(text)) return ''
  if (!complete && start && PRIVATE_PREFIXES.some(prefix => prefix.startsWith(start))) return ''
  return text
}
