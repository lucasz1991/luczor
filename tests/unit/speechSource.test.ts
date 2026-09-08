import { describe, expect, it, vi } from 'vitest'
import { createSpeechSource, SPEECH_CHUNK_LIMIT } from '@/services/voice/speechSource'

const signal = () => new AbortController().signal

async function collect(source: ReturnType<typeof createSpeechSource>) {
  const parts: { text: string; start: number }[] = []
  for (let part = await source.next(signal()); part; part = await source.next(signal())) parts.push(part)
  return parts
}

describe('progressive speech source', () => {
  it('waits for two complete paragraphs and keeps the next incomplete paragraph buffered', async () => {
    const source = createSpeechSource('', { key: 'message:answer' })
    const received = vi.fn()
    const first = source.next(signal()).then(part => {
      received(part)
      return part
    })
    source.update('Erster Absatz.\n\nZweiter Absatz')
    expect(source.ready).toBe(false)
    await Promise.resolve()
    expect(received).not.toHaveBeenCalled()
    source.update('Erster Absatz.\n\nZweiter Absatz.\n\nAngefan')
    expect(source.ready).toBe(true)
    expect(await first).toEqual({ text: 'Erster Absatz.\n\nZweiter Absatz.\n\n', start: 0 })
    expect(source.started).toBe(true)
    expect(source.ready).toBe(false)
    source.update('Erster Absatz.\n\nZweiter Absatz.\n\nAngefangen und fertig.', true)
    expect(await source.next(signal())).toEqual({ text: 'Angefangen und fertig.', start: 33 })
    expect(await source.next(signal())).toBeNull()
  })

  it('starts a long unbroken paragraph at a complete sentence without reading the partial tail', async () => {
    const sentence = `${'zusammenhängender Text '.repeat(20).trim()}. `
    const text = sentence + 'Fortlaufender Text '.repeat(40) + 'Wortfrag'
    const source = createSpeechSource(text)
    expect(text.length).toBeGreaterThan(SPEECH_CHUNK_LIMIT)
    expect(source.ready).toBe(true)
    expect(await source.next(signal())).toEqual({ text: sentence, start: 0 })
    expect(source.ready).toBe(false)
    source.cancel()
  })

  it('waits for completion when a long stream has neither a sentence nor a paragraph boundary', async () => {
    const text = 'laufendes Wort '.repeat(100) + 'frag'
    const source = createSpeechSource(text)
    expect(source.ready).toBe(false)
    source.update(text + 'ment', true)
    const parts = await collect(source)
    expect(parts.map(part => part.text).join('')).toBe(text + 'ment')
    for (const part of parts.slice(0, -1)) expect(part.text).toMatch(/\s$/u)
  })

  it('continues reading new stream batches without repeating committed text or altering offsets', async () => {
    const beginning = '  **Erster Absatz.**\r\n\r\nZweiter Absatz mit € und 😀.\r\n\r\n'
    const middle = `${'Weiterer vollständiger Satz. '.repeat(12)}\n\n`
    const tail = '_Abschluss_ ohne Absatzumbruch.'
    const source = createSpeechSource(beginning)
    const parts = [await source.next(signal())]
    expect(parts[0]).toEqual({ text: beginning, start: 0 })
    source.update(beginning + middle)
    expect(source.ready).toBe(true)
    parts.push(await source.next(signal()))
    source.update(beginning + middle + tail, true, 'retained:answer')
    parts.push(...(await collect(source)))
    const whole = beginning + middle + tail
    let cursor = 0
    for (const part of parts) {
      expect(part).not.toBeNull()
      expect(part!.start).toBe(cursor)
      expect(whole.slice(part!.start, part!.start + part!.text.length)).toBe(part!.text)
      cursor += part!.text.length
    }
    expect(parts.map(part => part!.text).join('')).toBe(whole)
    expect(source.snapshot()).toEqual({ text: whole, key: 'retained:answer' })
  })

  it('does not treat empty lines or sentence punctuation inside an open code block as readiness', async () => {
    const open = `\`\`\`typescript\nconst first = "Satz.";\n\n${'const more = "Fortsetzung.";\n'.repeat(45)}\n`
    const source = createSpeechSource(open)
    expect(source.ready).toBe(false)
    const completeBlock = open + '```\n\n'
    source.update(completeBlock + 'Noch nicht abgeschlossen')
    expect(source.ready).toBe(false)
    source.update(completeBlock + 'Jetzt fertig.\n\n')
    expect(source.ready).toBe(true)
    source.update(completeBlock + 'Jetzt fertig.\n\n', true)
    expect((await collect(source)).map(part => part.text).join('')).toBe(completeBlock + 'Jetzt fertig.\n\n')
  })

  it('can read completed prose before a later open code block', async () => {
    const ready = 'Erster Absatz.\n\nZweiter Absatz.\n\n'
    const source = createSpeechSource(ready + '```\nNoch offener Code.\n\n')
    expect(await source.next(signal())).toEqual({ text: ready, start: 0 })
    expect(source.ready).toBe(false)
    source.cancel()
  })

  it('cancels pending reads and ignores later updates', async () => {
    const source = createSpeechSource('Anfang', { key: 'initial' })
    const pending = source.next(signal())
    source.cancel()
    expect(await pending).toBeNull()
    source.update('Neue Antwort.', true, 'changed')
    expect(source.cancelled).toBe(true)
    expect(source.ready).toBe(false)
    expect(source.snapshot()).toEqual({ text: 'Anfang', key: 'initial' })
  })

  it('honors abort before and during a wait without consuming text', async () => {
    const source = createSpeechSource('Noch nicht fertig')
    const controller = new AbortController()
    const pending = source.next(controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(source.next(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    source.update('Noch nicht fertig, jetzt aber.', true)
    expect(await source.next(signal())).toEqual({ text: 'Noch nicht fertig, jetzt aber.', start: 0 })
  })

  it('permits edits to the buffered draft but cancels a rewrite of already committed text', async () => {
    const source = createSpeechSource('Entwurf')
    const ready = 'Erster Absatz.\n\nZweiter Absatz.\n\n'
    source.update(ready + 'Entwurf')
    expect(source.cancelled).toBe(false)
    expect(await source.next(signal())).toEqual({ text: ready, start: 0 })
    source.update(ready + 'Korrigierter Rest')
    expect(source.cancelled).toBe(false)
    const pending = source.next(signal())
    source.update('Geänderter erster Absatz.\n\nZweiter Absatz.\n\nRest', true)
    expect(source.cancelled).toBe(true)
    expect(await pending).toBeNull()
  })

  it('does not split words or surrogate pairs at normal chunk boundaries', async () => {
    const text = `${'Vollständige Wörter mit 😀 bleiben zusammen. '.repeat(50)}Fertig.`
    const source = createSpeechSource(text, { complete: true })
    const parts = await collect(source)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map(part => part.text).join('')).toBe(text)
    for (const part of parts.slice(0, -1)) {
      expect(part.text).toMatch(/[.!?\s]$/u)
      expect(part.text).not.toMatch(/[\uD800-\uDBFF]$/u)
    }
  })

  it('uses tabs and line breaks as word boundaries when long text has no ordinary spaces', async () => {
    const text = 'Einzelwort\tWeitereswort\n'.repeat(80)
    const source = createSpeechSource(text, { complete: true })
    const parts = await collect(source)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map(part => part.text).join('')).toBe(text)
    for (const part of parts.slice(0, -1)) expect(part.text).toMatch(/\s$/u)
  })

  it('notifies retained-source observers and respects unsubscription and finality', async () => {
    const source = createSpeechSource('', { key: 'draft' })
    const observe = vi.fn(() => source.snapshot())
    const unsubscribe = source.subscribe(observe)
    source.update('Absatz eins.\n\nAbsatz zwei.\n\n')
    source.update('Absatz eins.\n\nAbsatz zwei.\n\nFertig.', true, 'final')
    expect(observe.mock.results.at(-1)?.value).toEqual({
      text: 'Absatz eins.\n\nAbsatz zwei.\n\nFertig.',
      key: 'final',
    })
    source.update('Nicht mehr zulässig', true, 'wrong')
    expect(observe).toHaveBeenCalledTimes(2)
    unsubscribe()
    source.cancel()
    expect(observe).toHaveBeenCalledTimes(2)
  })
})
