import { describe, expect, it } from 'vitest'
import { prepareToolCallHistory } from '@/services/inference/toolCallHistory'

describe('tool-call history repair', () => {
  it.each(['{"title":', '{"a":1}{"b":2}', '', 'null', '[]', '"text"', '42'])(
    'isolates invalid arguments %s without altering the original or valid siblings',
    args => {
      const calls = [
        { id: 'good', type: 'function' as const, function: { name: 'fs_read', arguments: '{"path":"ä.txt"}' } },
        { id: 'bad', type: 'function' as const, function: { name: 'project_upsert_goal', arguments: args } },
      ]
      const original = JSON.stringify(calls)
      const history = prepareToolCallHistory(calls)
      expect(history.invalidIds).toEqual(new Set(['bad']))
      expect(history.calls[0]).toEqual(calls[0])
      expect(history.calls[1]).toEqual({ ...calls[1], function: { ...calls[1]!.function, arguments: '{}' } })
      expect(JSON.stringify(calls)).toBe(original)
      expect(prepareToolCallHistory(history.calls).calls).toEqual(history.calls)
    }
  )
})
