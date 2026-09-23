import { effectScope, nextTick, reactive, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useMiniChatDraft } from '@/composables/useMiniChatDraft'
import { emptyMiniSnapshot } from '@/services/miniChat/types'

describe('mini chat conversation drafts', () => {
  it('keeps temporary and shared conversation drafts separate', async () => {
    const snapshot = ref({ ...emptyMiniSnapshot(), sessionId: 'temporary' })
    const scope = effectScope()
    const { draft } = scope.run(() => useMiniChatDraft(() => snapshot.value))!
    draft.value = 'Temporärer Entwurf'
    snapshot.value = { ...snapshot.value, view: 'chat', sessionId: 'shared' }
    await nextTick()
    expect(draft.value).toBe('')
    draft.value = 'Für den Hauptchat'
    snapshot.value = { ...snapshot.value, view: 'workspace', sessionId: 'temporary-2' }
    await nextTick()
    expect(draft.value).toBe('Temporärer Entwurf')
    scope.stop()
  })
  it('keeps the draft when the native bridge replaces a runtime snapshot', async () => {
    const snapshot = ref({ ...emptyMiniSnapshot(), sessionId: 'same-session' })
    const scope = effectScope()
    const { draft } = scope.run(() => useMiniChatDraft(() => snapshot.value))!
    draft.value = 'Weiter schreiben'
    snapshot.value = { ...snapshot.value, revision: 2, busy: true }
    await nextTick()
    expect(draft.value).toBe('Weiter schreiben')
    scope.stop()
  })
  it('restores separate drafts when switching chats inside the same project', async () => {
    const snapshot = reactive({
      ...emptyMiniSnapshot(),
      view: 'chat' as const,
      sessionId: 'epoch-a',
      project: { id: 'project', name: 'Projekt' },
      conversationId: 'a',
    })
    const scope = effectScope()
    const { draft } = scope.run(() => useMiniChatDraft(() => snapshot))!
    draft.value = 'Entwurf A'
    snapshot.conversationId = 'b'
    snapshot.sessionId = 'epoch-b'
    await nextTick()
    expect(draft.value).toBe('')
    draft.value = 'Entwurf B'
    snapshot.conversationId = 'a'
    snapshot.sessionId = 'epoch-c'
    await nextTick()
    expect(draft.value).toBe('Entwurf A')
    snapshot.conversationId = 'b'
    snapshot.sessionId = 'epoch-d'
    await nextTick()
    expect(draft.value).toBe('Entwurf B')
    scope.stop()
  })

  it('retains a draft during streaming and clears all cached drafts on a same-context reset', async () => {
    const snapshot = reactive({
      ...emptyMiniSnapshot(),
      view: 'chat' as const,
      sessionId: 'epoch-a',
      project: { id: 'free', name: 'Chat ohne Projekt' },
      conversationId: 'a',
    })
    const scope = effectScope()
    const { draft } = scope.run(() => useMiniChatDraft(() => snapshot))!
    draft.value = 'Nicht gesendet'
    snapshot.busy = true
    snapshot.revision++
    await nextTick()
    expect(draft.value).toBe('Nicht gesendet')
    snapshot.conversationId = 'b'
    snapshot.sessionId = 'epoch-b'
    await nextTick()
    draft.value = 'Zweiter Entwurf'
    snapshot.sessionId = 'reset'
    await nextTick()
    expect(draft.value).toBe('')
    snapshot.conversationId = 'a'
    snapshot.sessionId = 'epoch-c'
    await nextTick()
    expect(draft.value).toBe('')
    scope.stop()
  })
})
