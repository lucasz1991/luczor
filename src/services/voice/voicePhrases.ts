// Exact normalized token matching. Only the product name has a fixed STT alias
// vocabulary; unrelated words never receive edit-distance/fuzzy matching.
const LUCZOR_SINGLE_ALIASES = new Set(['luczor', 'luxor', 'lucor', 'lutzor', 'lukzor', 'luksor', 'luczer', 'luxua'])

type Token = { normalized: string; start: number; end: number }
export type VoicePhraseMatch = { start: number; end: number; matched: string }

function tokenAt(words: Token[], index: number): Token | undefined {
  return words.slice(index, index + 1)[0]
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('de-DE').normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss')
}

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map(match => ({
    normalized: normalize(match[0]),
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function phraseTokens(phrase: string): string[] {
  const words = tokens(phrase)
  const result: string[] = []
  for (let index = 0; index < words.length; index++) {
    const word = tokenAt(words, index)!.normalized
    if (LUCZOR_SINGLE_ALIASES.has(word)) result.push('luczor')
    else if (word === 'lutz' && tokenAt(words, index + 1)?.normalized === 'or') {
      result.push('luczor')
      index++
    } else result.push(word)
  }
  return result
}

/** Canonical control identity, also used to reject equivalent wake/close settings. */
export function normalizeVoiceControlPhrase(phrase: string): string {
  return phraseTokens(phrase).join(' ')
}

/** Match from a token boundary, including an unfinished phrase at end of text. */
function matchAt(words: Token[], start: number, phrase: string[]): { end: number; complete: boolean } | null {
  let cursor = start
  for (const expected of phrase) {
    const word = tokenAt(words, cursor)?.normalized
    if (word === undefined) return { end: cursor, complete: false }
    if (expected === 'luczor') {
      if (LUCZOR_SINGLE_ALIASES.has(word)) cursor++
      else if (word === 'lutz') {
        const next = tokenAt(words, cursor + 1)?.normalized
        if (next === undefined) return { end: cursor + 1, complete: false }
        if (next !== 'or') return null
        cursor += 2
      } else return null
    } else {
      if (word !== expected) return null
      cursor++
    }
  }
  return { end: cursor, complete: true }
}

export function findVoicePhrase(text: string, phrase: string): VoicePhraseMatch | null {
  const candidate = phraseTokens(phrase)
  if (!candidate.length) return null
  const words = tokens(text)
  for (let start = 0; start < words.length; start++) {
    const match = matchAt(words, start, candidate)
    if (!match?.complete) continue
    return {
      start: tokenAt(words, start)!.start,
      end: tokenAt(words, match.end - 1)!.end,
      matched: words
        .slice(start, match.end)
        .map(word => word.normalized)
        .join(' '),
    }
  }
  return null
}

export function findWakeWord(text: string, wakeWord = 'luczor'): VoicePhraseMatch | null {
  return findVoicePhrase(text, wakeWord)
}

export function splitOnVoicePhrase(text: string, phrase: string): { before: string; after: string } | null {
  const match = findVoicePhrase(text, phrase)
  return match
    ? {
        before: text.slice(0, match.start).trim(),
        after: text
          .slice(match.end)
          .replace(/^[\s,.:;!?–—-]+/u, '')
          .trim(),
      }
    : null
}

/** Keep only a trailing, incomplete control phrase for the next final segment. */
export function pendingVoicePhraseSuffix(text: string, phrase: string): { before: string; pending: string } {
  const candidate = phraseTokens(phrase)
  const words = tokens(text)
  if (candidate.length) {
    // Each configured token consumes at most two transcript tokens ("lutz or").
    for (let start = Math.max(0, words.length - candidate.length * 2); start < words.length; start++) {
      const match = matchAt(words, start, candidate)
      if (match && !match.complete && match.end === words.length) {
        return {
          before: text.slice(0, tokenAt(words, start)!.start).trim(),
          pending: text.slice(tokenAt(words, start)!.start).trim(),
        }
      }
    }
  }
  return { before: text.trim(), pending: '' }
}
