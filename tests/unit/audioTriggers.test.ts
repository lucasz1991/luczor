import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  audioFeatures,
  audioDistance,
  matchAudioTrigger,
  saveAudioTriggers,
  type AudioTriggers,
} from '@/services/voice/audioTriggers'
import { chunksToWavBase64 } from '@/services/voice/wav'

const stored = vi.hoisted(() => ({ set: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => stored } }))
function sample(name: string, gain = 1) {
  const data = readFileSync(new URL(`../fixtures/audio-triggers/${name}.wav`, import.meta.url))
  const pcm = Float32Array.from(
    { length: (data.length - 44) / 2 },
    (_, i) => (gain * data.readInt16LE(44 + i * 2)) / 32768
  )
  const wav = chunksToWavBase64([pcm], data.readUInt32LE(24))
  return { wav, features: audioFeatures(wav), recordedAt: '2026-09-08' }
}
describe('local audio trigger templates', () => {
  it('recognizes a separately generated pronunciation and rejects another phrase', () => {
    const config: AudioTriggers = { enabled: true, wake: sample('wake'), close: sample('close') }
    expect(matchAudioTrigger(sample('wake-probe').wav, config, 'wake')).toBe(true)
    expect(matchAudioTrigger(sample('wake-probe', 0.4).wav, config, 'wake')).toBe(true)
    expect(matchAudioTrigger(sample('negative').wav, config, 'wake')).toBe(false)
    expect(matchAudioTrigger(sample('negative').wav, config, 'close')).toBe(false)
    expect(matchAudioTrigger(config.close!.wav, config, 'close')).toBe(true)
    expect(matchAudioTrigger(config.close!.wav, config, 'wake')).toBe(false)
  })
  it('rejects silence, oversize data, disabled mode and indistinguishable controls', async () => {
    expect(() => audioFeatures(chunksToWavBase64([new Float32Array(16000)], 16000))).toThrow('Keine deutliche')
    expect(() => audioFeatures('a'.repeat(1_000_001))).toThrow('zu lang')
    const wake = sample('wake')
    expect(matchAudioTrigger(wake.wav, { enabled: false, wake }, 'wake')).toBe(false)
    expect(matchAudioTrigger(wake.wav, { enabled: true, wake, close: wake }, 'wake')).toBe(false)
    await expect(saveAudioTriggers({ enabled: true, wake, close: wake })).rejects.toThrow('zu ähnlich')
    expect(stored.set).not.toHaveBeenCalled()
    expect(audioDistance([], wake.features)).toBe(Infinity)
  })
})
