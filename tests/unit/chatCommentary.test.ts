import { describe, expect, it } from 'vitest'
import { completedCommentary, commentaryForSpeech } from '@/services/chatCommentary'
import { serverSpeechText } from '@/services/voice/messageSpeech'
import { createChatActivity, finishChatActivity, updateChatActivity } from '@/services/chatActivity'
import { stateForPersistence } from '@/services/persistence'
import { DEFAULT_STATE } from '@/state/defaults'
import type { Message } from '@/state/types'

describe('retained public commentary', () => {
  it('retains all public fields without protocol data or reasoning', () => {
    const entry = completedCommentary(
      {
        round: 2,
        content:
          '{"analysis":"private","summary":"Dateien geprüft.","question":"Fortfahren?","bullets":["Ja","Details"]}',
        serverSpeechAllowed: true,
      },
      123
    )
    expect(entry).toMatchObject({ id: 'round-2', round: 2, createdAt: 123, serverSpeechAllowed: true })
    expect(entry?.content).toBe('Dateien geprüft.\n\nFortfahren?\n\n- Ja\n\n- Details')
    expect(serverSpeechText(commentaryForSpeech(entry!))).toContain('Dateien geprüft.')
  })

  it('never makes unclassified or local-only text eligible for server speech', () => {
    const entry = completedCommentary({ round: 1, content: 'Lokales Zwischenergebnis.', serverSpeechAllowed: false })
    expect(entry?.content).toBe('Lokales Zwischenergebnis.')
    expect(serverSpeechText(commentaryForSpeech(entry!))).toBe('')
    expect(completedCommentary({ round: 1, content: '<think>private</think>', serverSpeechAllowed: true })).toBeNull()
  })

  it('keeps completed phases and comments through archive serialization', () => {
    const state = structuredClone(DEFAULT_STATE)
    const activity = createChatActivity(0)
    updateChatActivity(activity, { phase: 'thinking', round: 1 })
    updateChatActivity(activity, { phase: 'receiving', round: 1, characters: 30 })
    updateChatActivity(activity, { phase: 'tools', round: 1 })
    finishChatActivity(activity, 'done', 10)
    const entry = completedCommentary({ round: 1, content: 'Prüfung begonnen.', serverSpeechAllowed: true })!
    state.messages = [
      {
        id: 'answer',
        projectId: 'default',
        role: 'assistant',
        content: 'Fertig.',
        ts: 0,
        createdAt: 0,
        parsed: null,
        visibility: 'visible',
        meta: { activity, commentary: [entry], isLoading: false },
      } as Message,
    ]
    const restored = JSON.parse(JSON.stringify(stateForPersistence(state)))
    expect(restored.messages[0].meta.commentary).toEqual([entry])
    expect(restored.messages[0].meta.activity.steps).toHaveLength(4)
    expect(restored.messages[0].meta.activity.steps.every((step: { status: string }) => step.status === 'done')).toBe(
      true
    )
  })
})
