import { describe, it, expect } from 'vitest'
import { HandsFreeMachine, splitOnPhrase, type StrategyConfig } from './voiceStrategy'

function collector() {
  const commands: string[] = []
  const partials: string[] = []
  return { commands, partials, onCommand: (t: string) => commands.push(t), onPartial: (t: string) => partials.push(t) }
}

const base: StrategyConfig = {
  strategy: 'safeword',
  triggerPhrase: 'luczor start',
  endPhrase: 'luczor stopp',
  continuousSilenceMs: 5000,
}

describe('splitOnPhrase', () => {
  it('splits around a phrase, whitespace/punctuation-insensitive', () => {
    const m = splitOnPhrase('Also, Luczor Start bitte notiere das', 'luczor start')
    expect(m).not.toBeNull()
    expect(m!.before).toBe('Also,')
    expect(m!.after).toBe('bitte notiere das')
  })

  it('returns null when the phrase is absent', () => {
    expect(splitOnPhrase('nur normaler Text', 'luczor start')).toBeNull()
  })
})

describe('safeword strategy', () => {
  it('ignores ambient speech until the activation phrase, then dictates until the end phrase', () => {
    const c = collector()
    const m = new HandsFreeMachine(base, c.onCommand, c.onPartial)

    m.pushSegment('irgendein Gespräch nebenbei', 0)
    expect(m.state).toBe('armed')
    expect(c.commands).toEqual([])

    m.pushSegment('Luczor Start schreibe eine Notiz', 1000)
    expect(m.state).toBe('dictating')

    m.pushSegment('mit mehreren Sätzen', 2000)
    expect(c.commands).toEqual([]) // not finalized yet

    m.pushSegment('und jetzt Luczor Stopp', 3000)
    expect(m.state).toBe('armed')
    expect(c.commands).toEqual(['schreibe eine Notiz mit mehreren Sätzen und jetzt'])
  })
})

describe('continuous strategy', () => {
  const cfg: StrategyConfig = { ...base, strategy: 'continuous' }

  it('dictates from first speech and finalizes after a long pause', () => {
    const c = collector()
    const m = new HandsFreeMachine(cfg, c.onCommand, c.onPartial)

    m.pushSegment('erster Satz', 0)
    m.pushSegment('zweiter Satz', 1000)
    expect(m.state).toBe('dictating')

    m.tick(3000) // < 5s since last segment -> no finalize
    expect(c.commands).toEqual([])

    m.tick(6001) // >= 5s -> finalize
    expect(m.state).toBe('armed')
    expect(c.commands).toEqual(['erster Satz zweiter Satz'])
  })

  it('finalizes early on an optional end phrase', () => {
    const c = collector()
    const m = new HandsFreeMachine(cfg, c.onCommand, c.onPartial)
    m.pushSegment('kurze Nachricht Luczor Stopp', 0)
    expect(c.commands).toEqual(['kurze Nachricht'])
    expect(m.state).toBe('armed')
  })
})
