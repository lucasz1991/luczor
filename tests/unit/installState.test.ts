import { describe, expect, it, vi } from 'vitest'
import { parseInstallState, watchInstallState } from '@/services/installState'

describe('package install state of the running app', () => {
  it('treats every unknown native value as unchanged', () => {
    expect(parseInstallState('replaced')).toBe('replaced')
    expect(parseInstallState('removed')).toBe('removed')
    for (const value of ['unchanged', 'REPLACED', '', null, undefined, 1, { state: 'replaced' }])
      expect(parseInstallState(value)).toBe('unchanged')
  })

  it('reports the current state and later native changes until stopped', async () => {
    let emit: (payload: unknown) => void = () => {}
    const unlisten = vi.fn()
    const seen: string[] = []
    const stop = await watchInstallState(state => seen.push(state), {
      read: async () => 'unchanged',
      subscribe: async handler => {
        emit = handler
        return unlisten
      },
    })
    emit('replaced')
    emit('nonsense')
    expect(seen).toEqual(['unchanged', 'replaced', 'unchanged'])
    stop()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('stays silent outside the desktop app and on a native build without the command', async () => {
    const onChange = vi.fn()
    await watchInstallState(onChange, undefined)
    const unlisten = vi.fn()
    const stop = await watchInstallState(onChange, {
      read: async () => {
        throw new Error('unknown command')
      },
      subscribe: async () => unlisten,
    })
    expect(onChange).not.toHaveBeenCalled()
    stop()
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
