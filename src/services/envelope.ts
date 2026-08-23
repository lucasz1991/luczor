// src/services/envelope.ts
//
// Parser for the Luczor answer envelope: { summary, question, bullets }.
//
// The preset model streams this JSON as its message content. We parse it
// PROGRESSIVELY so the summary text can render live (token by token) without
// ever showing raw JSON braces to the user, and so bullets appear as soon as
// their array closes.

export type LuczorEnvelope = {
  summary: string
  question: string
  bullets: string[]
  /** true once the whole JSON object parsed cleanly. */
  complete: boolean
}

function stripFences(t: string): string {
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return m?.[1] ? m[1].trim() : t
}

function normalize(o: any): { summary: string; question: string; bullets: string[] } {
  const summary = typeof o?.summary === 'string' ? o.summary : typeof o?.content === 'string' ? o.content : ''
  const question = typeof o?.question === 'string' ? o.question : ''
  const bullets = Array.isArray(o?.bullets)
    ? o.bullets
        .filter((x: any) => typeof x === 'string')
        .map((x: string) => x.trim())
        .filter(Boolean)
    : []
  return { summary: summary.trim(), question: question.trim(), bullets }
}

function tryFull(t: string): { summary: string; question: string; bullets: string[] } | null {
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) return null
  const slice = t.slice(first, last + 1)
  try {
    return normalize(JSON.parse(slice))
  } catch {
    try {
      const repaired = slice.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
      return normalize(JSON.parse(repaired))
    } catch {
      return null
    }
  }
}

const UNESCAPE: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  '\\': '\\',
  '/': '/',
}

/** Extract a (possibly still-streaming, truncated) JSON string field value. */
function extractStringField(t: string, key: 'summary' | 'question'): string | null {
  const re = key === 'summary' ? /"summary"\s*:\s*"/ : /"question"\s*:\s*"/
  const m = re.exec(t)
  if (!m) return null

  let out = ''
  let esc = false
  for (let i = m.index + m[0].length; i < t.length; i++) {
    const c = t[i]!
    if (esc) {
      out += UNESCAPE[c] ?? c
      esc = false
      continue
    }
    if (c === '\\') {
      esc = true
      continue
    }
    if (c === '"') return out // closed string
    out += c
  }
  return out // truncated mid-stream -> partial value
}

/** Extract bullets only once the array has fully closed. */
function extractBullets(t: string): string[] {
  const m = /"bullets"\s*:\s*\[/.exec(t)
  if (!m) return []
  const start = m.index + m[0].length - 1 // index of '['

  let depth = 0
  let inStr = false
  let esc = false
  for (let j = start; j < t.length; j++) {
    const c = t[j]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) {
        try {
          const arr = JSON.parse(t.slice(start, j + 1))
          return Array.isArray(arr)
            ? arr
                .filter(x => typeof x === 'string')
                .map(x => x.trim())
                .filter(Boolean)
            : []
        } catch {
          return []
        }
      }
    }
  }
  return []
}

export function looksLikeEnvelope(text: string): boolean {
  const t = (text ?? '').trim()
  return t.startsWith('{') || t.includes('"summary"') || t.includes('"question"') || t.includes('"bullets"')
}

/**
 * Parse the envelope from arbitrary (possibly partial) model text.
 * Returns null if the text is plain (non-envelope) or empty.
 */
export function parseEnvelope(text: string): LuczorEnvelope | null {
  const t = stripFences((text ?? '').trim())
  if (!t) return null

  const full = tryFull(t)
  if (full) return { ...full, complete: true }

  if (!looksLikeEnvelope(t)) return null

  const summary = extractStringField(t, 'summary') ?? ''
  const question = extractStringField(t, 'question') ?? ''
  const bullets = extractBullets(t)

  if (!summary && !question && !bullets.length) return null
  return { summary: summary.trim(), question: question.trim(), bullets, complete: false }
}
