// src/services/voice/wav.ts
// Minimal PCM16 WAV encoding for captured Float32 mic frames.

// Whisper expects 16 kHz mono PCM. Encoding at the capture device's native
// 44.1/48 kHz wastes IPC bandwidth and leaves resampling to the native side.
export const STT_SAMPLE_RATE = 16_000;

function flattenChunks(chunks: Float32Array[]): Float32Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;

  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return samples;
}

/**
 * Resample a mono waveform using interval averaging for downsampling.
 * It is intentionally dependency-free because this runs on every utterance.
 */
export function resampleMono(samples: Float32Array, sourceSampleRate: number, targetSampleRate = STT_SAMPLE_RATE): Float32Array {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new RangeError("sourceSampleRate must be a positive number");
  }
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    throw new RangeError("targetSampleRate must be a positive number");
  }
  if (!samples.length || sourceSampleRate === targetSampleRate) return samples;

  const outputLength = Math.max(1, Math.round(samples.length * targetSampleRate / sourceSampleRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceSampleRate / targetSampleRate;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex++) {
    const start = outputIndex * ratio;
    const end = Math.min((outputIndex + 1) * ratio, samples.length);
    let total = 0;
    let weight = 0;

    for (let inputIndex = Math.floor(start); inputIndex < Math.ceil(end); inputIndex++) {
      const overlap = Math.min(end, inputIndex + 1) - Math.max(start, inputIndex);
      if (overlap <= 0) continue;
      total += (samples[inputIndex] ?? 0) * overlap;
      weight += overlap;
    }
    output[outputIndex] = weight ? total / weight : 0;
  }

  return output;
}

export function encodeWavPCM16(chunks: Float32Array[], sampleRate: number, targetSampleRate = STT_SAMPLE_RATE): Uint8Array {
  const samples = resampleMono(flattenChunks(chunks), sampleRate, targetSampleRate);

  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function chunksToWavBase64(chunks: Float32Array[], sampleRate: number, targetSampleRate = STT_SAMPLE_RATE): string {
  return bytesToBase64(encodeWavPCM16(chunks, sampleRate, targetSampleRate));
}
