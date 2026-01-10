import { ref } from "vue";

type WavResult = { base64: string; mime: string };

export function usePushToTalk() {
  const isRecording = ref(false);
  const error = ref<string | null>(null);

  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;

  let chunks: Float32Array[] = [];
  let sampleRate = 48000;

  async function start() {
    error.value = null;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    audioCtx = new AudioContext();
    sampleRate = audioCtx.sampleRate;

    source = audioCtx.createMediaStreamSource(stream);

    // ScriptProcessor ist deprecated, aber für MVP ok & simpel.
    // Buffergröße 4096 ist ein guter Start.
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    chunks = [];
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input)); // copy
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

    isRecording.value = true;
  }

  async function stop(): Promise<WavResult | null> {
    if (!isRecording.value) return null;

    try {
      // cleanup nodes
      processor?.disconnect();
      source?.disconnect();

      processor = null;
      source = null;

      // stop stream tracks
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;

      // close audio context
      await audioCtx?.close();
      audioCtx = null;

      // build WAV
      const wavBytes = encodeWavPCM16(chunks, sampleRate);
      const base64 = bytesToBase64(wavBytes);

      isRecording.value = false;

      return { base64, mime: "audio/wav" };
    } catch (e: any) {
      error.value = e?.message ?? "Push-to-talk stop failed";
      isRecording.value = false;
      return null;
    }
  }

  function cancel() {
    try {
      processor?.disconnect();
      source?.disconnect();
    } catch {}

    processor = null;
    source = null;

    stream?.getTracks().forEach((t) => t.stop());
    stream = null;

    audioCtx?.close().catch(() => {});
    audioCtx = null;

    chunks = [];
    isRecording.value = false;
  }

  return { isRecording, error, start, stop, cancel };
}

/* ---------- WAV encoding helpers ---------- */

function encodeWavPCM16(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const samples = flattenFloat32(chunks);
  const pcm16 = floatTo16BitPCM(samples);

  const headerSize = 44;
  const dataSize = pcm16.length * 2;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true);  // AudioFormat = PCM
  view.setUint16(22, 1, true);  // NumChannels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = sampleRate * numChannels * bytesPerSample
  view.setUint16(32, 2, true); // BlockAlign = numChannels * bytesPerSample
  view.setUint16(34, 16, true); // BitsPerSample

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i]!, true);
  }

  return new Uint8Array(buffer);
}

function flattenFloat32(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i] ?? 0;
    const s = Math.max(-1, Math.min(1, v));
    output[i] = s < 0 ? (s * 0x8000) : (s * 0x7fff);
  }
  return output;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
