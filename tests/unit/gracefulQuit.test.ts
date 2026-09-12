import { describe, expect, it, vi } from 'vitest'
import { createGracefulQuit } from '@/services/gracefulQuit'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { resolve, promise }
}
const requestId = '11111111-1111-4111-8111-111111111111'
describe('explicit native quit preparation', () => {
  it('closes admission immediately, saves before draining and commits once only after final persistence', async () => {
    const draining = deferred()
    const begin = vi.fn(),
      save = vi.fn(async () => undefined),
      commit = vi.fn(async () => undefined)
    const quit = createGracefulQuit({ begin, save, commit, drain: () => draining.promise })
    const result = quit({ requestId })
    expect(begin).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
    expect(quit({ requestId })).toBe(result)
    draining.resolve()
    await result
    expect(save).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledExactlyOnceWith(requestId)
  })
  it('never commits an invalid quit request or pretends failed persistence was saved', async () => {
    const begin = vi.fn(),
      commit = vi.fn(async () => undefined),
      failed = vi.fn()
    const quit = createGracefulQuit({
      begin,
      commit,
      failed,
      save: async () => {
        throw new Error('disk unavailable')
      },
      drain: async () => {},
    })
    await quit({ requestId: '../../invalid' })
    expect(begin).not.toHaveBeenCalled()
    await quit({ requestId })
    expect(commit).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledOnce()
  })
})
