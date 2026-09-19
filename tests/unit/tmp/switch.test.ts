import { describe, expect, it } from 'vitest'
import { computed, nextTick, reactive } from 'vue'
import { getSafeRecordValue, setSafeRecordValue } from '@/services/safeRecord'
describe('safe record reactivity', () => {
  it('notifies computed readers when a key is written', async () => {
    const record = reactive<Record<string, string>>({})
    const value = computed(() => getSafeRecordValue(record, 'default') ?? 'none')
    expect(value.value).toBe('none')
    setSafeRecordValue(record, 'default', 'chat-2')
    await nextTick()
    expect(value.value).toBe('chat-2')
  })
})
