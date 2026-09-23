import { createApp, h, ref } from 'vue'
import ResearchRunCard from '@/components/ai/ResearchRunCard.vue'
import {
  applyResearchReview,
  researchEvidenceFingerprint,
  requiredResearchReviewReceipts,
} from '@/services/research/evidence'
import type { ResearchRun } from '@/services/research/types'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/styles/ai-workspace.css'
import '@/styles/liquid-glass.css'

// UI fixtures only: no application store, native bridge, browser/model calls or real research data.
const timestamp = Date.parse('2026-09-23T00:00:00Z')
const longPath =
  'C:\\Beispielprojekt\\Research\\2026-09-23-recherche-zur-dokumentation-und-langfristigen-betriebsfaehigkeit-mit-bewusst-langem-dateipfad\\Nachweise\\Technischer_Bericht_mit_einem_langen_Dateinamen_ohne_zusaetzliche_Trennstellen_2026.pdf'
function sample(id: string, status: ResearchRun['status']): ResearchRun {
  const run: ResearchRun = {
    id,
    principalId: 'ui-fixture',
    projectId: 'ui-project',
    conversationId: `ui-chat-${id}`,
    topic:
      status === 'running'
        ? 'Aktuelle Quellen für ein Projekt zusammentragen'
        : status === 'blocked'
          ? 'Vergleich mit noch ungeklärten Versionsangaben'
          : 'Vergleich offizieller Dokumentationen abgeschlossen',
    depth: 'deep',
    stage: status === 'running' ? 'collecting' : status === 'blocked' ? 'reviewing' : 'publishing',
    status,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp + 1000,
    asOf: '2026-09-23',
    outputDir: longPath.slice(0, longPath.lastIndexOf('\\')),
    questions: [
      { id: 'q1', text: 'Welche Aussagen werden durch die aktuelle Primärquelle getragen?', requiresFreshness: true },
      { id: 'q2', text: 'Welche Einschränkungen und Unterschiede sind dokumentiert?', requiresFreshness: false },
    ],
    sources: [
      {
        id: 's1',
        title: 'Offizielle Dokumentation – UI-Testquelle mit aktuellem Veröffentlichungsdatum',
        url: 'https://example.com/docs',
        publisher: 'Beispielanbieter',
        capturedAt: timestamp + 100,
        publishedAt: '2026-09-22',
        contentHash: 'ui-fixture-source-hash',
        readReceiptId: 'ui-fixture-read',
        kind: 'web',
        coverage: 'partial',
        segments: [
          {
            id: 'p1',
            text: 'Synthetischer gelesener Abschnitt für die Prüfung der Darstellung.',
            locator: 'Abschnitt: Funktionsumfang',
          },
        ],
      },
      {
        id: 's2',
        title:
          'Technischer_Bericht_mit_extrem_langem_Titel_fuer_die_Pruefung_des_Zeilenumbruchs_und_der_Quellendarstellung_ohne_Leerzeichen.pdf',
        url: 'https://example.com/reports/test.pdf',
        capturedAt: timestamp + 200,
        contentHash: 'ui-fixture-pdf-hash',
        readReceiptId: 'ui-fixture-pdf-read',
        kind: 'file',
        coverage: 'complete',
        segments: [{ id: 'page1', text: 'Weitere synthetische Testdaten.', locator: 'Seite 1' }],
      },
    ],
    claims: [
      {
        id: 'c1',
        text: 'Die Testquelle unterstützt die erste Beispielaussage.',
        questionIds: ['q1'],
        evidence: [{ sourceId: 's1', segmentId: 'p1' }],
      },
      {
        id: 'c2',
        text: 'Die zweite Testquelle beschreibt Grenzen und Unterschiede.',
        questionIds: ['q2'],
        evidence: [{ sourceId: 's2', segmentId: 'page1' }],
      },
    ],
    artifacts: [
      {
        id: 'file1',
        path: longPath,
        kind: 'download',
        contentHash: 'ui-fixture-file-hash',
        verifiedAt: timestamp + 500,
      },
    ],
    blockers:
      status === 'blocked'
        ? [
            'Die aktuelle Versionsangabe widerspricht einer älteren offiziellen Übersicht. Die erste Kernfrage bleibt offen, bis dieser Widerspruch anhand einer aktuellen Quelle geklärt ist.',
          ]
        : [],
  }
  if (status === 'completed') {
    Object.assign(
      run,
      applyResearchReview(
        run,
        {
          summary: 'Synthetische UI-Prüfung.',
          issues: [],
          claims: run.claims.map(claim => ({
            claimId: claim.id,
            supported: true,
            freshness: 'current',
            explanation: 'UI-Testbeleg unabhängig geprüft (synthetischer Zustand).',
          })),
        },
        requiredResearchReviewReceipts(run),
        timestamp + 800
      )
    )
    run.report = {
      markdownPath: 'bericht.md',
      htmlPath: 'bericht.html',
      verifiedAt: timestamp + 1000,
      contentFingerprint: researchEvidenceFingerprint(run),
    }
  } else if (status === 'blocked') run.report = { markdownPath: 'bericht.md', htmlPath: 'bericht.html' }
  return run
}

createApp({
  setup() {
    const theme = ref<'light' | 'dark'>('dark')
    const event = ref('UI-Testdaten: Aktionen ändern ausschließlich diese Vorschau.')
    const runs = ref([sample('running', 'running'), sample('blocked', 'blocked'), sample('completed', 'completed')])
    const setTheme = (value: 'light' | 'dark') => {
      theme.value = value
      document.documentElement.dataset.theme = value
    }
    const action = (id: string, name: string, status?: ResearchRun['status']) => {
      const run = runs.value.find(item => item.id === id)
      if (run && status) run.status = status
      event.value = `UI-Testaktion: ${name} (${id}). Keine native Aktion ausgeführt.`
    }
    return () =>
      h('main', { class: 'research-fixture ai-workspace' }, [
        h('header', { class: 'research-fixture__header' }, [
          h('div', [
            h('h1', 'Deep Research · UI-Testdaten'),
            h(
              'p',
              { class: 'research-fixture__notice' },
              'Echte ResearchRunCard mit synthetischen Zuständen. Diese Seite prüft Layout, Themes und Bedienbarkeit. Sie startet keine Recherche und greift auf keine Produktdaten zu.'
            ),
          ]),
          h('div', { class: 'research-fixture__themes', 'aria-label': 'Theme der Vorschau' }, [
            h(
              'button',
              { type: 'button', 'aria-pressed': theme.value === 'light', onClick: () => setTheme('light') },
              'Hell'
            ),
            h(
              'button',
              { type: 'button', 'aria-pressed': theme.value === 'dark', onClick: () => setTheme('dark') },
              'Dunkel'
            ),
          ]),
        ]),
        ...runs.value.flatMap((run, index) => [
          h(
            'p',
            { class: 'research-fixture__label', id: `case-${run.id}` },
            `${index + 1}. UI-Testzustand · ${run.id}`
          ),
          h(ResearchRunCard, {
            key: run.id,
            run,
            onPause: () => action(run.id, 'Pausieren', 'paused'),
            onResume: () => action(run.id, 'Fortsetzen', 'running'),
            onStop: () => action(run.id, 'Stoppen', 'cancelled'),
            'onOpen-report': () => action(run.id, 'Bericht öffnen'),
            'onOpen-folder': () => action(run.id, 'Ordner öffnen'),
          }),
        ]),
        h('p', { class: 'research-fixture__event', role: 'status', 'aria-live': 'polite' }, event.value),
      ])
  },
}).mount('#app')
