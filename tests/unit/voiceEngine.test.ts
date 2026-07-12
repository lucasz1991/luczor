import { describe, expect, it } from "vitest";
import { findWakeWord } from "@/services/voice/voiceEngine";
import { cleanSttTranscript, isSttPlaceholderTranscript } from "@/services/voice/transcript";
import { encodeWavPCM16, resampleMono, STT_SAMPLE_RATE } from "@/services/voice/wav";

describe("Luczor wake-word matching", () => {
  it.each([
    ["Luczor, starte den Timer", "luczor"],
    ["Luxor, starte den Timer", "luxor"],
    ["Lutz or starte den Timer", "lutz or"],
    ["Luczer starte den Timer", "luczor"],
  ])("accepts the STT variant %s", (text, matched) => {
    expect(findWakeWord(text, "luczor")).toMatchObject({ matched });
  });

  it("returns original-text offsets for the command remainder", () => {
    const text = "Bitte Luxor, starte den Timer";
    const wake = findWakeWord(text, "luczor");

    expect(wake).not.toBeNull();
    expect(text.slice(wake!.end).replace(/^[\s,.:;!?-]+/, "").trim()).toBe("starte den Timer");
  });

  it("does not apply Luczor aliases to a custom wake word", () => {
    expect(findWakeWord("Luxor, starte den Timer", "jarvis")).toBeNull();
  });
});

describe("STT placeholder filtering", () => {
  it.each(["[BLANK_AUDIO]", "[Musik]", "[MUSIC] [BLANK_AUDIO]", "<|silence|>"])(
    "drops a non-speech marker %s",
    (text) => {
      expect(isSttPlaceholderTranscript(text)).toBe(true);
      expect(cleanSttTranscript(text)).toBe("");
    },
  );

  it("preserves actual commands", () => {
    expect(isSttPlaceholderTranscript("Musik starten")).toBe(false);
    expect(cleanSttTranscript("Musik starten")).toBe("Musik starten");
  });
});

describe("voice WAV encoding", () => {
  it("downsamples captured audio to the requested rate by averaging source intervals", () => {
    const samples = new Float32Array([0, 3, 6, 9, 12, 15]);

    expect([...resampleMono(samples, 6, 2)]).toEqual([3, 12]);
  });

  it("writes 16 kHz mono headers by default", () => {
    const wav = encodeWavPCM16([new Float32Array(48)], 48_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(view.getUint32(24, true)).toBe(STT_SAMPLE_RATE);
    expect(view.getUint32(40, true)).toBe(32); // 48 kHz -> 16 kHz: 16 PCM16 samples
  });
});
