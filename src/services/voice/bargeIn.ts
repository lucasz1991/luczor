// src/services/voice/bargeIn.ts
//
// SOLL §6 — barge-in detection for interruptible TTS. While Luczor speaks, the
// (echo-cancelled) mic is still analysed; sustained speech above a threshold
// triggers an interrupt so playback stops and the listener resumes.
//
// Pure + testable: it only consumes per-frame RMS values.

export class BargeInDetector {
  private count = 0

  /**
   * @param threshold RMS above which a frame counts as speech.
   * @param frames    consecutive speech frames required to trigger (debounce
   *                  against TTS echo bleed-through and transients).
   */
  constructor(
    private readonly threshold: number,
    private readonly frames: number
  ) {}

  reset(): void {
    this.count = 0
  }

  /** Feed one frame's RMS; returns true exactly once when speech is sustained. */
  push(rms: number): boolean {
    if (rms > this.threshold) {
      this.count += 1
      if (this.count >= this.frames) {
        this.count = 0
        return true
      }
    } else {
      this.count = 0
    }
    return false
  }
}
