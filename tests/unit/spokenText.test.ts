import { describe, expect, it } from 'vitest'
import { prepareSpokenText } from '@/services/voice/spokenText'

describe('German speech text preparation', () => {
  it('reads common symbols, temperatures and statuses as words with natural spacing', () => {
    expect(prepareSpokenText('✅ Preis: 12,50 € & 20% Rabatt. 22 °C → 71 °F. ⚠️ A+B=3 ≠ 4.').text).toBe(
      'erledigt Preis: 12,50 Euro und 20 Prozent Rabatt. 22 Grad Celsius nach 71 Grad Fahrenheit. Achtung A plus B gleich 3 ungleich 4.'
    )
  })

  it('preserves paragraphs, ordinary punctuation and exact numbers', () => {
    const text = '„Hallo!“\r\n\r\nVersion 2.9.3: 1.234,56 — wirklich? (Ja); fertig.'
    expect(prepareSpokenText(text).text).toBe('„Hallo!“\n\nVersion 2.9.3: 1.234,56 — wirklich? (Ja); fertig.')
  })

  it('omits markup while reading headings, links, emphasis, quotes and task states', () => {
    const text =
      '# **Ergebnis**\n\n> Ein *guter* [Link](https://example.org/a_(b)?x=1&y=2).\n\n- [x] Fertig\n- [ ] Noch __offen__\n\n---'
    expect(prepareSpokenText(text).text).toBe('Ergebnis\n\nEin guter Link.\n\nerledigt Fertig\noffen Noch offen')
  })

  it('keeps code meaningful and does not interpret its content as Markdown', () => {
    const text = 'Code `file_name = 2 * 3` bleibt.\n```php\n$value = "**literal**";\n```'
    expect(prepareSpokenText(text).text).toBe(
      'Code file Unterstrich name gleich 2 mal 3 bleibt.\n\nDollar value gleich " Sternchen Sternchen literal Sternchen Sternchen ";'
    )
  })

  it('reads table values in order, omitting alignment and edge pipes', () => {
    const text = '| Modell | Anteil |\n|:---|---:|\n| **Lokal** | 90% |\n| Cloud | 10% |'
    expect(prepareSpokenText(text).text).toBe('Modell, Anteil\n\nLokal, 90 Prozent\nCloud, 10 Prozent')
  })

  it('does not delete unknown Unicode, identifiers, comparisons or escaped literal symbols', () => {
    expect(prepareSpokenText('😀 Grüße e\u0301 file_name: x < 2; C#; 2 × 3 ÷ 6. \\*Wort\\*').text).toBe(
      '😀 Grüße e\u0301 file Unterstrich name: x kleiner als 2; C Raute; 2 mal 3 geteilt durch 6. Sternchen Wort Sternchen'
    )
  })

  it('maps every expanded word to its source symbol and unchanged labels to their source letters', () => {
    const source = '**Preis**: [Euro](https://example.org) 20% ✅'
    const result = prepareSpokenText(source, 120)
    for (const word of ['Prozent', 'erledigt']) {
      const spokenStart = result.text.indexOf(word)
      const sourceStart = source.indexOf(word === 'Prozent' ? '%' : '✅') + 120
      expect(result.sourcePositions.slice(spokenStart, spokenStart + word.length)).toEqual(
        Array(word.length).fill(sourceStart)
      )
    }
    const spokenLabel = result.text.indexOf('Euro')
    expect(result.sourcePositions.slice(spokenLabel, spokenLabel + 4)).toEqual([132, 133, 134, 135])
    expect(result.sourcePositions.at(-1)).toBe(120 + source.length)
  })

  it.each([
    '',
    '   ',
    '# **Hallo**\r\n\r\n22°C ✅ erledigt.',
    '[**Link**](https://example.org) und ~~alt~~, _neu_.',
    '😀 e\u0301 ⚠️ € & < >',
    '```\n# Code\n| a | b |\n```',
    '| A | B |\n|---|---|\n| 1 | 2 |',
    '\\*literal\\* **nicht fertig',
  ])('has a monotone complete source mapping for %j', source => {
    const result = prepareSpokenText(source, 23)
    expect(result.sourcePositions).toHaveLength(result.text.length + 1)
    expect(result.sourcePositions.at(-1)).toBe(source.length + 23)
    result.sourcePositions.forEach((position, index) => {
      expect(Number.isInteger(position)).toBe(true)
      expect(position).toBeGreaterThanOrEqual(index ? result.sourcePositions[index - 1]! : 23)
      expect(position).toBeLessThanOrEqual(source.length + 23)
    })
  })

  it('maps surrogate pairs to their complete source code point', () => {
    const result = prepareSpokenText('😀 ✅', 7)
    expect(result.sourcePositions.slice(0, 2)).toEqual([7, 7])
    expect(result.sourcePositions.slice(result.text.indexOf('erledigt'), -1)).toEqual(Array('erledigt'.length).fill(10))
  })
})
