import { publicAnswerText } from './publicAnswerStream'

/** Decode public answer fields while their JSON strings are still arriving. */
export type LuczorEnvelope = {
  summary: string
  question: string
  bullets: string[]
  complete: boolean
}

const ANSWER_FIELDS = ['summary', 'content', 'answer', 'message']
const PUBLIC_FIELDS = [...ANSWER_FIELDS, 'question', 'bullets']
// These identify a protocol object, but their values are never user-facing.
const PRIVATE_FIELDS = ['analysis', 'reasoning', 'thinking', 'tool_calls', 'function_call', 'arguments']
const ENVELOPE_FIELDS = [...PUBLIC_FIELDS, ...PRIVATE_FIELDS]
const ESCAPES = new Map(Object.entries({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }))

function stripFences(text: string): string {
  return text
    .trimStart()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\s*```\s*$/, '')
}

function stableUnicode(text: string): string {
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text
}

/** Incomplete escapes stay buffered; decoded text never flashes as `u00e4`. */
function readString(text: string, start: number): { value: string; end: number; complete: boolean } {
  let value = ''
  let index = start + 1
  while (index < text.length) {
    const char = text.charAt(index++)
    if (char === '"') return { value: stableUnicode(value), end: index, complete: true }
    if (char !== '\\') {
      value += char
      continue
    }
    const escape = text.charAt(index++)
    if (!escape) break
    if (escape === 'u') {
      const hex = text.slice(index, index + 4)
      if (!/^[0-9a-f]{4}$/i.test(hex)) break
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 4
    } else if (ESCAPES.has(escape)) {
      value += ESCAPES.get(escape)
    } else {
      break
    }
  }
  return { value: stableUnicode(value), end: text.length, complete: false }
}

function whitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text.charAt(index))) index++
  return index
}

/** Skip opaque values, never searching nested tool/reasoning payloads for fields. */
function skipValue(text: string, start: number): number | null {
  if (text.charAt(start) === '"') {
    const string = readString(text, start)
    return string.complete ? string.end : null
  }
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const char = text.charAt(index)
    if (char === '"') {
      const string = readString(text, index)
      if (!string.complete) return null
      index = string.end - 1
    } else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') {
      if (depth === 0) return index
      depth--
      if (depth === 0) return index + 1
    } else if (char === ',' && depth === 0) return index
  }
  return null
}

function readBullets(text: string, start: number): { values: string[]; end: number | null } {
  const values: string[] = []
  let index = whitespace(text, start + 1)
  while (index < text.length) {
    if (text.charAt(index) === ']') return { values, end: index + 1 }
    if (text.charAt(index) === '"') {
      const string = readString(text, index)
      if (string.value.trim()) values.push(string.value.trim())
      if (!string.complete) return { values, end: null }
      index = string.end
    } else {
      const end = skipValue(text, index)
      if (end === null || end === index) return { values, end: null }
      index = end
    }
    index = whitespace(text, index)
    if (text.charAt(index) === ',') index = whitespace(text, index + 1)
    else if (text.charAt(index) !== ']') return { values, end: null }
  }
  return { values, end: null }
}

export function isEnvelopeStreamPrefix(text: string): boolean {
  const candidate = stripFences(text)
  if (!candidate.startsWith('{')) return false
  const field = candidate.slice(1).trimStart()
  return !field || ENVELOPE_FIELDS.some(key => `"${key}"`.startsWith(field) || field.startsWith(`"${key}"`))
}

export function looksLikeEnvelope(text: string): boolean {
  return isEnvelopeStreamPrefix(text)
}

/** Read only root fields; a partial summary, question or bullet is immediately usable. */
export function parseEnvelope(text: string): LuczorEnvelope | null {
  const candidate = stripFences(text)
  if (!candidate.startsWith('{')) return null
  let recognized = isEnvelopeStreamPrefix(text)
  const values = new Map<string, string>()
  let bullets: string[] = []
  let index = whitespace(candidate, 1)
  let complete = false
  while (index < candidate.length) {
    if (candidate.charAt(index) === '}') {
      complete = true
      break
    }
    if (candidate.charAt(index) !== '"') break
    const key = readString(candidate, index)
    if (!key.complete) break
    if (ENVELOPE_FIELDS.includes(key.value)) recognized = true
    index = whitespace(candidate, key.end)
    if (candidate.charAt(index) !== ':') break
    index = whitespace(candidate, index + 1)
    if (PUBLIC_FIELDS.includes(key.value) && candidate.charAt(index) === '"') {
      const string = readString(candidate, index)
      values.set(key.value, string.value)
      if (!string.complete) break
      index = string.end
    } else if (key.value === 'bullets' && candidate.charAt(index) === '[') {
      const array = readBullets(candidate, index)
      bullets = array.values
      if (array.end === null) break
      index = array.end
    } else {
      const end = skipValue(candidate, index)
      if (end === null || end === index) break
      index = end
    }
    index = whitespace(candidate, index)
    if (candidate.charAt(index) === ',') index = whitespace(candidate, index + 1)
    else if (candidate.charAt(index) !== '}') break
  }
  if (!recognized) return null
  return {
    summary: (ANSWER_FIELDS.map(key => values.get(key)).find(value => value !== undefined) ?? '').trim(),
    question: (values.get('question') ?? '').trim(),
    bullets,
    complete,
  }
}

/** One presentation contract for the main chat, Mini and completed commentary. */
export function presentEnvelopeStream(raw: string, done = false) {
  const envelope = parseEnvelope(raw)
  const fencePrefix = ['`', '``', '```', '```j', '```js', '```jso', '```json'].includes(raw.trim())
  return {
    content: publicAnswerText(envelope ? envelope.summary : !done && fencePrefix ? '' : raw.trim(), done),
    question: publicAnswerText(envelope?.question ?? '', done),
    bullets: (envelope?.bullets ?? []).map(bullet => publicAnswerText(bullet, done)).filter(Boolean),
    envelope,
  }
}
