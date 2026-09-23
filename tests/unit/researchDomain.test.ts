import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyResearchReview,
  parseResearchClaims,
  parseResearchPlan,
  parseResearchReview,
  researchEvidenceFingerprint,
  requiredResearchReviewReceipts,
  validateResearchCompletion,
} from '@/services/research/evidence'
import { parseResearchEntry } from '@/services/research/researchEntry'
import { renderResearchReport, safeResearchLink } from '@/services/research/report'
import type { ResearchReviewProposal, ResearchRun } from '@/services/research/types'

const now = Date.parse('2026-09-23T12:00:00Z')
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(() => {
  vi.restoreAllMocks()
})
function fixture(): ResearchRun {
  return {
    id: 'r1',
    principalId: 'account1',
    projectId: 'project1',
    conversationId: 'chat1',
    topic: 'Aktuelle Version',
    depth: 'deep',
    stage: 'reviewing',
    status: 'running',
    revision: 1,
    createdAt: now - 10000,
    updatedAt: now,
    asOf: '2026-09-23',
    outputDir: 'C:\\Recherche\\Version',
    questions: [{ id: 'q1', text: 'Welche Version ist aktuell?', requiresFreshness: true }],
    sources: [
      {
        id: 's1',
        url: 'https://example.com/releases',
        title: 'Offizielle Releases',
        capturedAt: now - 5000,
        publishedAt: '2026-09-23',
        contentHash: 'abc',
        readReceiptId: 'read:1',
        kind: 'web',
        coverage: 'partial',
        segments: [{ id: 'p1', text: 'Die aktuelle Version ist 3.0.', locator: 'Releaseübersicht, Zeile 4' }],
      },
    ],
    claims: [
      {
        id: 'c1',
        text: 'Die aktuelle Version ist 3.0.',
        questionIds: ['q1'],
        evidence: [{ sourceId: 's1', segmentId: 'p1' }],
      },
    ],
    artifacts: [],
    blockers: [],
  }
}
function review(run: ResearchRun): ResearchReviewProposal {
  return {
    summary: 'Frage und Belege unabhängig geprüft.',
    issues: [],
    claims: run.claims.map(claim => ({
      claimId: claim.id,
      supported: true,
      freshness: 'current',
      explanation: 'Die gelesene offizielle Releaseübersicht nennt diese Version zum Berichtsstand.',
    })),
  }
}
function complete(): ResearchRun {
  const run = fixture()
  Object.assign(run, applyResearchReview(run, review(run), requiredResearchReviewReceipts(run), now))
  run.report = {
    markdownPath: `${run.outputDir}\\bericht.md`,
    htmlPath: `${run.outputDir}\\bericht.html`,
    verifiedAt: now,
    contentFingerprint: researchEvidenceFingerprint(run),
  }
  return run
}

describe('exact research entry', () => {
  it('accepts only the leading command and preserves the topic and its Unicode', () => {
    expect(parseResearchEntry('/research deep\nAktuelle Bahn-Öffnungszeiten?')).toEqual({
      topic: 'Aktuelle Bahn-Öffnungszeiten?',
      depth: 'deep',
    })
    expect(parseResearchEntry('/research aktuelle APIs')).toEqual({ topic: 'aktuelle APIs', depth: 'deep' })
    expect(parseResearchEntry('/research deep')).toEqual({ topic: '', depth: 'deep' })
    for (const value of ['Erkläre /research deep', '/researcher test', '`/research deep`', '/research/test'])
      expect(parseResearchEntry(value)).toBeNull()
  })
})

describe('host-bound research proposals and evidence', () => {
  it('parses a complete JSON plan and rejects prose or invented implicit requirements', () => {
    const plan = { questions: fixture().questions, queries: ['offizielle aktuelle Version'] }
    expect(parseResearchPlan(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(plan)
    expect(() => parseResearchPlan('Vorschlag: ' + JSON.stringify(plan))).toThrow('JSON')
    expect(() => parseResearchPlan({ questions: [{ id: 'q1', text: 'Frage' }], queries: [] })).toThrow(
      'Aktualitätsanforderung'
    )
    expect(() => parseResearchPlan({ questions: [...plan.questions, ...plan.questions], queries: [] })).toThrow(
      'doppelte'
    )
  })

  it('accepts real source segments and discards a model-supplied review flag', () => {
    const run = fixture()
    const claims = parseResearchClaims(
      { claims: run.claims.map(claim => ({ ...claim, review: { supported: true } })), limitations: [] },
      run
    )
    expect(claims.claims).toEqual(run.claims)
    expect(claims.claims[0]).not.toHaveProperty('review')
  })

  it('rejects invented citations, unread segments and unknown questions', () => {
    for (const change of [
      { evidence: [{ sourceId: 'invented', segmentId: 'p1' }] },
      { evidence: [{ sourceId: 's1', segmentId: 'unread' }] },
      { questionIds: ['unknown'] },
      { evidence: [] },
    ]) {
      const run = fixture()
      expect(() => parseResearchClaims({ claims: [{ ...run.claims[0], ...change }] }, run)).toThrow('Recherche')
    }
  })

  it('requires review of every claim and an actual read of every cited segment', () => {
    const run = fixture()
    expect(() => parseResearchReview({ ...review(run), claims: [] }, run)).toThrow('jede aktuelle Kernaussage')
    expect(() => applyResearchReview(run, review(run), ['some-unrelated-file'], now)).toThrow('jeden zitierten')
    expect(() => applyResearchReview(run, review(run), [], now)).toThrow('echte Leseaufrufe')
    const result = applyResearchReview(run, review(run), ['review:s1:p1'], now)
    expect(result.claims[0]?.review?.supported).toBe(true)
  })

  it('never allows a prose completion claim without provenance and independent review', () => {
    const run = fixture()
    expect(validateResearchCompletion(run, { requireReport: false, now }).ok).toBe(false)
    run.claims[0]!.review = { supported: true, freshness: 'current', explanation: 'Trust me' }
    expect(validateResearchCompletion(run, { requireReport: false, now }).issues).toContain(
      'Unabhängige Prüfung mit echten Leseaufrufen fehlt.'
    )
  })

  it('keeps disk verification separate from successful content review', () => {
    const run = complete()
    expect(validateResearchCompletion(run, { now })).toEqual({ ok: true, issues: [] })
    run.report = undefined
    expect(validateResearchCompletion(run, { requireReport: false, now }).ok).toBe(true)
    expect(validateResearchCompletion(run, { now }).ok).toBe(false)
  })

  it('invalidates a review when any evidence text, metadata, question, claim or date changes', () => {
    const changes: Array<(run: ResearchRun) => void> = [
      run => {
        run.sources[0] = { ...run.sources[0]!, segments: [{ id: 'p1', text: 'Version 2.0' }] }
      },
      run => {
        run.sources[0] = { ...run.sources[0]!, publishedAt: '2025-01-01' }
      },
      run => {
        run.sources[0] = { ...run.sources[0]!, url: 'https://different.example.com' }
      },
      run => {
        run.questions[0]!.requiresFreshness = false
      },
      run => {
        run.claims[0]!.text = 'Version 4.0'
      },
      run => {
        run.asOf = '2026-09-24'
      },
    ]
    for (const change of changes) {
      const run = complete()
      change(run)
      expect(validateResearchCompletion(run, { now }).issues).toContain(
        'Quellen oder Aussagen wurden seit der Prüfung verändert.'
      )
    }
  })

  it('does not confuse a fresh download with a current supported claim', () => {
    const run = fixture()
    run.sources[0] = { ...run.sources[0]!, publishedAt: '2020-01-01' }
    const result = review(run)
    result.claims[0]!.freshness = 'stale'
    Object.assign(run, applyResearchReview(run, result, ['review:s1:p1'], now))
    expect(validateResearchCompletion(run, { requireReport: false, now }).issues).toContain(
      'Aussage c1: Aktualität nicht belegt.'
    )
  })

  it('context-only analysis, missing question coverage and failed review remain intermediate', () => {
    const run = fixture()
    run.sources[0] = { ...run.sources[0]!, kind: 'context' }
    run.questions.push({ id: 'q2', text: 'Was hat sich geändert?', requiresFreshness: false })
    const result = review(run)
    result.issues = ['Die zweite Kernfrage fehlt.']
    Object.assign(run, applyResearchReview(run, result, ['review:s1:p1'], now))
    const validation = validateResearchCompletion(run, { requireReport: false, now })
    expect(validation.issues).toContain('Frage q2: unbeantwortet.')
    expect(validation.issues).toContain('Aussage c1: Kontextanalyse ersetzt keine aktuelle Quelle.')
    expect(validation.issues).toContain('Die zweite Kernfrage fehlt.')
  })

  it('rejects future timestamps, empty read receipts and a stale saved report', () => {
    const run = complete()
    run.sources[0] = { ...run.sources[0]!, capturedAt: now + 1000, readReceiptId: '' }
    const validation = validateResearchCompletion(run, { now })
    expect(validation.issues).toContain('Quelle s1: Abrufzeitpunkt ungültig.')
    expect(validation.issues).toContain('Quelle s1: Lesebeleg fehlt.')
    expect(validation.issues).toContain('Gespeicherter Bericht entspricht nicht dem geprüften Stand.')
  })

  it('does not need an arbitrary source count or total research budget', () => {
    expect(validateResearchCompletion(complete(), { now }).ok).toBe(true)
  })
})

describe('safe report artifacts', () => {
  it('exports deterministic Markdown, HTML and metadata with exact observed source dates', () => {
    const run = complete()
    const result = renderResearchReport(run)
    expect(result.intermediate).toBe(false)
    expect(result.files.map(file => file.name)).toEqual([
      'bericht.md',
      'bericht.html',
      'quellen.json',
      'recherche.json',
    ])
    expect(result.markdown).toContain('Stand: 2026-09-23')
    expect(result.html).toContain('2026-09-23T11:59:55.000Z')
    expect(result.html).toContain('Beleg <a href="#quelle-1">[1]</a>')
    expect(JSON.parse(result.sourcesJson).sources).toEqual(run.sources)
    expect(JSON.parse(result.manifestJson).status).toBe('completed')
    expect(result.manifestJson).not.toContain('principalId')
    expect(result.manifestJson).not.toContain('workspaceBindingId')
    expect(renderResearchReport(run)).toEqual(result)
  })

  it('renders untrusted page/model content as text and forbids active or credential links', () => {
    const run = fixture()
    run.topic = '<script>alert(1)</script>'
    run.claims[0]!.text = '![x](javascript:alert(1)) <img src=x onerror=alert(1)>'
    run.sources[0] = { ...run.sources[0]!, title: '" onclick="alert(1)', url: 'javascript:alert(1)' }
    const result = renderResearchReport(run)
    expect(result.html).not.toContain('<script>')
    expect(result.html).not.toContain('<img')
    expect(result.html).not.toContain('href="javascript:')
    expect(result.html).toContain('&lt;script&gt;')
    expect(result.html).toContain('Content-Security-Policy')
    expect(result.markdown).toContain('\\!\\[x\\]')
    expect(safeResearchLink('https://user:secret@example.com')).toBeUndefined()
    expect(safeResearchLink('file:///C:/secret')).toBeUndefined()
    expect(safeResearchLink('data:text/html,<script>alert(1)</script>')).toBeUndefined()
  })

  it('cannot force unsupported research into a final report and shows publication date as unknown', () => {
    const run = fixture()
    run.sources[0] = { ...run.sources[0]!, publishedAt: undefined }
    const result = renderResearchReport(run, { intermediate: false })
    expect(result.intermediate).toBe(true)
    expect(result.markdown).toContain('Zwischenbericht')
    expect(result.markdown).toContain('nicht angegeben')
    expect(result.markdown).toContain('noch nicht bestätigt')
  })

  it('exports a public manifest without account/workspace bindings or self-referential output hashes', () => {
    const run = complete()
    run.workspaceBindingId = 'private-workspace-binding'
    run.artifacts = [
      { id: 'report', path: 'bericht.html', kind: 'report', contentHash: 'old-report-hash' },
      { id: 'manifest', path: 'recherche.json', kind: 'metadata', contentHash: 'old-manifest-hash' },
      { id: 'download', path: 'downloads/source.pdf', kind: 'download', contentHash: 'verified-source-hash' },
    ]
    const metadata = renderResearchReport(run).manifestJson
    expect(metadata).not.toContain('private-workspace-binding')
    expect(metadata).not.toContain('principalId')
    expect(metadata).not.toContain('old-report-hash')
    expect(metadata).not.toContain('old-manifest-hash')
    expect(JSON.parse(metadata).artifacts).toEqual([run.artifacts[2]])
  })
})
