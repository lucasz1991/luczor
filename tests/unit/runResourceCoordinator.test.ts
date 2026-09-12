import { describe, expect, it } from 'vitest'
import { RunResourceCoordinator } from '@/services/runs/resourceCoordinator'

describe('shared run resources', () => {
  it('allows independent work and fairly serializes a whole overlapping resource set', async () => {
    const coordinator = new RunResourceCoordinator()
    const first = await coordinator.acquire(['workspace:a'])
    let secondStarted = false
    const second = coordinator.acquire(['workspace:a', 'desktop']).then(release => { secondStarted = true; return release })
    let thirdStarted = false
    const third = coordinator.acquire(['desktop']).then(release => { thirdStarted = true; return release })
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
    const third = coordinator.acquire(['desktop']).then(release => { thirdStarted = true; return release })
    await Promise.resolve()
    expect(thirdStarted).toBe(false)
    second()
    const release = await third
    release()
  })
})
