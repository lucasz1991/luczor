import type { GraphSearchHit, GraphSnippet } from './repositoryGraph'

// The broker accepts 4,000 content characters per fragment. Count JSON escaping
// as well and reserve room for its id/source/trust/sensitivity envelope.
const MAX_ENCODED_EVIDENCE_CHARS = 3_400

export type RepositoryEvidence = { content: string; relationCount: number; shortened: boolean }

/** Select complete source lines, never a silently truncated code string or path. */
export function repositoryEvidence(
  hit: GraphSearchHit,
  snippet: GraphSnippet,
  query: string
): RepositoryEvidence | undefined {
  const frame = (code: string, first: number, last: number) =>
    `Datei: ${snippet.relative_path}:${first}-${last}\nHash: ${snippet.content_hash}\n${code}`
  const fits = (value: string) => JSON.stringify(value).length <= MAX_ENCODED_EVIDENCE_CHARS
  let content = frame(snippet.content, snippet.start_line, snippet.end_line)
  let shortened = false
  if (!fits(content)) {
    shortened = true
    const lines = snippet.content.split(/\r?\n/u)
    if (lines.at(-1) === '') lines.pop()
    const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_.-]{3,}/gu) ?? [])].slice(0, 20)
    let anchor = 0
    let bestScore = 0
    lines.forEach((line, index) => {
      const lower = line.toLocaleLowerCase()
      const matches = terms.filter(term => lower.includes(term)).length
      const declaration = ['function ', 'fn ', 'class ', 'struct ', 'const ', 'def ', 'interface ', 'type '].some(
        marker => lower.includes(marker)
      )
      const score = matches * 4 + Number(matches > 0 && declaration) * 2
      if (score > bestScore) {
        anchor = index
        bestScore = score
      }
    })
    let first = anchor
    let last = anchor
    let code = lines.at(anchor) ?? ''
    const framed = (value: string, start: number, end: number) =>
      frame(value, snippet.start_line + start, snippet.start_line + end)
    // A minified line or path may itself be too large. Omit it explicitly so a
    // caller can read it through a source tool, rather than inventing an excerpt.
    if (!code || !fits(framed(code, first, last))) return undefined
    for (let previous = anchor - 1; previous >= Math.max(0, anchor - 4); previous--) {
      const prefix = lines.slice(previous, anchor).join('\n')
      if (JSON.stringify(prefix).length > 700) break
      const candidate = `${lines.at(previous)}\n${code}`
      if (!fits(framed(candidate, previous, last))) break
      first = previous
      code = candidate
    }
    for (let next = anchor + 1; next < lines.length; next++) {
      const candidate = `${code}\n${lines.at(next)}`
      if (!fits(framed(candidate, first, next))) break
      last = next
      code = candidate
    }
    content = framed(code, first, last)
  }
  let relationCount = 0
  for (const relation of hit.relations ?? []) {
    const candidate = `${content}\n${relation}`
    if (!fits(candidate)) continue
    content = candidate
    relationCount++
  }
  return { content, relationCount, shortened }
}
