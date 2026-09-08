/* eslint-disable security/detect-object-injection -- DSP indexes are bounded numeric loops; trigger keys are the closed wake/close union. */
/* eslint-disable id-length -- Conventional FFT and matrix coordinates in this numeric implementation. */
import { voiceInputStore } from './voiceInputStore'
import { chunksToWavBase64 } from './wav'

export type AudioTriggerKind = 'wake' | 'close'
export type AudioTriggerSample = { wav: string; features: number[][]; recordedAt: string }
export type AudioTriggers = { enabled: boolean; wake?: AudioTriggerSample; close?: AudioTriggerSample }
const SIZE = 512
const BANDS = 24
const RATE = 16000

/** MFCC templates are compared locally; no speaker identification or server upload. */
export function audioFeatures(wav: string): number[][] {
  if (wav.length > 1_000_000) throw new Error('Die Aufnahme ist zu lang.')
  const bytes = Uint8Array.from(atob(wav), char => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  if (
    bytes.length < 44 ||
    view.getUint32(24, true) !== RATE ||
    view.getUint16(22, true) !== 1 ||
    view.getUint16(34, true) !== 16
  )
    throw new Error('Die Aufnahme muss 16 kHz Mono-WAV sein.')
  const samples = Float64Array.from(
    { length: (bytes.length - 44) / 2 },
    (_, i) => view.getInt16(44 + i * 2, true) / 32768
  )
  const energies: number[] = []
  for (let i = 0; i + SIZE <= samples.length; i += 160) {
    let energy = 0
    for (let j = 0; j < SIZE; j++) energy += samples[i + j]! ** 2
    energies.push(Math.sqrt(energy / SIZE))
  }
  const peak = Math.max(0, ...energies)
  if (peak < 0.008) throw new Error('Keine deutliche Sprache erkannt. Bitte näher am Mikrofon aufnehmen.')
  const voiced = energies.map((energy, i) => (energy > Math.max(0.006, peak * 0.08) ? i : -1)).filter(i => i >= 0)
  const first = voiced[0] ?? 0
  const last = voiced[voiced.length - 1] ?? 0
  if (last - first < 20 || last - first > 350)
    throw new Error('Bitte ein deutliches Wort oder eine kurze Phrase von 0,3 bis 3,5 Sekunden aufnehmen.')
  const edges = Array.from({ length: BANDS + 2 }, (_, i) =>
    Math.floor((SIZE * (700 * (10 ** ((2595 * Math.log10(1 + 7600 / 700) * i) / (BANDS + 1) / 2595) - 1))) / RATE)
  )
  const result: number[][] = []
  // Every second frame keeps bounded DTW inexpensive during live capture.
  for (let frame = first; frame <= last; frame += 2) {
    const real = new Float64Array(SIZE)
    const imag = new Float64Array(SIZE)
    for (let i = 0; i < SIZE; i++) {
      const offset = frame * 160 + i
      real[i] =
        (samples[offset]! - 0.97 * (samples[offset - 1] ?? 0)) *
        (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (SIZE - 1)))
    }
    for (let i = 1, j = 0; i < SIZE; i++) {
      let bit = SIZE >> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      if (i < j) {
        const value = real[i]!
        real[i] = real[j]!
        real[j] = value
      }
    }
    for (let length = 2; length <= SIZE; length *= 2) {
      for (let offset = 0; offset < SIZE; offset += length) {
        for (let j = 0; j < length / 2; j++) {
          const a = offset + j,
            b = a + length / 2
          const angle = (-2 * Math.PI * j) / length
          const re = real[b]! * Math.cos(angle) - imag[b]! * Math.sin(angle)
          const im = real[b]! * Math.sin(angle) + imag[b]! * Math.cos(angle)
          real[b] = real[a]! - re
          imag[b] = imag[a]! - im
          real[a] = real[a]! + re
          imag[a] = imag[a]! + im
        }
      }
    }
    const mel = Array.from({ length: BANDS }, (_, band) => {
      let energy = 0
      const left = edges[band]!,
        center = edges[band + 1]!,
        right = edges[band + 2]!
      for (let bin = left; bin < right; bin++) {
        const weight =
          bin < center ? (bin - left) / Math.max(1, center - left) : (right - bin) / Math.max(1, right - center)
        energy += (real[bin]! ** 2 + imag[bin]! ** 2) * weight
      }
      return Math.log(Math.max(1e-10, energy))
    })
    const cepstra = Array.from({ length: 12 }, (_, i) =>
      mel.reduce((sum, value, k) => sum + value * Math.cos((Math.PI * (i + 1) * (k + 0.5)) / BANDS), 0)
    )
    const norm = Math.sqrt(cepstra.reduce((sum, value) => sum + value * value, 0)) || 1
    result.push(cepstra.map(value => value / norm))
  }
  return result
}

export function audioDistance(left: number[][], right: number[][]): number {
  if (!left.length || !right.length || left.length / right.length < 0.55 || left.length / right.length > 1.8)
    return Infinity
  let previous = new Float64Array(right.length + 1).fill(Infinity)
  previous[0] = 0
  for (let i = 0; i < left.length; i++) {
    const current = new Float64Array(right.length + 1).fill(Infinity)
    for (let j = 0; j < right.length; j++) {
      if (Math.abs(i / left.length - j / right.length) > 0.3) continue
      const distance = Math.max(0, 1 - left[i]!.reduce((sum, value, k) => sum + value * right[j]![k]!, 0))
      current[j + 1] = distance + Math.min(current[j]!, previous[j + 1]!, previous[j]!)
    }
    previous = current
  }
  return previous[right.length]! / Math.max(left.length, right.length)
}

export function matchAudioTrigger(wav: string, config: AudioTriggers, expected: AudioTriggerKind): boolean {
  const sample = config[expected]
  if (!config.enabled || !sample) return false
  let features: number[][]
  try {
    features = audioFeatures(wav)
  } catch {
    return false
  }
  const distance = audioDistance(features, sample.features)
  const other = config[expected === 'wake' ? 'close' : 'wake']
  return distance < 0.12 && (!other || distance + 0.025 < audioDistance(features, other.features))
}

export async function loadAudioTriggers(): Promise<AudioTriggers> {
  const store = await voiceInputStore('luczor.audio-triggers.json')
  const stored = await store.get<AudioTriggers>('triggers')
  if (!stored) return { enabled: false }
  // Rebuild features from bounded audio instead of trusting persisted matrices.
  const result: AudioTriggers = { enabled: stored.enabled === true }
  for (const kind of ['wake', 'close'] as const) {
    const sample = stored[kind]
    if (sample && typeof sample.wav === 'string')
      result[kind] = { wav: sample.wav, recordedAt: sample.recordedAt, features: audioFeatures(sample.wav) }
  }
  if (result.enabled && (!result.wake || !result.close))
    throw new Error('Bitte Audio-Startwort und Audio-Stoppwort aufnehmen oder den Audiomodus ausschalten.')
  return result
}

export async function saveAudioTriggers(config: AudioTriggers): Promise<void> {
  if (config.enabled && (!config.wake || !config.close)) throw new Error('Bitte zuerst beide Audio-Auslöser aufnehmen.')
  if (config.wake && config.close && audioDistance(config.wake.features, config.close.features) < 0.15)
    throw new Error('Start- und Stoppaufnahme klingen zu ähnlich. Bitte deutlich unterschiedliche Wörter aufnehmen.')
  const store = await voiceInputStore('luczor.audio-triggers.json')
  await store.set('triggers', config)
  await store.save()
  window.dispatchEvent(new Event('luczor:voice-settings-changed'))
}

export async function recordAudioTrigger(): Promise<{ finish(): Promise<AudioTriggerSample>; cancel(): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  let context: AudioContext | undefined
  let processor: ScriptProcessorNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const frames: Float32Array[] = []
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    processor?.disconnect()
    source?.disconnect()
    stream.getTracks().forEach(track => track.stop())
    void context?.close().catch(() => undefined)
  }
  try {
    context = new AudioContext()
    await context.resume()
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(4096, 1, 1)
    let count = 0
    processor.onaudioprocess = event => {
      if (count >= context!.sampleRate * 5) return
      const frame = new Float32Array(event.inputBuffer.getChannelData(0))
      frames.push(frame)
      count += frame.length
    }
    source.connect(processor)
    processor.connect(context.destination)
    timer = setTimeout(close, 5500)
    return {
      cancel: close,
      async finish() {
        close()
        const wav = chunksToWavBase64(frames, context!.sampleRate)
        return { wav, features: audioFeatures(wav), recordedAt: new Date().toISOString() }
      },
    }
  } catch (error) {
    close()
    throw error
  }
}
