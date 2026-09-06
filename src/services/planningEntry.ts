/** Parse a complete planning command; the caller decides how to present its objective. */
export function planningCommandObjective(text: string): string | null {
  const source = text.trimStart()
  const boundary = source.search(/\s/u)
  const command = (boundary < 0 ? source : source.slice(0, boundary)).toLowerCase()
  if (!['/plan', '/planen', '/planung'].includes(command)) return null
  return boundary < 0 ? '' : source.slice(boundary).trim()
}

/** Planning starts as a normal conversation; the optional review window remains separate. */
const DISCUSSION_SCOPE =
  'Zunächst geht es ausschließlich um Analyse und Besprechung im Chat. Eine Umsetzung oder ein Agentenstart benötigt einen eigenen klaren Auftrag von mir. Das separate Planungsfenster nutzen wir nur auf Wunsch.'

export function planningDiscussionMessage(objective: string): string {
  const target = objective.trim()
  return [
    target
      ? `Lass uns dieses Ziel planen und die Punkte gemeinsam besprechen: ${target}`
      : 'Lass uns das aktuelle Projekt planen und die Punkte gemeinsam besprechen.',
    'Schlage eine sinnvolle Reihenfolge vor und gehe offene Fragen, Varianten und Entscheidungen mit mir durch.',
    DISCUSSION_SCOPE,
  ].join('\n')
}

const PLAN_TOPICS = new Set([
  'plan',
  'plane',
  'planen',
  'planung',
  'konzept',
  'entwurf',
  'roadmap',
  'vorgehen',
  'schritt',
  'schritte',
  'punkt',
  'punkte',
  'varianten',
  'optionen',
])
const DRAFT_NOUNS = new Set(['plan', 'konzept', 'entwurf', 'roadmap'])
const DRAFT_VERBS = new Set(['erstelle', 'erstellen', 'schreibe', 'schreiben', 'entwirf', 'entwickle'])
const DRAFT_FILLERS = new Set([
  'mir',
  'uns',
  'bitte',
  'zuerst',
  'einen',
  'den',
  'ein',
  'das',
  'eine',
  'die',
  'groben',
  'konkreten',
  'vollständigen',
])
const DIRECT_ACTIONS = new Set([
  'speichere',
  'aktualisiere',
  'ändere',
  'lösche',
  'starte',
  'stoppe',
  'öffne',
  'prüfe',
  'kontrolliere',
  'lies',
  'lese',
  'suche',
  'finde',
  'liste',
  'implementiere',
  'führe',
  'setze',
  'lege',
  'anlegen',
])
const ACTION_INFINITIVES = new Set([
  'ausführen',
  'umsetzen',
  'implementieren',
  'speichern',
  'aktualisieren',
  'ändern',
  'löschen',
  'starten',
  'prüfen',
  'kontrollieren',
  'lesen',
  'suchen',
  'auflisten',
])
const POSTPONED_ACTIONS = new Set(['ausführen', 'umsetzen', 'implementieren', 'ändern', 'speichern'])
const ACTION_CUES = new Set(['bitte', 'jetzt', 'nun', 'sofort', 'anschließend', 'danach'])
const ACTION_FILLERS = new Set([
  'den',
  'diesen',
  'unseren',
  'das',
  'diese',
  'die',
  'plan',
  'entwurf',
  'konzept',
  'datei',
  'dateien',
  'ordner',
  'schritt',
  'schritte',
])
const DISCUSSION_WORDS = new Set([
  'plane',
  'planen',
  'planung',
  'besprechen',
  'bespreche',
  'besprich',
  'diskutieren',
  'diskutiere',
  'durchgehen',
  'erörtern',
  'erörtere',
])
const QUESTION_WORDS = new Set(['wie', 'was', 'welche', 'welcher', 'welches', 'warum', 'wann'])

/** Restrict clear discussion turns only; this heuristic never grants execution authority. */
export function isPlanningDiscussion(text: string): boolean {
  if (planningCommandObjective(text) !== null) return true
  const normalized = text.trim().toLocaleLowerCase('de-DE').replace(/\s+/gu, ' ')
  if (
    normalized.startsWith('lass uns ') &&
    normalized.includes('planen und die punkte gemeinsam besprechen') &&
    normalized.endsWith(DISCUSSION_SCOPE.toLocaleLowerCase('de-DE'))
  )
    return true
  // Unicode words preserve German imperatives; punctuation keeps plan.md a file.
  // A single forward scan avoids backtracking on long user-supplied objectives.
  const tokens = Array.from(normalized.matchAll(/[\p{L}\p{N}_]+|[^\s]/gu))
  const words = tokens.map(token => token[0])
  if (!words.some(word => PLAN_TOPICS.has(word))) return false
  let planDraft = false
  let postponesExecution = false
  let actionCue = false
  for (let index = 0; index < words.length; index++) {
    const word = words.at(index)!
    const next = words.at(index + 1) ?? ''
    if ((word === 'nicht' || word === 'nichts') && POSTPONED_ACTIONS.has(next)) {
      postponesExecution = true
      actionCue = false
      index++
      continue
    }
    if (DIRECT_ACTIONS.has(word)) return false
    if (DRAFT_VERBS.has(word)) {
      let nounIndex = index + 1
      while (DRAFT_FILLERS.has(words.at(nounIndex) ?? '')) nounIndex++
      const fileExtension =
        words.at(nounIndex + 1) === '.' &&
        /^[\p{L}\p{N}]/u.test(words.at(nounIndex + 2) ?? '') &&
        tokens.at(nounIndex + 1)!.index === tokens.at(nounIndex)!.index + words.at(nounIndex)!.length &&
        tokens.at(nounIndex + 2)!.index === tokens.at(nounIndex + 1)!.index + 1
      if (!DRAFT_NOUNS.has(words.at(nounIndex) ?? '') || fileExtension) return false
      planDraft = true
      actionCue = false
      index = nounIndex
      continue
    }
    if (DRAFT_NOUNS.has(word) && (next === 'erstellen' || next === 'entwerfen')) {
      planDraft = true
      actionCue = false
      index++
      continue
    }
    if (ACTION_CUES.has(word)) actionCue = true
    else if (actionCue && ACTION_INFINITIVES.has(word)) return false
    else if (!ACTION_FILLERS.has(word)) actionCue = false
  }
  return (
    planDraft ||
    postponesExecution ||
    words.some(word => DISCUSSION_WORDS.has(word)) ||
    QUESTION_WORDS.has(words[0] ?? '')
  )
}

/** An unscoped legacy checklist is never implicitly assigned to a new account. */
export function createPlanPrincipalBinding(resolve: () => Promise<string>, bind: (principal: string | null) => void) {
  let generation = 0
  let disposed = false
  return {
    async refresh(): Promise<void> {
      if (disposed) return
      const current = ++generation
      bind(null)
      try {
        const principal = await resolve()
        if (!disposed && current === generation) bind(principal)
      } catch {
        // No account or stable device identity means no checklist is accessible.
      }
    },
    invalidate(): void {
      generation++
      bind(null)
    },
    dispose(): void {
      disposed = true
      generation++
      bind(null)
    },
  }
}
