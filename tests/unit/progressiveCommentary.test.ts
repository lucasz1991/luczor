import { describe, expect, it, vi } from 'vitest'
import type { ChatCommentary, Message } from '@/state/types'
import { createCommentarySpeechQueue } from '@/services/voice/commentarySpeech'
import { createProgressiveCommentary } from '@/services/voice/progressiveCommentary'

type SpeechMessage = Pick<Message, 'content' | 'meta'>
type Speaker = Parameters<typeof createCommentarySpeechQueue>[0]['speak']

function retained(content: string, round = 1, serverSpeechAllowed = true): ChatCommentary {
  return { id: `round-${round}`, round, content, createdAt: round, serverSpeechAllowed }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

function setup(options: { allowLocalContent?: () => boolean; canSpeak?: () => boolean | Promise<boolean> } = {}) {
  let message: SpeechMessage | undefined
  const clips: { text: string; start: number; key: string }[] = []
  const speak = vi.fn<Speaker>(async (text, settings) => {
    if (!settings.source) {
      if (!(await settings.beforeChunk())) return 'cancelled'
      clips.push({ text, start: 0, key: settings.key })
      return 'completed'
    }
    while (!settings.signal.aborted) {
      const part = await settings.source.next(settings.signal)
      if (!part) return settings.source.cancelled ? 'cancelled' : 'completed'
      if (!(await settings.beforeChunk())) return 'cancelled'
      clips.push({ ...part, key: settings.source.snapshot().key })
    }
    return 'cancelled'
  })
  const queue = createCommentarySpeechQueue({
    speak,
    canSpeak: options.canSpeak ?? (() => true),
    allowLocalContent: options.allowLocalContent ?? (() => true),
    isCurrent: scope => scope === 'project:turn',
  })
  const coordinator = createProgressiveCommentary({
    scope: 'project:turn',
    answerKey: 'message:answer',
    queue,
    readMessage: () => message,
  })
  return {
    queue,
    speak,
    clips,
    coordinator,
    setMessage: (value: SpeechMessage | undefined) => {
      message = value
    },
  }
}

describe('progressive commentary coordination', () => {
  it('retracts active speech, permits a fresh source even with the same prefix, and never speaks the reset', async () => {
    const test = setup()
    const prefix = 'Erster Absatz.\n\nZweiter Absatz.\n\n'
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(1))
    const oldSettings = test.speak.mock.calls[0]![1]
    test.coordinator.resetCurrent()
    expect(oldSettings.signal.aborted).toBe(true)
    expect(oldSettings.source!.cancelled).toBe(true)
    test.setMessage({ content: '', meta: { isLoading: true } })
    test.coordinator.update()
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(2))
    test.setMessage({ content: prefix + 'Korrigierte Antwort.', meta: {} })
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips.map(clip => clip.text)).toEqual([prefix, prefix, 'Korrigierte Antwort.'])
    expect(test.speak).toHaveBeenCalledTimes(2)
  })

  it('removes queued rejected speech without deleting an already completed commentary', async () => {
    const enabled = deferred<boolean>()
    const test = setup({ canSpeak: () => enabled.promise })
    test.setMessage({ content: 'Geprüftes Werkzeugergebnis.', meta: {} })
    test.coordinator.completeCommentary(retained('Geprüftes Werkzeugergebnis.'))
    test.setMessage({ content: 'Falscher Absatz.\n\nFalscher Absatz.\n\n', meta: { isLoading: true } })
    test.coordinator.update()
    test.coordinator.resetCurrent()
    test.setMessage({ content: 'Neue richtige Antwort.', meta: {} })
    test.coordinator.completeAnswer()
    enabled.resolve(true)
    await test.queue.drain()
    expect(test.clips.map(clip => clip.text)).toEqual(['Geprüftes Werkzeugergebnis.', 'Neue richtige Antwort.'])
  })

  it('does not enqueue incomplete text and reads a short final answer exactly once', async () => {
    const test = setup()
    test.setMessage({ content: 'Ein kurzer noch unvollständiger Absatz', meta: { isLoading: true } })
    test.coordinator.update()
    await test.queue.drain()
    expect(test.speak).not.toHaveBeenCalled()
    test.setMessage({ content: 'Ein kurzer vollständiger Absatz.', meta: { isLoading: false } })
    test.coordinator.completeAnswer()
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips).toEqual([{ text: 'Ein kurzer vollständiger Absatz.', start: 0, key: 'message:answer' }])
  })

  it('reads a live round, its appended tail and a subsequent final answer without replaying the round', async () => {
    const test = setup()
    const prefix = 'Die Struktur ist geladen.\n\nIch prüfe die betroffenen Dateien.\n\n'
    const tail = 'Die Prüfung ist abgeschlossen.'
    test.setMessage({
      content: prefix,
      meta: { isLoading: true, dataHandling: 'ephemeral', serverSpeechAllowed: false },
    })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(1))
    test.setMessage({ content: prefix + tail, meta: { isLoading: true } })
    test.coordinator.update()
    test.coordinator.completeCommentary(retained(prefix + tail))
    test.setMessage({ content: 'Das endgültige Ergebnis.', meta: {} })
    test.coordinator.update()
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips.map(clip => clip.text)).toEqual([prefix, tail, 'Das endgültige Ergebnis.'])
    expect(test.clips.map(clip => clip.key)).toEqual(['message:answer', 'message:round-1', 'message:answer'])
    expect(test.clips[1]?.start).toBe(prefix.length)
    expect(test.speak).toHaveBeenCalledTimes(2)
  })

  it('continues the same progressive answer while its visible text is still streaming', async () => {
    const test = setup()
    const prefix = 'Absatz eins.\n\nAbsatz zwei.\n\n'
    const next = `${'Ein ausführlicher neuer Absatz. '.repeat(10)}\n\n`
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(1))
    test.setMessage({ content: prefix + next + 'Restfrag', meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(2))
    expect(test.clips[1]?.text).toBe(next)
    expect(test.clips[1]?.start).toBe(prefix.length)
    expect(test.speak).toHaveBeenCalledOnce()
    test.setMessage({ content: prefix + next + 'Restfragment fertig.', meta: {} })
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips.map(clip => clip.text).join('')).toBe(prefix + next + 'Restfragment fertig.')
    expect(test.speak).toHaveBeenCalledOnce()
  })

  it('retains original whitespace and source offsets when finalizing an already spoken answer', async () => {
    const test = setup()
    const prefix = '  **Erster Absatz.**\n\nZweiter Absatz.\n\n'
    const tail = '_Letzter Absatz._  '
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(1))
    test.setMessage({ content: prefix + tail, meta: {} })
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips).toEqual([
      { text: prefix, start: 0, key: 'message:answer' },
      { text: tail, start: prefix.length, key: 'message:answer' },
    ])
    expect(test.speak).toHaveBeenCalledOnce()
  })

  it('rebinds a queued stream to its retained message, classification and highlight key before playback', async () => {
    const settings = deferred<boolean>()
    const test = setup({ canSpeak: () => settings.promise })
    const prefix = 'Erster Absatz.\n\nZweiter Absatz.\n\n'
    test.setMessage({ content: prefix, meta: { isLoading: true, dataHandling: 'ephemeral' } })
    test.coordinator.update()
    test.coordinator.completeCommentary(retained(prefix + 'Gespeicherter Abschluss.', 4))
    test.setMessage({ content: 'Eine völlig andere neue Antwortrunde.', meta: { isLoading: true } })
    settings.resolve(true)
    await test.queue.drain()
    expect(test.speak).toHaveBeenCalledExactlyOnceWith(
      prefix + 'Gespeicherter Abschluss.',
      expect.objectContaining({ key: 'message:answer:stream-1', source: expect.any(Object) })
    )
    expect(test.clips).toEqual([{ text: prefix + 'Gespeicherter Abschluss.', start: 0, key: 'message:round-4' }])
  })

  it('blocks an unclassified live stream without consent but permits its finalized public answer', async () => {
    const test = setup({ allowLocalContent: () => false })
    const prefix = 'Öffentlicher erster Absatz.\n\nÖffentlicher zweiter Absatz.\n\n'
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await test.queue.drain()
    expect(test.speak).not.toHaveBeenCalled()
    test.setMessage({
      content: prefix + 'Öffentlicher Abschluss.',
      meta: { isLoading: false, serverSpeechAllowed: true, dataHandling: 'syncable' },
    })
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips).toEqual([{ text: prefix + 'Öffentlicher Abschluss.', start: 0, key: 'message:answer' }])
    expect(test.speak).toHaveBeenCalledOnce()
  })

  it('uses retained privacy classification before playback and never falls back to a newer public round', async () => {
    const settings = deferred<boolean>()
    const test = setup({ canSpeak: () => settings.promise, allowLocalContent: () => false })
    const prefix = 'Erster Absatz.\n\nZweiter Absatz.\n\n'
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    test.coordinator.completeCommentary(retained(prefix + 'Privater Inhalt.', 2, false))
    test.setMessage({ content: 'Eine andere öffentliche Antwort.', meta: { serverSpeechAllowed: true } })
    settings.resolve(true)
    await test.queue.drain()
    expect(test.speak).not.toHaveBeenCalled()
    expect(test.clips).toEqual([])
  })

  it('cancels pending stream reads and ignores all subsequent finish or update callbacks', async () => {
    const test = setup()
    const prefix = 'Absatz eins.\n\nAbsatz zwei.\n\n'
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(1))
    test.coordinator.cancel()
    test.setMessage({ content: prefix + 'Soll nicht mehr vorgelesen werden.', meta: {} })
    test.coordinator.update()
    test.coordinator.completeAnswer()
    test.coordinator.completeCommentary(retained('Auch dieser Kommentar nicht.'))
    await test.queue.drain()
    expect(test.clips.map(clip => clip.text)).toEqual([prefix])
    expect(test.speak).toHaveBeenCalledOnce()
  })

  it('does not replay a retained commentary when the final answer repeats that completed text', async () => {
    const test = setup()
    const prefix = 'Erster Absatz.\n\nZweiter Absatz.\n\n'
    const complete = prefix + 'Nachgereichter Abschluss.'
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(1))
    test.coordinator.completeCommentary(retained(complete))
    await test.queue.drain()
    test.setMessage({ content: complete, meta: {} })
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips.map(clip => clip.text).join('')).toBe(complete)
    expect(test.speak).toHaveBeenCalledOnce()
  })

  it('cancels a rewrite of a spoken prefix instead of combining two different answer versions', async () => {
    const test = setup()
    const prefix = 'Erste Fassung.\n\nZweiter Absatz.\n\n'
    test.setMessage({ content: prefix, meta: { isLoading: true } })
    test.coordinator.update()
    await vi.waitFor(() => expect(test.clips).toHaveLength(1))
    test.setMessage({ content: 'Geänderte Fassung.\n\nZweiter Absatz.\n\nEin anderer Abschluss.', meta: {} })
    test.coordinator.update()
    test.coordinator.completeAnswer()
    await test.queue.drain()
    expect(test.clips.map(clip => clip.text)).toEqual([prefix])
    expect(test.speak).toHaveBeenCalledOnce()
  })
})
