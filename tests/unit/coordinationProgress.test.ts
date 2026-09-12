import { describe, expect, it, vi } from 'vitest'
import { createProgressReporter } from '@/services/coordination/progress'
describe('coordinated progress sequencing', () => {
  it('serializes concurrent callbacks and renewals', async () => {
    let finish!: () => void
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValue(undefined)
    const reporter = createProgressReporter(send)
    const first = reporter.report('first'),
      second = reporter.report('second')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    finish()
    await Promise.all([first, second])
    expect(send.mock.calls).toEqual([
      [1, 'first'],
      [2, 'second'],
    ])
  })
  it('replays the identical event after a lost acknowledgement before advancing', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined)
    const reporter = createProgressReporter(send)
    await expect(reporter.report('first')).rejects.toThrow('network')
    await reporter.report('next')
    expect(send.mock.calls).toEqual([
      [1, 'first'],
      [1, 'first'],
      [2, 'next'],
    ])
  })
})
