export type PreparedSpokenText = {
  text: string
  /** UTF-16 offsets in the original source, including the final boundary. */
  sourcePositions: number[]
}

const SYMBOL_WORDS = new Map<string, string>([
  ['%', 'Prozent'],
  ['‰', 'Promille'],
  ['&', 'und'],
  ['+', 'plus'],
  ['=', 'gleich'],
  ['≠', 'ungleich'],
  ['≈', 'ungefähr'],
  ['≤', 'kleiner oder gleich'],
  ['≥', 'größer oder gleich'],
  ['<', 'kleiner als'],
  ['>', 'größer als'],
  ['€', 'Euro'],
  ['$', 'Dollar'],
  ['£', 'Pfund'],
  ['¥', 'Yen'],
  ['°', 'Grad'],
  ['@', 'ät'],
  ['−', 'minus'],
  ['×', 'mal'],
  ['÷', 'geteilt durch'],
  ['→', 'nach'],
  ['⇒', 'nach'],
  ['⟶', 'nach'],
  ['➜', 'nach'],
  ['➡', 'nach'],
  ['←', 'zurück nach'],
  ['⇐', 'zurück nach'],
  ['↔', 'und umgekehrt'],
  ['⇔', 'und umgekehrt'],
  ['✅', 'erledigt'],
  ['☑', 'erledigt'],
  ['✔', 'erledigt'],
  ['✓', 'erledigt'],
  ['❌', 'Fehler'],
  ['❎', 'Fehler'],
  ['✖', 'Fehler'],
  ['⚠', 'Achtung'],
  ['ℹ', 'Information'],
  ['🔄', 'wird bearbeitet'],
  ['⏳', 'läuft'],
  ['∞', 'unendlich'],
])

const FENCE = /^\s*(`{3,}|~{3,})\s*[A-Za-z0-9_+#.-]*\s*$/u
const MARKDOWN_ESCAPE = /[\\`*{}[\]()#+\-.!_>~|]/u

function isTableSeparator(line: string): boolean {
  const cells = line
    .trim()
    .replace(/^\||\|$/gu, '')
    .split('|')
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/u.test(cell.trim()))
}

/**
 * Prepare speech without ever changing the displayed Markdown. Expanded words
 * point to the symbol that produced them, so playback can highlight the source.
 * Unknown symbols and literal code are retained rather than silently discarded.
 */
export function prepareSpokenText(source: string, sourceOffset = 0): PreparedSpokenText {
  const output: string[] = []
  const positions: number[] = []

  function append(text: string, at: number): void {
    for (let index = 0; index < text.length; index++) {
      output.push(text.charAt(index))
      positions.push(sourceOffset + at)
    }
  }

  function say(words: string, at: number): void {
    append(` ${words} `, at)
  }

  function literal(start: number, end: number): void {
    for (let index = start; index < end;) {
      const temperature = /^°\s*([CF])\b/u.exec(source.slice(index, Math.min(end, index + 8)))
      if (temperature) {
        say(temperature[1] === 'C' ? 'Grad Celsius' : 'Grad Fahrenheit', index)
        index += temperature[0].length
        continue
      }
      const point = source.codePointAt(index)!
      const character = String.fromCodePoint(point)
      const words = SYMBOL_WORDS.get(character)
      if (words) {
        say(words, index)
        index += character.length
        if (source.charAt(index) === '\uFE0F' && index < end) index++
      } else if (character === '*') {
        const multiplication =
          /\d\s*$/u.test(source.slice(Math.max(start, index - 12), index)) &&
          /^\s*\d/u.test(source.slice(index + 1, Math.min(end, index + 12)))
        say(multiplication ? 'mal' : 'Sternchen', index++)
      } else if (character === '_' || character === '#' || character === '|') {
        say(character === '_' ? 'Unterstrich' : character === '#' ? 'Raute' : 'senkrechter Strich', index++)
      } else if (
        character === '-' &&
        /^\s$/u.test(source[index - 1] ?? ' ') &&
        /^\s|\d/u.test(source[index + 1] ?? ' ')
      ) {
        say('minus', index++)
      } else {
        append(character, index)
        index += character.length
      }
    }
  }

  function inline(start: number, end: number): void {
    let index = start
    while (index < end) {
      const character = source.charAt(index)
      if (character === '\\' && MARKDOWN_ESCAPE.test(source[index + 1] ?? '')) {
        literal(index + 1, index + 2)
        index += 2
        continue
      }
      if (character === '`') {
        let run = 1
        while (source[index + run] === '`' && index + run < end) run++
        const close = source.indexOf('`'.repeat(run), index + run)
        if (close >= 0 && close < end) {
          literal(index + run, close)
          index = close + run
          continue
        }
      }
      const labelStart = character === '[' ? index + 1 : source.startsWith('![', index) ? index + 2 : -1
      if (labelStart >= 0) {
        const labelEnd = source.indexOf(']', labelStart)
        if (labelEnd >= 0 && labelEnd < end && source[labelEnd + 1] === '(') {
          let depth = 1
          let destinationEnd = labelEnd + 2
          for (; destinationEnd < end; destinationEnd++) {
            if (source.charAt(destinationEnd) === '\\') destinationEnd++
            else if (source.charAt(destinationEnd) === '(') depth++
            else if (source.charAt(destinationEnd) === ')' && --depth === 0) break
          }
          if (depth === 0) {
            inline(labelStart, labelEnd)
            index = destinationEnd + 1
            continue
          }
        }
      }
      if (character === '<') {
        const autolink = /^<(?:https?:\/\/|mailto:)[^\s<>]+>/u.exec(source.slice(index, end))
        if (autolink) {
          literal(index + 1, index + autolink[0].length - 1)
          index += autolink[0].length
          continue
        }
      }
      let consumed = false
      for (const marker of ['***', '___', '**', '__', '~~', '*', '_']) {
        if (!source.startsWith(marker, index)) continue
        // An identifier such as file_name or an arithmetic star is not emphasis.
        if (marker.startsWith('_') && /[\p{L}\p{N}_]/u.test(source[index - 1] ?? '')) continue
        if (/\s/u.test(source[index + marker.length] ?? ' ')) continue
        const close = source.indexOf(marker, index + marker.length)
        if (close < 0 || close + marker.length > end || /\s/u.test(source[close - 1] ?? ' ')) continue
        if (marker.startsWith('_') && /[\p{L}\p{N}_]/u.test(source[close + marker.length] ?? '')) continue
        inline(index + marker.length, close)
        index = close + marker.length
        consumed = true
        break
      }
      if (consumed) continue
      // Collect ordinary text in one run, while keeping syntax detection local.
      let next = index + String.fromCodePoint(source.codePointAt(index)!).length
      while (next < end && !/[\\`[!<*_~]/u.test(source.charAt(next))) next++
      literal(index, next)
      index = next
    }
  }

  const lines = Array.from(source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)).filter(match => match[0].length > 0)
  let codeFence: string | null = null
  let table = false
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const match = lines.at(lineIndex)!
    const raw = match[0]
    const line = raw.replace(/[\r\n]+$/u, '')
    const start = match.index
    const end = start + line.length
    const fence = FENCE.exec(line)
    if (fence && (!codeFence || (fence[1]!.startsWith(codeFence[0]!) && fence[1]!.length >= codeFence.length))) {
      codeFence = codeFence ? null : fence[1]!
      table = false
    } else if (codeFence) {
      literal(start, end)
    } else if (isTableSeparator(line) && table) {
      // Column alignment is formatting only.
    } else if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      table = false
    } else {
      if (!line.trim()) table = false
      const nextLine = (lines[lineIndex + 1]?.[0] ?? '').replace(/[\r\n]+$/u, '')
      if (line.includes('|') && isTableSeparator(nextLine)) table = true
      if (table && line.includes('|')) {
        let cellStart = start
        for (let cursor = start; cursor <= end; cursor++) {
          if (cursor !== end && source.charAt(cursor) !== '|') continue
          if (source.slice(cellStart, cursor).trim()) {
            inline(cellStart, cursor)
            if (
              cursor < end &&
              source
                .slice(cursor + 1, end)
                .replace(/\|/gu, '')
                .trim()
            )
              append(', ', cursor)
          }
          cellStart = cursor + 1
        }
      } else {
        table = false
        let quoteLength = 0
        let quote = /^\s{0,3}>\s?/u.exec(line)
        while (quote) {
          quoteLength += quote[0].length
          quote = /^\s{0,3}>\s?/u.exec(line.slice(quoteLength))
        }
        const marker = /^(?:\s{0,3}#{1,6}\s+|\s*[-*+]\s+)/u.exec(line.slice(quoteLength))?.[0] ?? ''
        const prefix = line.slice(0, quoteLength) + marker
        let contentStart = start + prefix.length
        const checkbox = /^\[([ xX])\]\s+/u.exec(source.slice(contentStart, end))
        if (checkbox && /[-*+]\s+$/u.test(prefix)) {
          say(checkbox[1] === ' ' ? 'offen' : 'erledigt', contentStart)
          contentStart += checkbox[0].length
        }
        inline(contentStart, end)
      }
    }
    if (end < start + raw.length) append('\n', end)
  }

  // Keep paragraph pauses, normalize spacing introduced by spoken replacements,
  // and leave ordinary punctuation (including decimal numbers) untouched.
  const normalized: string[] = []
  const mapped: number[] = []
  for (let index = 0; index < output.length; index++) {
    const character = output.at(index)!
    if (/[^\S\n]/u.test(character)) {
      if (!normalized.length || /\s/u.test(normalized.at(-1)!)) continue
      normalized.push(' ')
    } else {
      if ((character === '\n' || /[.,;:!?)]/u.test(character)) && normalized.at(-1) === ' ') {
        normalized.pop()
        mapped.pop()
      }
      if (character === '\n' && (!normalized.length || normalized.slice(-2).join('') === '\n\n')) continue
      normalized.push(character)
    }
    mapped.push(positions.at(index)!)
  }
  while (normalized.length && /\s/u.test(normalized.at(-1)!)) {
    normalized.pop()
    mapped.pop()
  }
  mapped.push(sourceOffset + source.length)
  return { text: normalized.join(''), sourcePositions: mapped }
}
