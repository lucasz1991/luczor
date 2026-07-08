// src/services/voice/wav.ts
// Minimal PCM16 WAV encoding for captured Float32 mic frames.

export function encodeWavPCM16(chunks: Float32Array[], sampleRate: number): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const samples = new Float32Array(length);
  let off = 0;
  for (const c of chunks) {
    samples.set(c, off);
    off += c.length;
  }

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
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
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

export function chunksToWavBase64(chunks: Float32Array[], sampleRate: number): string {
  return bytesToBase64(encodeWavPCM16(chunks, sampleRate));
}
