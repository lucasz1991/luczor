import { ref } from "vue";
import { setMicLevel, pulse } from "@/state/hud";
import { chunksToWavBase64 } from "@/services/voice/wav";

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

      // Live mic RMS -> HUD level + audio pulse.
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
      const rms = Math.sqrt(sum / input.length);
      const level = Math.min(1, rms * 4); // scale up quiet speech
      setMicLevel(level);
      pulse("audio", level);
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

      // Build WAV through the shared voice encoder used by continuous listening.
      const base64 = chunksToWavBase64(chunks, sampleRate);

      setMicLevel(0);
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
    setMicLevel(0);
    isRecording.value = false;
  }

  return { isRecording, error, start, stop, cancel };
}
