import { describe, it, expect } from 'vitest'
import { BargeInDetector } from './bargeIn'

describe('BargeInDetector', () => {
  it('triggers only after N consecutive speech frames', () => {
    const d = new BargeInDetector(0.02, 3)
    expect(d.push(0.05)).toBe(false) // 1
    expect(d.push(0.05)).toBe(false) // 2
    expect(d.push(0.05)).toBe(true) // 3 -> trigger
  })

  it('resets on a silent frame before the threshold is reached', () => {
    const d = new BargeInDetector(0.02, 3)
    expect(d.push(0.05)).toBe(false) // 1
    expect(d.push(0.01)).toBe(false) // silence -> reset
    expect(d.push(0.05)).toBe(false) // 1 again
    expect(d.push(0.05)).toBe(false) // 2
    expect(d.push(0.05)).toBe(true) // 3
  })

  it('ignores sub-threshold frames entirely', () => {
    const d = new BargeInDetector(0.02, 2)
    for (let i = 0; i < 10; i++) expect(d.push(0.019)).toBe(false)
  })

  it('re-triggers after an explicit reset', () => {
    const d = new BargeInDetector(0.02, 2)
    expect(d.push(0.05)).toBe(false)
    expect(d.push(0.05)).toBe(true)
    d.reset()
    expect(d.push(0.05)).toBe(false)
    expect(d.push(0.05)).toBe(true)
  })
})
