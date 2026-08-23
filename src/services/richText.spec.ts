import { describe, expect, it } from 'vitest'
import { escapeHtml, renderInline, renderRichText } from './richText'

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('renderRichText — security', () => {
  it('never emits model-supplied tags', () => {
    const html = renderRichText('<script>alert(1)</script><img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('does not allow raw HTML through a code fence', () => {
    const html = renderRichText('```html\n<script>bad()</script>\n```')
    expect(html).not.toContain('<script>bad()')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
  })

  it('rejects javascript: and data: links', () => {
    expect(renderRichText('[klick](javascript:alert(1))')).not.toContain('data-href')
    expect(renderRichText('[klick](data:text/html;base64,PHN2Zz4=)')).not.toContain('data-href')
  })

  it('emits links without a real href attribute so the webview cannot navigate', () => {
    const html = renderRichText('[Doku](https://example.org/a)')
    expect(html).toContain('data-href="https://example.org/a"')
    // A genuine href attribute is preceded by whitespace; `data-href` is not.
    expect(html).not.toMatch(/\shref=/)
  })

  it('strips private-use marker characters from the input', () => {
    const html = renderRichText('a\uE000123\uE001b')
    expect(html).not.toContain('\uE000')
    expect(html).toContain('a123b')
  })
})

describe('renderRichText — blocks', () => {
  it('renders unordered and ordered lists', () => {
    expect(renderRichText('- eins\n- zwei')).toBe(
      '<ul class="rt-list"><li class="rt-li">eins</li><li class="rt-li">zwei</li></ul>'
    )
    expect(renderRichText('1. eins\n2. zwei')).toContain('<ol class="rt-list">')
  })

  it("keeps an ordered list's start number", () => {
    expect(renderRichText('3. drei')).toContain('start="3"')
  })

  it('nests sublists inside the opening item', () => {
    const html = renderRichText('- oben\n  - unten')
    expect(html).toContain('<li class="rt-li">oben<ul class="rt-list">')
    expect(html).toContain('unten')
    // The nested list must close before its parent item does.
    expect(html).toContain('</ul></li></ul>')
  })

  it('renders headings as chat-sized tags', () => {
    expect(renderRichText('# Titel')).toContain('<h3')
    expect(renderRichText('### Klein')).toContain('<h5')
  })

  it('renders a table with alignment', () => {
    const html = renderRichText('| A | B |\n| --- | ---: |\n| 1 | 2 |')
    expect(html).toContain('<table class="rt-table">')
    expect(html).toContain('<th>A</th>')
    expect(html).toContain('style="text-align:right"')
    expect(html).toContain('<td>1</td>')
  })

  it('renders a fenced code block with its language label', () => {
    const html = renderRichText('```ts\nconst a = 1;\n```')
    expect(html).toContain('<div class="rt-code">')
    expect(html).toContain('const a = 1;')
    expect(html).toContain('rt-code__lang">ts<')
  })

  it('renders an unterminated fence (still streaming)', () => {
    const html = renderRichText('```py\nprint(1)')
    expect(html).toContain('print(1)')
  })

  it('renders blockquotes and rules', () => {
    expect(renderRichText('> zitat')).toContain('<blockquote class="rt-quote">')
    expect(renderRichText('---')).toContain('<hr class="rt-hr" />')
  })

  it('joins wrapped paragraph lines with a line break', () => {
    expect(renderRichText('eine zeile\nzweite zeile')).toBe('<p class="rt-p">eine zeile<br />zweite zeile</p>')
  })

  it('returns an empty string for blank input', () => {
    expect(renderRichText('   \n  ')).toBe('')
    expect(renderRichText('')).toBe('')
  })
})

describe('renderInline', () => {
  it('renders bold, italic, strike and inline code', () => {
    expect(renderInline('**fett**')).toBe('<strong>fett</strong>')
    expect(renderInline('*kursiv*')).toBe('<em>kursiv</em>')
    expect(renderInline('~~weg~~')).toBe('<s>weg</s>')
    expect(renderInline('`code`')).toBe('<code class="rt-code-inline">code</code>')
  })

  it('keeps markdown inside inline code literal', () => {
    expect(renderInline('`**nicht fett**`')).toBe('<code class="rt-code-inline">**nicht fett**</code>')
  })

  it('linkifies bare URLs', () => {
    expect(renderInline('siehe https://example.org')).toContain('data-href="https://example.org"')
  })

  it('does not linkify inside an already emitted anchor', () => {
    const html = renderInline('[x](https://example.org)')
    expect(html.match(/data-href/g)).toHaveLength(1)
  })
})
