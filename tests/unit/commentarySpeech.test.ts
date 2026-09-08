import { describe, expect, it, vi } from 'vitest'
import { createCommentarySpeechQueue } from '@/services/voice/commentarySpeech'
import type { Message } from '@/state/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function message(content: string, meta: Message['meta'] = {}) {
  return { content, meta }
}

function setup() {
  let scope = 'turn-one'
  const speak = vi.fn(async (_text: string, _options: { signal: AbortSignal }) => 'completed' as const)
  const canSpeak = vi.fn((): boolean | Promise<boolean> => true)
  const onError = vi.fn()
  const queue = createCommentarySpeechQueue({ speak, canSpeak, isCurrent: value => value === scope, onError })
  const status = (key: string, text: string) => queue.enqueueStatus({ scope, key, text })
  const answer = (key: string, readMessage: () => ReturnType<typeof message> | undefined) =>
    queue.enqueueMessage({ scope, key, readMessage })
  return { queue, speak, canSpeak, onError, status, answer, changeScope: (value: string) => (scope = value) }
}

describe('automatic commentary speech queue', () => {
  it('reads local comments with consent and stops sending queued local text after consent is revoked', async () => {
    let allowed = true
    const clip = deferred<'completed'>()
    const speak = vi.fn().mockReturnValueOnce(clip.promise)
    const blocked = vi.fn()
    const queue = createCommentarySpeechQueue({
      speak,
      canSpeak: () => true,
      isCurrent: () => true,
      allowLocalContent: () => allowed,
      onBlocked: blocked,
    })
    const first = queue.enqueueMessage({
      scope: 'turn',
      key: 'message:round-2',
      readMessage: () => message('Projektzustand geladen.', { dataHandling: 'ephemeral', serverSpeechAllowed: false }),
    })
    const second = queue.enqueueMessage({
      scope: 'turn',
      key: 'message:round-3',
      readMessage: () => message('Ich prüfe die Dateien.', { dataHandling: 'ephemeral', serverSpeechAllowed: false }),
    })
    await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce())
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      'Projektzustand geladen.',
      expect.objectContaining({ key: 'message:round-2' })
    )
    allowed = false
    clip.resolve('completed')
    expect(await first).toBe('completed')
    expect(await second).toBe('skipped')
    expect(blocked).toHaveBeenCalledWith({ scope: 'turn', key: 'message:round-3', kind: 'message' })
  })

  it('cancels a pending consent lookup without sending local text', async () => {
    const consent = deferred<boolean>()
    const speak = vi.fn()
    const allowLocalContent = vi.fn(() => consent.promise)
    const queue = createCommentarySpeechQueue({ speak, allowLocalContent, canSpeak: () => true, isCurrent: () => true })
    const result = queue.enqueueMessage({
      scope: 'turn',
      key: 'comment',
      readMessage: () => message('Privat', { dataHandling: 'ephemeral' }),
    })
    await vi.waitFor(() => expect(allowLocalContent).toHaveBeenCalledOnce())
    queue.cancel()
    consent.resolve(true)
    expect(await result).toBe('cancelled')
    await queue.drain()
    expect(speak).not.toHaveBeenCalled()
  })
  it('speaks comments and the final answer in order without interrupting previous playback', async () => {
    const test = setup()
    const firstClip = deferred<'completed'>()
    test.speak.mockImplementationOnce(() => firstClip.promise)
    const first = test.status('routing', 'Ich bereite die Antwort vor.')
    const comment = test.answer('round-1', () => message('Die Prüfung ist abgeschlossen.'))
    const final = test.answer('final', () => message('Das Ergebnis liegt vor.'))
    let drained = false
    const drain = test.queue.drain().then(() => (drained = true))
    await vi.waitFor(() => expect(test.speak).toHaveBeenCalledTimes(1))
    expect(drained).toBe(false)
    expect(test.speak.mock.calls[0]?.[1].signal.aborted).toBe(false)
    firstClip.resolve('completed')
    expect(await Promise.all([first, comment, final])).toEqual(['completed', 'completed', 'completed'])
    await drain
    expect(test.speak.mock.calls.map(([text]) => text)).toEqual([
      'Ich bereite die Antwort vor.',
      'Die Prüfung ist abgeschlossen.',
      'Das Ergebnis liegt vor.',
    ])
    expect(drained).toBe(true)
  })

  it('deduplicates phase keys and identical text across repeated status updates', async () => {
    const test = setup()
    expect(await test.status('routing', 'Ich prüfe.')).toBe('completed')
    expect(await test.status('routing', 'Ein anderer Text für dieselbe Phase.')).toBe('skipped')
    expect(await test.status('routing-2', '  Ich   prüfe.\n')).toBe('skipped')
    expect(await test.answer('final', () => message('Ich prüfe.'))).toBe('skipped')
    expect(test.speak).toHaveBeenCalledTimes(1)
  })

  it('reads the automatic speech setting again for every pending entry', async () => {
    const test = setup()
    const clip = deferred<'completed'>()
    test.speak.mockImplementationOnce(() => clip.promise)
    const first = test.status('routing', 'Ich prüfe.')
    const final = test.answer('final', () => message('Erledigt.'))
    await vi.waitFor(() => expect(test.speak).toHaveBeenCalledTimes(1))
    test.canSpeak.mockReturnValue(false)
    clip.resolve('completed')
    expect(await first).toBe('completed')
    expect(await final).toBe('skipped')
    expect(test.canSpeak).toHaveBeenCalledTimes(2)
    expect(test.speak).toHaveBeenCalledTimes(1)
  })

  it('rechecks the project and account scope after asynchronous settings resolve', async () => {
    const test = setup()
    const settings = deferred<boolean>()
    test.canSpeak.mockReturnValueOnce(settings.promise)
    const result = test.status('routing', 'Ich prüfe.')
    await vi.waitFor(() => expect(test.canSpeak).toHaveBeenCalledTimes(1))
    test.changeScope('other-account-turn')
    settings.resolve(true)
    expect(await result).toBe('cancelled')
    expect(test.speak).not.toHaveBeenCalled()
  })

  it('checks current message privacy after settings resolve instead of trusting an earlier snapshot', async () => {
    const test = setup()
    const settings = deferred<boolean>()
    test.canSpeak.mockReturnValueOnce(settings.promise)
    const entry = message('Lokales Ergebnis.')
    const result = test.answer('comment', () => entry)
    await vi.waitFor(() => expect(test.canSpeak).toHaveBeenCalledTimes(1))
    entry.meta.dataHandling = 'ephemeral'
    settings.resolve(true)
    expect(await result).toBe('skipped')
    expect(test.speak).not.toHaveBeenCalled()
  })

  it.each<Message['meta']>([{ isLoading: true }, { dataHandling: 'ephemeral' }, { serverSpeechAllowed: false }])(
    'never sends unclassified or device-local generated content to server speech: %j',
    async meta => {
      const test = setup()
      expect(await test.answer('comment', () => message('Privater Teilinhalt.', meta))).toBe('skipped')
      expect(test.speak).not.toHaveBeenCalled()
    }
  )

  it('reads a finalized message only at its place in the queue', async () => {
    const test = setup()
    const clip = deferred<'completed'>()
    test.speak.mockImplementationOnce(() => clip.promise)
    void test.status('routing', 'Ich prüfe.')
    let entry = message('Vorläufig.')
    const readMessage = vi.fn(() => entry)
    const final = test.answer('final', readMessage)
    await vi.waitFor(() => expect(test.speak).toHaveBeenCalledTimes(1))
    expect(readMessage).not.toHaveBeenCalled()
    entry = message('Aktuelles Ergebnis.', { question: 'Fortfahren?' })
    clip.resolve('completed')
    expect(await final).toBe('completed')
    expect(test.speak.mock.calls[1]?.[0]).toBe('Aktuelles Ergebnis.\n\nFortfahren?')
  })

  it('cancels a stalled settings read and queued speech without blocking the next turn', async () => {
    const test = setup()
    const settings = deferred<boolean>()
    test.canSpeak.mockReturnValueOnce(settings.promise)
    const first = test.status('routing', 'Alter Vorgang.')
    const final = test.answer('final', () => message('Altes Ergebnis.'))
    await vi.waitFor(() => expect(test.canSpeak).toHaveBeenCalledTimes(1))
    test.queue.cancel()
    test.changeScope('turn-two')
    expect(await test.status('routing', 'Neuer Vorgang.')).toBe('completed')
    expect(await first).toBe('cancelled')
    expect(await final).toBe('cancelled')
    settings.resolve(true)
    await test.queue.drain()
    expect(test.speak.mock.calls.map(([text]) => text)).toEqual(['Neuer Vorgang.'])
  })

  it('aborts active playback and waits for its audio owner to settle before starting a new turn', async () => {
    const test = setup()
    const clip = deferred<'completed'>()
    test.speak.mockImplementationOnce(() => clip.promise)
    const first = test.status('routing', 'Alter Vorgang.')
    const oldFinal = test.answer('final', () => message('Altes Ergebnis.'))
    await vi.waitFor(() => expect(test.speak).toHaveBeenCalledTimes(1))
    test.queue.cancel()
    test.changeScope('turn-two')
    const next = test.status('routing', 'Neuer Vorgang.')
    expect(await first).toBe('cancelled')
    expect(await oldFinal).toBe('cancelled')
    expect(test.speak.mock.calls[0]?.[1].signal.aborted).toBe(true)
    expect(test.speak).toHaveBeenCalledTimes(1)
    clip.resolve('completed')
    expect(await next).toBe('completed')
    expect(test.speak.mock.calls.map(([text]) => text)).toEqual(['Alter Vorgang.', 'Neuer Vorgang.'])
  })

  it('continues to the final answer after a failed comment or failed error reporter', async () => {
    const test = setup()
    const error = new Error('Audio nicht verfügbar.')
    test.speak.mockRejectedValueOnce(error)
    test.onError.mockImplementation(() => {
      throw new Error('Protokollierung nicht verfügbar.')
    })
    const comment = test.status('routing', 'Ich prüfe.')
    const final = test.answer('final', () => message('Erledigt.'))
    expect(await comment).toBe('failed')
    expect(await final).toBe('completed')
    expect(test.onError).toHaveBeenCalledWith(error, { scope: 'turn-one', key: 'routing', kind: 'status' })
  })

  it('does not speak missing messages, empty comments or error messages', async () => {
    const test = setup()
    expect(await test.answer('missing', () => undefined)).toBe('skipped')
    expect(await test.status('empty', '  ')).toBe('skipped')
    expect(await test.answer('error', () => message('[Fehler] Lokale Anfrage abgebrochen.'))).toBe('skipped')
    expect(test.speak).not.toHaveBeenCalled()
    await test.queue.drain()
  })

  it('allows the same labels in a new turn', async () => {
    const test = setup()
    expect(await test.status('routing', 'Ich prüfe.')).toBe('completed')
    test.changeScope('turn-two')
    expect(await test.status('routing', 'Ich prüfe.')).toBe('completed')
    expect(test.speak).toHaveBeenCalledTimes(2)
  })
})
