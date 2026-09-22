/** Deterministic local retrieval planning; no model call or remote query. */
export type RepositoryContextQuery = {
  queries: string[]
  focusQuery: string
  identifiers: string[]
  contextual: boolean
}

const STOP_WORDS = new Set(
  'aber alle alles also auch auf aus bei bitte das dass dem den der des die diese diesem diesen dieser dieses doch du ein eine einem einen einer eines er es für hat hier ich im in ist ja kann können man mehr mit muss nach nicht noch oder ohne schon sich sie sind so soll und uns vom von vor war was weil weiter weiterarbeiten wir wird wie zu zum zur the a an and are as at be by can could do for from have i if in is it its me my of on or please that this to we with would you your'.split(
    ' '
  )
)

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  return values
    .filter(value => {
      const key = value.toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
}

function identifiers(text: string): string[] {
  const extensions = new Set(
    'vue ts tsx mts cts js jsx mjs cjs php rs py java go rb sql json yaml yml toml md css html'.split(' ')
  )
  const paths = (text.match(/[\p{L}\p{N}_@./\\:-]+/gu) ?? [])
    .map(token =>
      token
        .replace(/:\d[\d-]*$/u, '')
        .replace(/[.,:]+$/u, '')
        .replaceAll('\\', '/')
    )
    .filter(
      token => token.length <= 2_048 && extensions.has(token.slice(token.lastIndexOf('.') + 1).toLocaleLowerCase())
    )
  const symbols = (text.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? []).filter(
    token => token.length <= 120 && (/[a-z][A-Z]/u.test(token) || /[A-Za-z]_[A-Za-z]/u.test(token))
  )
  return unique([...paths, ...symbols], 12)
}

function terms(text: string): string[] {
  return unique(
    (text.match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu) ?? [])
      .filter(term => term.length >= 3 && !STOP_WORDS.has(term.toLocaleLowerCase()))
      .map(term => term.slice(0, 120)),
    24
  )
}

/**
 * Native FTS uses at most twenty terms. Put exact source names first and keep
 * conversational filler out, including when the current input only resumes a task.
 */
export function buildRepositoryContextQuery(query: string, taskContext = ''): RepositoryContextQuery {
  const current = query.slice(0, 16_384)
  const context = taskContext.slice(0, 16_384)
  const currentIds = identifiers(current)
  const contextIds = identifiers(context)
  const exact = unique([...currentIds, ...contextIds], 12)
  const focusedTerms = unique([...currentIds, ...contextIds, ...terms(current), ...terms(context)], 20)
  const focusQuery = focusedTerms.join(' ').slice(0, 4_096)
  return {
    queries: unique([...exact.slice(0, 3), focusQuery].filter(Boolean), 4),
    focusQuery,
    identifiers: exact,
    contextual: Boolean(context.trim()),
  }
}

export function hasRepositoryTaskSignal(query: string, taskContext = ''): boolean {
  const text = `${query.slice(0, 16_384)} ${taskContext.slice(0, 16_384)}`
  return (
    identifiers(text).length > 0 ||
    /\b(?:code|coding|repo(?:sitory)?|quellcode|implement(?:ieren|ierung|ation)?|programmieren|funktion(?:en)?|component|komponente|klasse|schnittstelle|api|typescript|javascript|laravel|vue|rust|refactor|datenbank)\b/iu.test(
      text
    )
  )
}
