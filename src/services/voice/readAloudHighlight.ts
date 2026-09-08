/** Offsets always refer to the original Markdown, never the spoken normalization. */
export type SpeechTextMatch = { chunk: number; offset: number; start: number; end: number }

/** Hide syntax that is not rendered without changing source offsets. */
function visibleSource(source: string): string {
  const chars = source.split('')
  const literal = new Uint8Array(source.length)
  const hide = (start: number, end: number) => {
    for (let index = start; index < end; index++) if (!literal.at(index)) chars.fill(' ', index, index + 1)
  }
  let fence = ''
  for (const line of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue
    const marker = /^\s*(`{3,}|~{3,})[^\r\n]*\r?\n?$/.exec(line[0])
    if (marker && (!fence || marker[1]?.startsWith(fence))) {
      hide(line.index, line.index + line[0].length)
      fence = fence ? '' : marker[1]![0]!
    } else if (fence) {
      literal.fill(1, line.index, line.index + line[0].length)
    }
  }
  for (const match of source.matchAll(/(`+)([^`]+?)\1/g)) {
    if (literal[match.index]) continue
    const start = match.index + match[1]!.length
    literal.fill(1, start, start + match[2]!.length)
  }
  // URLs may contain the same word as the next visible sentence.
  for (const match of source.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    if (literal[match.index] || !/^(?:https?:\/\/|mailto:)[^\s]+$/i.test(match[2]!)) continue
    hide(match.index, match.index + 1)
    hide(match.index + 1 + match[1]!.length, match.index + match[0].length)
  }
  for (const match of source.matchAll(
    /^\s{0,3}#{1,6}\s+|^\s*(?:[-*+]|\d{1,9}[.)])\s+|^\s{0,3}>\s?|^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm
  )) {
    hide(match.index, match.index + match[0].length)
  }
  return chars.join('')
}

/** Align existing text nodes in order; never parse, generate or replace HTML. */
export function mapSpeechTextChunks(source: string, chunks: readonly string[]): SpeechTextMatch[] {
  const visible = visibleSource(source)
  const matches: SpeechTextMatch[] = []
  let cursor = 0
  chunks.forEach((text, chunk) => {
    for (const word of text.matchAll(/\S+/gu)) {
      const start = visible.indexOf(word[0], cursor)
      if (start < 0) continue
      const end = start + word[0].length
      matches.push({ chunk, offset: word.index, start, end })
      cursor = end
    }
  })
  return matches
}

export function currentSpeechTextMatch(matches: readonly SpeechTextMatch[], position: number): SpeechTextMatch | null {
  if (!Number.isFinite(position)) return null
  return matches.find(match => match.end > position) ?? matches.at(-1) ?? null
}

const HIGHLIGHT_NAME = 'luczor-read-aloud'
let currentHighlight: Highlight | null = null

/** Paint a Range without replacing text nodes, selections, links or formatting. */
export function createReadAloudHighlight() {
  let ownedHighlight: Highlight | null = null
  return {
    show(range: Range | null) {
      this.clear()
      if (!range || typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return false
      ownedHighlight = new Highlight(range)
      currentHighlight = ownedHighlight
      CSS.highlights.set(HIGHLIGHT_NAME, ownedHighlight)
      return true
    },
    clear() {
      if (ownedHighlight && currentHighlight === ownedHighlight && typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete(HIGHLIGHT_NAME)
        currentHighlight = null
      }
      ownedHighlight = null
    },
  }
}

/** Collect content text, excluding generated code line numbers and controls. */
export function speechTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || parent.closest('button, figcaption, [aria-hidden="true"], .rt-code__lang')) continue
    if (parent.closest('.rt, .ai-code__line, .ai-answer__question')) nodes.push(node as Text)
  }
  return nodes
}
