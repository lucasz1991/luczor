import { afterEach, describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
  beginReadAlong,
  endReadAlong,
  updateReadAlong,
  readAlongState,
  speechTokens,
  currentSpeechToken,
  sentenceSpeechPosition,
} from '@/services/voice/readAlong'
import StreamingText from '@/components/ai/StreamingText.vue'
import ChatCommentary from '@/components/ai/ChatCommentary.vue'

afterEach(() => {
  if (readAlongState.value) endReadAlong(readAlongState.value.owner)
})

describe('read-aloud presentation', () => {
  it('keeps whitespace and Unicode intact and highlights exactly one word at sentence boundaries', () => {
    const text = 'Prüfung 🙂 abgeschlossen.'
    const tokens = speechTokens(text)
    expect(tokens.map(token => token.text).join('')).toBe(text)
    expect(tokens[currentSpeechToken(tokens, 7)]?.text).toBe('🙂')
    expect(tokens[currentSpeechToken(tokens, 100)]?.text).toBe('abgeschlossen.')
    expect(sentenceSpeechPosition(20, 10, 5, 10)).toBe(25)
    expect(sentenceSpeechPosition(20, 10, 5, Number.NaN)).toBe(20)
  })

  it('does not let late events or cleanup from an old clip change the current text', () => {
    const old = beginReadAlong('old', 'Alt')
    const current = beginReadAlong('new', 'Neu')
    updateReadAlong(old, 'playing', 2)
    endReadAlong(old)
    expect(readAlongState.value).toMatchObject({ owner: current, key: 'new', position: 0 })
  })

  it('marks the speaking commentary only, escapes its text and restores normal content after stop', async () => {
    const entry = {
      id: 'round-2',
      round: 2,
      content: 'Dateien <script> prüfen.',
      createdAt: 1,
      serverSpeechAllowed: false,
    }
    const owner = beginReadAlong('message:round-2', entry.content)
    updateReadAlong(owner, 'playing', 8)
    const html = await renderToString(createSSRApp(ChatCommentary, { entries: [entry], messageId: 'message' }))
    expect(html).toMatch(/<mark[^>]*aria-current="true"[^>]*>&lt;script&gt;<\/mark>/u)
    expect(html).not.toContain('<script>')
    expect(html).toContain('Wortposition ungefähr')
    const other = await renderToString(
      createSSRApp(StreamingText, { content: 'Andere Antwort', speechKey: 'other:answer' })
    )
    expect(other).not.toContain('read-aloud__current')
    endReadAlong(owner)
    const stopped = await renderToString(createSSRApp(ChatCommentary, { entries: [entry], messageId: 'message' }))
    expect(stopped).not.toContain('read-aloud__current')
    expect(stopped).toContain('Dateien')
  })
})
