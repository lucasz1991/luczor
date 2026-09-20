import { describe, expect, it } from 'vitest'
import { RunResourceCoordinator } from '@/services/runs/resourceCoordinator'

describe('shared run resources', () => {
  it('cancels queued requests but recovers occupied leases only after proof, ignoring old releases', async () => {
    const coordinator = new RunResourceCoordinator()
    const oldRelease = await coordinator.acquire(['desktop'])
    const queued = coordinator.acquire(['desktop'])
    const rejected = expect(queued).rejects.toThrow('global stop')
    const generation = coordinator.cancelPending(new Error('global stop'))
    await rejected
    expect(coordinator.snapshot()).toEqual({ occupied: ['desktop'], waiting: 0 })
    expect(coordinator.resumeAfterStop()).toBe(false)
    expect(coordinator.recoverStopped({ generation: generation - 1, nativeStopped: true })).toBe(0)
    expect(coordinator.recoverStopped({ generation, nativeStopped: true })).toBe(1)
    expect(coordinator.resumeAfterStop()).toBe(true)
    const freshRelease = await coordinator.acquire(['desktop'])
    oldRelease()
    expect(coordinator.snapshot().occupied).toEqual(['desktop'])
    freshRelease()
    expect(coordinator.snapshot().occupied).toEqual([])
  })
  it('allows independent work and fairly serializes a whole overlapping resource set', async () => {
    const coordinator = new RunResourceCoordinator()
    const first = await coordinator.acquire(['workspace:a'])
    let secondStarted = false
    const second = coordinator.acquire(['workspace:a', 'desktop']).then(release => {
      secondStarted = true
      return release
    })
    let thirdStarted = false
    const third = coordinator.acquire(['desktop']).then(release => {
      thirdStarted = true
      return release
    })
    const independent = await coordinator.acquire(['workspace:b'])
    expect(secondStarted).toBe(false)
    expect(thirdStarted).toBe(false)
    independent()
    first()
    const releaseSecond = await second
    expect(secondStarted).toBe(true)
    expect(thirdStarted).toBe(false)
    releaseSecond()
    const releaseThird = await third
    expect(thirdStarted).toBe(true)
    releaseThird()
  })

  it('removes canceled waiters and tolerates duplicate release without stealing another lease', async () => {
    const coordinator = new RunResourceCoordinator()
    const first = await coordinator.acquire(['desktop'])
    const abort = new AbortController()
    const canceled = coordinator.acquire(['desktop'], abort.signal)
    abort.abort(new Error('stopped'))
    await expect(canceled).rejects.toThrow('stopped')
    first()
    const second = await coordinator.acquire(['desktop'])
    first()
    let thirdStarted = false
    const third = coordinator.acquire(['desktop']).then(release => {
      thirdStarted = true
      return release
    })
    await Promise.resolve()
    expect(thirdStarted).toBe(false)
    second()
    const release = await third
    release()
  })
})
