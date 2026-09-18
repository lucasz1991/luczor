const SECRET_KEY =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|client[_-]?secret|secret[_-]?key)$/iu

/** Transform JSON string values without reserializing numbers or editing escape
 * syntax. Secret members are replaced as whole values, including containers.
 * Undefined means plain text; callers choose their plain-text policy.
 */
export function sanitizeJsonText(text: string, sanitizeString: (value: string) => string): string | undefined {
  try {
    JSON.parse(text)
  } catch {
    return undefined
  }
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)]
  let cursor = 0
  const output: string[] = []
  const replace = (start: number, end: number, replacement: string) => {
    output.push(text.slice(cursor, start), replacement)
    cursor = end
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens.at(index)!
    if (!token[0].startsWith('"')) continue
    const decoded = JSON.parse(token[0]) as string
    const sanitized = sanitizeString(decoded)
    if (decoded !== sanitized) replace(token.index!, token.index! + token[0].length, JSON.stringify(sanitized))
    if (tokens.at(index + 1)?.[0] !== ':' || !SECRET_KEY.test(decoded)) continue
    const start = index + 2
    let end = start
    let depth = 0
    do {
      const value = tokens.at(end)![0]
      if (value === '{' || value === '[') depth++
      if (value === '}' || value === ']') depth--
      if (depth === 0) break
      end++
    } while (end < tokens.length)
    const first = tokens.at(start)!,
      last = tokens.at(end)!
    replace(first.index!, last.index! + last[0].length, '"[REDACTED]"')
    index = end
  }
  output.push(text.slice(cursor))
  return output.join('')
}
