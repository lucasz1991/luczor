import { researchEvidenceFingerprint, validateResearchCompletion } from './evidence'
import type { ResearchRun } from './types'

export type ResearchReportFiles = {
  markdown: string
  html: string
  sourcesJson: string
  manifestJson: string
  intermediate: boolean
  contentFingerprint: string
  files: Array<{ name: 'bericht.md' | 'bericht.html' | 'quellen.json' | 'recherche.json'; content: string }>
}

export function escapeResearchHtml(value: string): string {
  const entities = new Map([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&#39;'],
  ])
  return value.replace(/[&<>"']/gu, character => entities.get(character)!)
}
const markdownText = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/[`*_{}[\]<>#!|]/gu, '\\$&')
export function safeResearchLink(value: string): string | undefined {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}
const timestamp = (value: number): string =>
  Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toISOString() : 'unbekannt'
const paragraph = (value: string): string => `<p>${escapeResearchHtml(value).replace(/\r?\n/gu, '<br>')}</p>`

/** Fixed document structure; model prose is always escaped text, never executable Markdown/HTML. */
export function renderResearchReport(run: ResearchRun, options: { intermediate?: boolean } = {}): ResearchReportFiles {
  const completion = validateResearchCompletion(run, { requireReport: false })
  const intermediate = options.intermediate === true || !completion.ok
  const title = intermediate ? 'Zwischenbericht' : 'Recherchebericht'
  const contentFingerprint = researchEvidenceFingerprint(run)
  const sourceNumbers = new Map(run.sources.map((source, index) => [source.id, index + 1]))
  const gaps = [...new Set([...completion.issues, ...(run.limitations ?? [])])]
  const md: string[] = [
    `# ${title}: ${markdownText(run.topic)}`,
    '',
    `Stand: ${markdownText(run.asOf)}`,
    '',
    intermediate
      ? '**Status: Zwischenstand – die Recherche ist nicht abgeschlossen.**'
      : '**Status: Geprüfter Recherchebericht.**',
    '',
    '## Fragestellung',
    '',
  ]
  const body: string[] = [
    `<h1>${escapeResearchHtml(title)}: ${escapeResearchHtml(run.topic)}</h1>`,
    paragraph(`Stand: ${run.asOf}`),
    `<p class="status">${intermediate ? 'Zwischenstand – die Recherche ist nicht abgeschlossen.' : 'Geprüfter Recherchebericht.'}</p>`,
    '<h2>Fragestellung</h2><ol>',
  ]
  for (const question of run.questions) {
    md.push(`- ${markdownText(question.text)}${question.requiresFreshness ? ' (aktueller Stand erforderlich)' : ''}`)
    body.push(
      `<li>${escapeResearchHtml(question.text)}${question.requiresFreshness ? ' (aktueller Stand erforderlich)' : ''}</li>`
    )
  }
  if (run.clarifications?.length) {
    md.push('', 'Ergänzungen zum Auftrag:', '', ...run.clarifications.map(note => `- ${markdownText(note)}`))
    body.push(
      `</ol><p>Ergänzungen zum Auftrag:</p><ol>${run.clarifications.map(note => `<li>${escapeResearchHtml(note)}</li>`).join('')}`
    )
  }
  body.push('</ol><h2>Ergebnisse und Belege</h2>')
  md.push('', '## Ergebnisse und Belege', '')
  if (!run.claims.length) {
    md.push('Noch keine belegten Kernaussagen.', '')
    body.push(paragraph('Noch keine belegten Kernaussagen.'))
  }
  for (const claim of run.claims) {
    const checked = claim.review?.supported && run.review?.inputFingerprint === contentFingerprint
    const references = claim.evidence.flatMap(ref => {
      const source = run.sources.find(item => item.id === ref.sourceId)
      const segment = source?.segments.find(item => item.id === ref.segmentId)
      return source && segment ? [{ number: sourceNumbers.get(source.id)!, source, segment }] : []
    })
    md.push(
      `### ${markdownText(claim.id)}${checked ? '' : ' – noch nicht bestätigt'}`,
      '',
      markdownText(claim.text),
      ''
    )
    body.push(
      `<section><h3>${escapeResearchHtml(claim.id)}${checked ? '' : ' – noch nicht bestätigt'}</h3>${paragraph(claim.text)}`
    )
    for (const ref of references) {
      const locator = ref.segment.locator ?? ref.segment.id
      md.push(
        `Beleg [${ref.number}], ${markdownText(locator)}:`,
        '',
        ...ref.segment.text.split(/\r?\n/u).map(line => `> ${markdownText(line)}`),
        ''
      )
      body.push(
        `<p>Beleg <a href="#quelle-${ref.number}">[${ref.number}]</a>, ${escapeResearchHtml(locator)}:</p><blockquote>${escapeResearchHtml(ref.segment.text).replace(/\r?\n/gu, '<br>')}</blockquote>`
      )
    }
    if (claim.review) {
      md.push(`Prüfung: ${markdownText(claim.review.explanation)}`, '')
      body.push(paragraph(`Prüfung: ${claim.review.explanation}`))
    }
    body.push('</section>')
  }
  md.push('## Grenzen und offene Punkte', '')
  body.push('<h2>Grenzen und offene Punkte</h2>')
  if (gaps.length) {
    md.push(...gaps.map(gap => `- ${markdownText(gap)}`), '')
    body.push(`<ul>${gaps.map(gap => `<li>${escapeResearchHtml(gap)}</li>`).join('')}</ul>`)
  } else {
    md.push('Keine offenen Kernfragen in der abschließenden Prüfung.', '')
    body.push(paragraph('Keine offenen Kernfragen in der abschließenden Prüfung.'))
  }
  md.push('## Quellen', '')
  body.push('<h2>Quellen</h2><ol>')
  for (const source of run.sources) {
    const number = sourceNumbers.get(source.id)!
    const safeUrl = safeResearchLink(source.url)
    const escapedUrl = safeUrl?.replace(/[()]/gu, character => (character === '(' ? '%28' : '%29'))
    const metadata = `Herausgeber: ${source.publisher ?? 'nicht angegeben'}; abgerufen: ${timestamp(source.capturedAt)}; veröffentlicht: ${source.publishedAt ?? 'nicht angegeben'}; aktualisiert: ${source.updatedAt ?? 'nicht angegeben'}; ${source.coverage === 'complete' ? 'vollständig gelesener Inhalt' : 'ausgewählte Abschnitte gelesen'}.`
    md.push(
      `${number}. ${escapedUrl ? `[${markdownText(source.title)}](${escapedUrl})` : `${markdownText(source.title)} — ${markdownText(source.url)}`}`,
      `   ${markdownText(metadata)}`,
      ''
    )
    body.push(
      `<li id="quelle-${number}">${safeUrl ? `<a href="${escapeResearchHtml(safeUrl)}" rel="noopener noreferrer">${escapeResearchHtml(source.title)}</a>` : `${escapeResearchHtml(source.title)} — ${escapeResearchHtml(source.url)}`}${paragraph(metadata)}</li>`
    )
  }
  body.push('</ol><h2>Dateien</h2>')
  md.push('## Dateien', '')
  if (run.artifacts.length) {
    md.push(
      ...run.artifacts.map(
        artifact => `- ${markdownText(artifact.path)}${artifact.verifiedAt ? ' (geprüft)' : ' (Prüfung offen)'}`
      ),
      ''
    )
    body.push(
      `<ul>${run.artifacts.map(artifact => `<li>${escapeResearchHtml(artifact.path)}${artifact.verifiedAt ? ' (geprüft)' : ' (Prüfung offen)'}</li>`).join('')}</ul>`
    )
  } else {
    md.push('Keine zusätzlichen Dateien benötigt.', '')
    body.push(paragraph('Keine zusätzlichen Dateien benötigt.'))
  }
  const markdown = md.join('\n')
  const html =
    '<!doctype html>\n<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">" +
    `<title>${escapeResearchHtml(title)}: ${escapeResearchHtml(run.topic)}</title>` +
    '<style>html{color-scheme:light dark}body{max-width:900px;margin:40px auto;padding:0 24px;font:16px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}h1{font-size:2rem;line-height:1.25}h2{margin-top:2rem}h3{margin-bottom:.5rem}blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:3px solid #999;white-space:normal}li{margin:.6rem 0}.status{font-weight:600}a{color:inherit;text-underline-offset:3px}@media print{body{max-width:none;margin:0}a{color:inherit}}</style>' +
    `</head><body><main>${body.join('\n')}</main></body></html>\n`
  const sourcesJson =
    JSON.stringify({ version: 1, runId: run.id, asOf: run.asOf, sources: run.sources }, null, 2) + '\n'
  const manifestJson =
    JSON.stringify(
      {
        version: 1,
        topic: run.topic,
        clarifications: run.clarifications ?? [],
        depth: run.depth,
        asOf: run.asOf,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        stage: run.stage,
        status: intermediate ? run.status : 'completed',
        questions: run.questions,
        sourceIds: run.sources.map(source => source.id),
        claims: run.claims,
        blockers: run.blockers,
        limitations: run.limitations ?? [],
        artifacts: run.artifacts.filter(artifact => artifact.kind === 'download' || artifact.kind === 'extract'),
        reportKind: intermediate ? 'intermediate' : 'reviewed',
        reportFiles: ['bericht.md', 'bericht.html', 'quellen.json', 'recherche.json'],
      },
      null,
      2
    ) + '\n'
  return {
    markdown,
    html,
    sourcesJson,
    manifestJson,
    intermediate,
    contentFingerprint,
    files: [
      { name: 'bericht.md', content: markdown },
      { name: 'bericht.html', content: html },
      { name: 'quellen.json', content: sourcesJson },
      { name: 'recherche.json', content: manifestJson },
    ],
  }
}
