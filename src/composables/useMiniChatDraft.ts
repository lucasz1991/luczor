import { computed, ref, watch } from 'vue'
import type { MiniSnapshot } from '@/services/miniChat/types'

/** Drafts belong to a conversation, independently of the displayed window or run epoch. */
export function useMiniChatDraft(snapshot: () => MiniSnapshot) {
  const draft = ref('')
  const drafts = new Map<string, string>()
  const key = computed(() => {
    const value = snapshot()
    return value.view === 'chat'
      ? `chat:${value.project?.id ?? 'none'}:${value.conversationId ?? 'default'}`
      : 'workspace'
  })
  watch([() => snapshot().sessionId, key], ([, current], previous) => {
    if (previous && previous[1] !== current) {
      drafts.set(previous[1], draft.value)
      draft.value = drafts.get(current) ?? ''
    } else {
      // A new epoch for the same conversation means an explicit reset/rebind.
      drafts.clear()
      draft.value = ''
    }
  })
  return { draft, key }
}
