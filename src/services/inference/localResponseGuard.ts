/** Application diagnostics are not model answers or evidence of execution. */
const statusPrefixes = [
  'die lokale modellrunde',
  'die nächste modellrunde',
  'der auftrag wurde in einen bereinigten fortsetzungs',
  'der auftrag wurde in einen gesicherten fortsetzungs',
  'aktuelle fortsetzungsposition:',
  'tokenzählung und kontextprüfung',
  'auch nach zwei automatischen korrekturversuchen',
  'das modell hat auch nach',
]
const normalizedStart = (text: string) =>
  text
    .trimStart()
    .replace(/^(?:#{1,6}\s+|\*{1,2})/, '')
    .toLocaleLowerCase('de-DE')
    .replace(/\s+/g, ' ')

export function isRuntimeStatusEcho(text: string): boolean {
  const start = normalizedStart(text)
  const unnumbered = start.replace(/^die (lokale|nächste) modellrunde \d+ /, 'die $1 modellrunde ')
  return (
    /^die (?:lokale|nächste) modellrunde wurde (?:vor dem abschluss )?unterbrochen:/.test(unnumbered) ||
    /^der auftrag wurde in einen (?:bereinigten|gesicherten) fortsetzungs(?:stand|status) überführt/.test(start) ||
    /^aktuelle fortsetzungsposition:\s*[\d.,]+\s*tokens?/.test(start) ||
    /^tokenzählung und kontextprüfung\s*[·:]\s*http\s*\d+/.test(start) ||
    start.startsWith('auch nach zwei automatischen korrekturversuchen konnte das modell keine antwort') ||
    start.startsWith('das modell hat auch nach zwei automatischen korrekturversuchen eine unbelegte statusmeldung') ||
    start.startsWith('das modell hat auch nach der automatischen korrektur nur werkzeugtext')
  )
}

/** Hold only diagnostic-shaped beginnings, including split markers, until classified. */
export function holdRuntimeStatusPrefix(text: string): boolean {
  const start = normalizedStart(text)
  return !!start && statusPrefixes.some(prefix => prefix.startsWith(start) || start.startsWith(prefix))
}

export function explicitlyQuotesRuntimeStatus(objective: string): boolean {
  const text = normalizedStart(objective)
  return (
    /\b(?:zitiere|wörtlich|wortgetreu|quote|verbatim)\b/.test(text) &&
    statusPrefixes.some(prefix => text.includes(prefix))
  )
}

export function isSilentLocalResponseFailure(code: string | undefined): boolean {
  return code === 'runtime_output_repeated' || code === 'runtime_status_echo' || code === 'runtime_text_tool_output'
}
