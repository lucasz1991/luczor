import type {
  ResearchClaimsProposal,
  ResearchCompletion,
  ResearchPlanProposal,
  ResearchReviewProposal,
  ResearchRun,
  ResearchSource,
} from './types'

const fail = (message: string): never => {
  throw new Error(`Recherche: ${message}`)
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${name} muss ein Objekt sein.`)
  return value as Record<string, unknown>
}
function string(value: unknown, name: string, maximum = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    return fail(`${name} fehlt oder überschreitet ${maximum} Zeichen.`)
  return value.trim()
}
function list(value: unknown, name: string, maximum = 500): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(`${name} muss eine begrenzte Liste sein.`)
  return value
}
function strings(value: unknown, name: string, maximum = 500): string[] {
  return list(value, name, maximum).map(item => string(item, name))
}
function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) fail(`${name} enthält doppelte Kennungen.`)
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') return fail(`${name} muss true oder false sein.`)
  return value
}
/** Accept one JSON document or one entire fenced JSON block, never guessed prose. */
function proposal(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return record(raw, 'Vorschlag')
  if (raw.length > 2000000) return fail('Der Vorschlag ist zu groß; nichts wurde gekürzt.')
  const value = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, '$1')
  try {
    return record(JSON.parse(value), 'Vorschlag')
  } catch {
    return fail('Ein vollständiges JSON-Objekt wird benötigt.')
  }
}

export function parseResearchPlan(raw: unknown): ResearchPlanProposal {
  const value = proposal(raw)
  const questions = list(value.questions, 'Fragen', 40).map(input => {
    const item = record(input, 'Frage')
    return {
      id: string(item.id, 'Fragenkennung', 100),
      text: string(item.text, 'Frage'),
      requiresFreshness: boolean(item.requiresFreshness, 'Aktualitätsanforderung'),
    }
  })
  if (!questions.length) fail('Mindestens eine überprüfbare Frage wird benötigt.')
  unique(
    questions.map(question => question.id),
    'Fragenliste'
  )
  return { questions, queries: strings(value.queries, 'Suchanfragen', 80) }
}

export function parseResearchClaims(raw: unknown, run: ResearchRun): ResearchClaimsProposal {
  const value = proposal(raw)
  const questionIds = new Set(run.questions.map(question => question.id))
  const sources = new Map(run.sources.map(source => [source.id, source]))
  const claims = list(value.claims, 'Aussagen').map(input => {
    const item = record(input, 'Aussage')
    const questions = strings(item.questionIds, 'Fragenbezug', 40)
    unique(questions, 'Fragenbezug')
    if (!questions.length || questions.some(id => !questionIds.has(id))) fail('Eine Aussage nennt unbekannte Fragen.')
    const evidence = list(item.evidence, 'Belege', 200).map(inputRef => {
      const ref = record(inputRef, 'Beleg')
      const sourceId = string(ref.sourceId, 'Quellenkennung', 200)
      const segmentId = string(ref.segmentId, 'Abschnittskennung', 200)
      if (!sources.get(sourceId)?.segments.some(segment => segment.id === segmentId))
        fail('Ein Beleg verweist auf einen nicht gelesenen Quellenabschnitt.')
      return { sourceId, segmentId }
    })
    if (!evidence.length) fail('Jede vorgeschlagene Kernaussage benötigt gelesene Belege.')
    unique(
      evidence.map(ref => JSON.stringify([ref.sourceId, ref.segmentId])),
      'Belegliste'
    )
    return {
      id: string(item.id, 'Aussagenkennung', 100),
      text: string(item.text, 'Aussage'),
      questionIds: questions,
      evidence,
    }
  })
  if (!claims.length) fail('Es liegen noch keine belegten Kernaussagen vor.')
  unique(
    claims.map(claim => claim.id),
    'Aussagenliste'
  )
  return { claims, limitations: strings(value.limitations ?? [], 'Grenzen', 200) }
}

export function parseResearchReview(raw: unknown, run: ResearchRun): ResearchReviewProposal {
  const value = proposal(raw)
  const claims = list(value.claims, 'Prüfergebnisse').map(input => {
    const item = record(input, 'Prüfergebnis')
    const freshness = string(item.freshness, 'Aktualitätsprüfung', 20)
    if (!['current', 'not_required', 'stale', 'unknown'].includes(freshness)) fail('Ungültige Aktualitätsprüfung.')
    return {
      claimId: string(item.claimId, 'Aussagenkennung', 100),
      supported: boolean(item.supported, 'Belegprüfung'),
      freshness: freshness as ResearchReviewProposal['claims'][number]['freshness'],
      explanation: string(item.explanation, 'Prüfbegründung'),
    }
  })
  unique(
    claims.map(claim => claim.claimId),
    'Prüfliste'
  )
  if (claims.length !== run.claims.length || claims.some(claim => !run.claims.some(item => item.id === claim.claimId)))
    fail('Die unabhängige Prüfung muss jede aktuelle Kernaussage genau einmal prüfen.')
  return { claims, issues: strings(value.issues ?? [], 'Prüflücken'), summary: string(value.summary, 'Prüfergebnis') }
}

/** Exact canonical input identity, not a cryptographic digest or a model-provided proof. */
export function researchEvidenceFingerprint(run: ResearchRun): string {
  return JSON.stringify({
    id: run.id,
    principalId: run.principalId,
    projectId: run.projectId,
    conversationId: run.conversationId,
    workspaceBindingId: run.workspaceBindingId ?? null,
    topic: run.topic,
    asOf: run.asOf,
    questions: run.questions.map(question => [question.id, question.text, question.requiresFreshness]),
    sources: run.sources.map(source => [
      source.id,
      source.url,
      source.title,
      source.publisher ?? null,
      source.capturedAt,
      source.publishedAt ?? null,
      source.updatedAt ?? null,
      source.contentHash,
      source.readReceiptId,
      source.kind,
      source.coverage,
      source.segments.map(segment => [segment.id, segment.text, segment.locator ?? null]),
    ]),
    claims: run.claims.map(claim => [
      claim.id,
      claim.text,
      claim.questionIds,
      claim.evidence.map(ref => [ref.sourceId, ref.segmentId]),
    ]),
    limitations: run.limitations ?? [],
  })
}

/** Called by the host only after a separate review run has actually read the evidence. */
export function applyResearchReview(
  run: ResearchRun,
  raw: ResearchReviewProposal,
  readReceiptIds: readonly string[],
  now = Date.now()
): Pick<ResearchRun, 'claims' | 'review'> {
  const review = parseResearchReview(raw, run)
  if (!readReceiptIds.length || readReceiptIds.some(id => !id.trim())) fail('Der Prüfphase fehlen echte Leseaufrufe.')
  if (requiredResearchReviewReceipts(run).some(id => !readReceiptIds.includes(id)))
    fail('Die Prüfphase hat noch nicht jeden zitierten Quellenabschnitt gelesen.')
  if (!Number.isFinite(now) || now < run.createdAt) fail('Ungültiger Prüfzeitpunkt.')
  return {
    claims: run.claims.map(claim => {
      const result = review.claims.find(item => item.claimId === claim.id)!
      return {
        ...claim,
        review: { supported: result.supported, freshness: result.freshness, explanation: result.explanation },
      }
    }),
    review: {
      completedAt: now,
      inputFingerprint: researchEvidenceFingerprint(run),
      readReceiptIds: [...new Set(readReceiptIds)],
      summary: review.summary,
      issues: review.issues,
    },
  }
}

export function requiredResearchReviewReceipts(run: ResearchRun): string[] {
  return [...new Set(run.claims.flatMap(claim => claim.evidence.map(ref => `review:${ref.sourceId}:${ref.segmentId}`)))]
}

function sourceIssues(source: ResearchSource, now: number): string[] {
  const issues: string[] = []
  if (!source.id.trim() || !source.url.trim() || !source.title.trim()) issues.push('Quellenidentität unvollständig.')
  if (!source.contentHash.trim() || !source.readReceiptId.trim()) issues.push(`Quelle ${source.id}: Lesebeleg fehlt.`)
  if (!Number.isFinite(source.capturedAt) || source.capturedAt <= 0 || source.capturedAt > now)
    issues.push(`Quelle ${source.id}: Abrufzeitpunkt ungültig.`)
  if (!source.segments.length || source.segments.some(segment => !segment.id.trim() || !segment.text.trim()))
    issues.push(`Quelle ${source.id}: gelesener Inhalt fehlt.`)
  if (new Set(source.segments.map(segment => segment.id)).size !== source.segments.length)
    issues.push(`Quelle ${source.id}: Abschnittskennungen sind nicht eindeutig.`)
  if (source.kind === 'web') {
    try {
      if (!['http:', 'https:'].includes(new URL(source.url).protocol))
        issues.push(`Quelle ${source.id}: Webadresse ungültig.`)
    } catch {
      issues.push(`Quelle ${source.id}: Webadresse ungültig.`)
    }
  }
  return issues
}

export function validateResearchCompletion(
  run: ResearchRun,
  options: { requireReport?: boolean; now?: number } = {}
): ResearchCompletion {
  const issues: string[] = []
  const now = options.now ?? Date.now()
  if (!run.questions.length || !run.claims.length) issues.push('Fragen oder belegte Kernaussagen fehlen.')
  if (!run.asOf.trim() || !Number.isFinite(Date.parse(run.asOf)))
    issues.push('Der Berichtsstand fehlt oder ist ungültig.')
  for (const [name, ids] of [
    ['Fragen', run.questions.map(item => item.id)],
    ['Quellen', run.sources.map(item => item.id)],
    ['Aussagen', run.claims.map(item => item.id)],
  ] as const)
    if (new Set(ids).size !== ids.length) issues.push(`${name}: Kennungen sind nicht eindeutig.`)
  const sources = new Map(run.sources.map(source => [source.id, source]))
  for (const question of run.questions) {
    if (!question.id.trim() || !question.text.trim()) issues.push('Eine Kernfrage ist leer.')
    if (!run.claims.some(claim => claim.questionIds.includes(question.id)))
      issues.push(`Frage ${question.id}: unbeantwortet.`)
  }
  for (const claim of run.claims) {
    if (!claim.text.trim() || !claim.id.trim() || !claim.questionIds.length)
      issues.push(`Aussage ${claim.id}: unvollständig.`)
    if (claim.questionIds.some(id => !run.questions.some(question => question.id === id)))
      issues.push(`Aussage ${claim.id}: unbekannte Frage.`)
    if (!claim.evidence.length) issues.push(`Aussage ${claim.id}: Belege fehlen.`)
    for (const ref of claim.evidence) {
      const source = sources.get(ref.sourceId)
      if (!source?.segments.some(segment => segment.id === ref.segmentId))
        issues.push(`Aussage ${claim.id}: ungelesener Beleg.`)
      if (source) issues.push(...sourceIssues(source, now))
    }
    if (!claim.review?.supported || !claim.review.explanation.trim())
      issues.push(`Aussage ${claim.id}: nicht unabhängig bestätigt.`)
    const needsFreshness = run.questions.some(
      question => question.requiresFreshness && claim.questionIds.includes(question.id)
    )
    if (needsFreshness && claim.review?.freshness !== 'current')
      issues.push(`Aussage ${claim.id}: Aktualität nicht belegt.`)
    if (
      needsFreshness &&
      !claim.evidence.some(ref => sources.get(ref.sourceId)?.kind !== 'context' && sources.has(ref.sourceId))
    )
      issues.push(`Aussage ${claim.id}: Kontextanalyse ersetzt keine aktuelle Quelle.`)
    if (claim.review?.freshness === 'stale' || claim.review?.freshness === 'unknown')
      issues.push(`Aussage ${claim.id}: Aktualitätsprüfung offen.`)
  }
  if (!run.review || !run.review.readReceiptIds.length || !run.review.summary.trim())
    issues.push('Unabhängige Prüfung mit echten Leseaufrufen fehlt.')
  else {
    if (requiredResearchReviewReceipts(run).some(id => !run.review!.readReceiptIds.includes(id)))
      issues.push('Nicht jeder zitierte Quellenabschnitt wurde in der Prüfphase gelesen.')
    if (run.review.inputFingerprint !== researchEvidenceFingerprint(run))
      issues.push('Quellen oder Aussagen wurden seit der Prüfung verändert.')
    if (
      !Number.isFinite(run.review.completedAt) ||
      run.review.completedAt < run.createdAt ||
      run.review.completedAt > now
    )
      issues.push('Prüfzeitpunkt ungültig.')
    issues.push(...run.review.issues)
  }
  issues.push(...run.blockers)
  if (options.requireReport !== false) {
    const report = run.report
    if (
      !report?.markdownPath.trim() ||
      !report.htmlPath.trim() ||
      !report.verifiedAt ||
      report.verifiedAt > now ||
      report.verifiedAt < (run.review?.completedAt ?? run.createdAt)
    )
      issues.push('Markdown- und HTML-Bericht sind noch nicht abschließend auf Datenträger geprüft.')
    if (report?.contentFingerprint !== researchEvidenceFingerprint(run))
      issues.push('Gespeicherter Bericht entspricht nicht dem geprüften Stand.')
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)] }
}
