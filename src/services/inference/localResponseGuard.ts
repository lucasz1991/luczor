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

/** Inspect top-level paragraphs, not literal Markdown examples or quotations. */
function publicParagraphs(text: string): string[] {
  const result: string[] = []
  let paragraph = ''
  let fence = ''
  const flush = () => {
    if (paragraph.trim()) result.push(normalizedStart(paragraph.trimEnd()))
    paragraph = ''
  }
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      flush()
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
      continue
    }
    if (fence) continue
    if (!line.trim() || line.trimStart().startsWith('>')) flush()
    else paragraph += `${line}\n`
  }
  flush()
  return result
}

function isStatusParagraph(start: string): boolean {
  const unnumbered = start.replace(/^die (lokale|nächste) modellrunde \d+ /, 'die $1 modellrunde ')
  return (
    /^die (?:lokale|nächste) modellrunde wurde (?:vor dem abschluss )?unterbrochen:/.test(unnumbered) ||
    // Models paraphrase the interruption clause (e.g. "Untergrenze erreicht").
    // Detect the claimed runtime diagnostic, not one exact failure sentence.
    (/^die (?:lokale|nächste) modellrunde\b/.test(start) &&
      /tokenzählung und kontextprüfung|\bhttp\s+[1-5]\d{2}\b|\btokenbudget(?:stand)?\b/.test(start)) ||
    /^der auftrag wurde in einen (?:bereinigten|gesicherten) fortsetzungs(?:stand|status|runde) überführt/.test(
      start
    ) ||
    /^aktuelle fortsetzungsposition:\s*[\d.,]+\s*tokens?/.test(start) ||
    /^tokenzählung und kontextprüfung\s*[·:]\s*http\s*\d+/.test(start) ||
    start.startsWith('auch nach zwei automatischen korrekturversuchen konnte das modell keine antwort') ||
    start.startsWith('das modell hat auch nach zwei automatischen korrekturversuchen eine unbelegte statusmeldung') ||
    start.startsWith('das modell hat auch nach der automatischen korrektur nur werkzeugtext')
  )
}

export function isRuntimeStatusEcho(text: string): boolean {
  return publicParagraphs(text).some(isStatusParagraph)
}

/** Lines the host appends after its own interruption notice (agent.ts); never model text there. */
const interruptionNotes = [
  /^diagnose: [a-z0-9_:]+; abschluss: /,
  /^der bisherige arbeitsfortschritt bleibt erhalten \(/,
  /^der fortsetzungsstand bleibt erhalten; /,
  /^der vollständige auftrag und sein arbeitskontext sind zur fortsetzung gesichert\./,
  /^der vollständige arbeitskontext bleibt lokal erhalten\./,
  /^du kannst direkt weiterarbeiten; luczor liest dabei/,
]

/**
 * History projection only: drop the application's status paragraphs and the notes that belong to
 * them, but keep what the model had already said or done around them. Fenced and quoted text is
 * never removed.
 */
export function withoutRuntimeStatusParagraphs(text: string): string {
  const blocks: Array<{ lines: string[]; protected: boolean }> = []
  let current: string[] = []
  let fence = ''
  const flush = (isProtected = false) => {
    if (current.length) blocks.push({ lines: current, protected: isProtected })
    current = []
  }
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      current.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = ''
        flush(true)
      }
      continue
    }
    if (marker) {
      flush()
      fence = marker
      current.push(line)
      continue
    }
    if (line.trimStart().startsWith('>')) {
      flush()
      current.push(line)
      flush(true)
      continue
    }
    if (!line.trim()) flush()
    else current.push(line)
  }
  flush(!!fence)
  const entries = blocks.map(block => ({
    text: block.lines.join('\n'),
    start: block.protected ? '' : normalizedStart(block.lines.join('\n').trimEnd()),
  }))
  if (!entries.some(entry => entry.start && isStatusParagraph(entry.start))) return text
  // The host appends its notes after the status paragraph; earlier paragraphs are the model's
  // commentary and stay, whatever they start with.
  let afterStatus = false
  return entries
    .filter(({ start }) => {
      if (!start) return true
      if (isStatusParagraph(start)) {
        afterStatus = true
        return false
      }
      return !(afterStatus && interruptionNotes.some(note => note.test(start)))
    })
    .map(entry => entry.text)
    .join('\n\n')
}

/** Hold only diagnostic-shaped beginnings, including split markers, until classified. */
export function holdRuntimeStatusPrefix(text: string): boolean {
  return publicParagraphs(text).some(start =>
    statusPrefixes.some(prefix => prefix.startsWith(start) || start.startsWith(prefix))
  )
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
