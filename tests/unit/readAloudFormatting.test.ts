import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import StreamingText from '@/components/ai/StreamingText.vue'
import ReadAloudText from '@/components/ai/ReadAloudText.vue'
import { beginReadAlong, endReadAlong, readAlongState, updateReadAlong } from '@/services/voice/readAlong'
import {
  createReadAloudHighlight,
  currentSpeechTextMatch,
  mapSpeechTextChunks,
} from '@/services/voice/readAloudHighlight'

afterEach(() => {
  if (readAlongState.value) endReadAlong(readAlongState.value.owner)
  vi.unstubAllGlobals()
})

describe('read-aloud source mapping', () => {
  it('maps repeated words past hidden link destinations and ordered list markers', () => {
    const source = '[Wort](https://example.test/Wort) Wort\n\n1. 1 bleibt **fett**.'
    const matches = mapSpeechTextChunks(source, ['Wort', ' Wort', '1 bleibt ', 'fett', '.'])
    expect(matches.map(match => source.slice(match.start, match.end))).toEqual([
      'Wort',
      'Wort',
      '1',
      'bleibt',
      'fett',
      '.',
    ])
    expect(matches[1]?.start).toBe(source.indexOf(' Wort') + 1)
    expect(matches[2]?.start).toBe(source.indexOf('1 bleibt'))
  })

  it('retains literal inline and fenced code while excluding fence language labels', () => {
    const source = '## Code\n\n`[Wort](https://example.test)`\n\n```Wort\nWort\n1. genau\n```\n\nEnde'
    const chunks = ['Code', '[Wort](https://example.test)', 'Wort', '1. genau', 'Ende']
    const matches = mapSpeechTextChunks(source, chunks)
    expect(matches.map(match => source.slice(match.start, match.end))).toEqual([
      'Code',
      '[Wort](https://example.test)',
      'Wort',
      '1.',
      'genau',
      'Ende',
    ])
    expect(matches[2]?.start).toBe(source.indexOf('\nWort\n') + 1)
  })

  it('maps table cells, nested lists, entities, Unicode and formatted words to raw offsets', () => {
    const source =
      '> Prüfung **größer** & 🙂\r\n\r\n- Erste\r\n  - Zweite\r\n\r\n| A | B |\r\n|---|---|\r\n| 2 | <script> |'
    const chunks = ['Prüfung ', 'größer', ' & 🙂', 'Erste', 'Zweite', 'A', 'B', '2', '<script>']
    const matches = mapSpeechTextChunks(source, chunks)
    expect(matches.map(match => source.slice(match.start, match.end))).toEqual([
      'Prüfung',
      'größer',
      '&',
      '🙂',
      'Erste',
      'Zweite',
      'A',
      'B',
      '2',
      '<script>',
    ])
    const current = currentSpeechTextMatch(matches, source.indexOf('größer') + 2)
    expect(current).toMatchObject({ chunk: 1, offset: 0, start: source.indexOf('größer') })
  })

  it('keeps already spoken offsets stable when later paragraphs arrive', () => {
    const prefix = 'Erster Absatz.\n\nZweiter **Absatz**.'
    const current = (source: string, chunks: string[]) =>
      currentSpeechTextMatch(mapSpeechTextChunks(source, chunks), prefix.indexOf('Zweiter') + 3)
    expect(current(prefix, ['Erster Absatz.', 'Zweiter ', 'Absatz', '.'])).toEqual(
      current(prefix + '\n\nSpäterer Text.', ['Erster Absatz.', 'Zweiter ', 'Absatz', '.', 'Späterer Text.'])
    )
  })

  it('does not invent a match for missing source text or invalid positions', () => {
    expect(mapSpeechTextChunks('Original', ['Nicht vorhanden'])).toEqual([])
    expect(currentSpeechTextMatch([], 3)).toBeNull()
    expect(currentSpeechTextMatch(mapSpeechTextChunks('Original', ['Original']), Number.NaN)).toBeNull()
  })

  it('maps a final question past the last answer word using the server source separator', () => {
    const body = 'Die **Antwort** ist fertig.'
    const question = 'Welche Datei prüfen?'
    const source = `${body}\n\n${question}`
    const start = body.length + 2
    const matches = mapSpeechTextChunks(source, ['Die ', 'Antwort', ' ist fertig.', question])
    expect(currentSpeechTextMatch(matches, start)).toMatchObject({ chunk: 3, offset: 0, start })
    expect(currentSpeechTextMatch(matches, source.indexOf('Datei'))).toMatchObject({ chunk: 3, offset: 7 })
  })

  it('maps the final question after a closed code block', () => {
    const body = '```ts\nconst ready = true\n```'
    const question = 'Welche Datei prüfen?'
    const source = `${body}\n\n${question}`
    const start = body.length + 2
    const matches = mapSpeechTextChunks(source, ['const ready = true', question])
    expect(matches.filter(match => match.chunk === 1).map(match => source.slice(match.start, match.end))).toEqual([
      'Welche',
      'Datei',
      'prüfen?',
    ])
    expect(currentSpeechTextMatch(matches, start)).toMatchObject({ chunk: 1, offset: 0, start })
  })
})

describe('non-destructive range painting', () => {
  it('registers ranges and protects the newer owner from stale cleanup', () => {
    const registry = new Map()
    class FakeHighlight {
      constructor(public range: Range) {}
    }
    vi.stubGlobal('CSS', { highlights: registry })
    vi.stubGlobal('Highlight', FakeHighlight)
    const old = createReadAloudHighlight()
    const current = createReadAloudHighlight()
    const firstRange = {} as Range
    const secondRange = {} as Range
    expect(old.show(firstRange)).toBe(true)
    expect(current.show(secondRange)).toBe(true)
    old.clear()
    expect(registry.get('luczor-read-aloud').range).toBe(secondRange)
    current.clear()
    expect(registry.size).toBe(0)
  })

  it('does not replace text when the browser lacks the Highlight API', () => {
    vi.stubGlobal('CSS', {})
    vi.stubGlobal('Highlight', undefined)
    expect(createReadAloudHighlight().show({} as Range)).toBe(false)
  })
})

describe('rich content while speaking', () => {
  const content =
    '## Ergebnis\n\n**Fett** und [Link](https://example.test).\n\n- Eins\n- Zwei\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = "<script>"\n```'
  const render = () =>
    renderToString(
      createSSRApp(StreamingText, {
        content,
        speechKey: 'answer',
        question: 'Wie weiter?',
        actions: false,
      })
    )
  const body = (html: string) =>
    html.slice(html.indexOf('<div class="ai-answer__body"'), html.indexOf('<p class="ai-answer__question"'))

  it('keeps identical rendered answer HTML before, during and after speech', async () => {
    const before = await render()
    const owner = beginReadAlong('answer', content)
    updateReadAlong(owner, 'playing', content.indexOf('Fett'))
    const during = await render()
    endReadAlong(owner)
    const after = await render()
    expect(body(during)).toBe(body(before))
    expect(body(after)).toBe(body(before))
    expect(during).toContain('Wird vorgelesen')
    expect(during).toContain('Wie weiter?')
    expect(during).toContain('<strong>Fett</strong>')
    expect(during).toContain('data-href="https://example.test"')
    expect(during).toContain('<table class="rt-table">')
    expect(during).toContain('Code kopieren')
    expect(during).not.toContain('<script>')
  })

  it('renders the latest streamed text even when playback still uses an older prefix', async () => {
    const owner = beginReadAlong('answer', 'Schon gesprochen.')
    updateReadAlong(owner, 'playing', 6)
    const html = await renderToString(
      createSSRApp(StreamingText, {
        content: 'Schon gesprochen.\n\n## Gerade angekommen\n\nWeiterer Text',
        speechKey: 'answer',
        streaming: true,
        actions: false,
      })
    )
    expect(html).toContain('Gerade angekommen')
    expect(html).toContain('Weiterer Text')
    expect(html).toContain('ai-stream-caret')
    expect(html).not.toContain('Antwort kopieren')
  })

  it('keeps the normal question inside the persistent read-aloud content while the question is spoken', async () => {
    const answer = 'Antwort fertig.'
    const question = 'Welche Datei prüfen?'
    const owner = beginReadAlong('answer', `${answer}\n\n${question}`)
    updateReadAlong(owner, 'playing', answer.length + 2)
    const html = await renderToString(
      createSSRApp(StreamingText, {
        content: answer,
        question,
        speechKey: 'answer',
        followUps: ['Nächster Schritt'],
        actions: false,
      })
    )
    expect(html).toContain('<p class="ai-answer__question">Welche Datei prüfen?</p>')
    expect(html).toMatch(
      /<div class="read-aloud__content"[^>]*>[\s\S]*<p class="ai-answer__question">Welche Datei prüfen\?<\/p><!--\]--><\/div><\/div>/u
    )
    expect(html).toContain('Nächster Schritt')
    expect(html.indexOf('ai-follow-ups')).toBeGreaterThan(html.indexOf('ai-answer__question'))
  })

  it('also renders standalone read-aloud text through the existing safe Markdown renderer', async () => {
    const html = await renderToString(
      createSSRApp(ReadAloudText, {
        playback: {
          owner: 1,
          key: 'selection',
          text: '**Auswahl**\n\n<script>Test</script>',
          phase: 'playing',
          position: 2,
        },
      })
    )
    expect(html).toContain('<strong>Auswahl</strong>')
    expect(html).toContain('&lt;script&gt;Test&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
})
