// src/services/voice/voiceStrategy.ts
//
// Pure, testable hands-free dictation strategies (SOLL §5.3). Two mutually
// exclusive strategies drive continuous listening:
//
//  - "safeword":   armed until an ACTIVATION phrase is heard, then dictates
//                  until an END phrase (or manual stop).
//  - "continuous": no start/end word required — dictates from first speech and
//                  auto-finalizes after a long pause (default 5s) OR an optional
//                  end phrase.
//
// This module is transport-agnostic: it consumes already-transcribed utterances
// (pushSegment) and a periodic clock (tick), so it can be unit-tested without
// audio. VoiceEngine wires real STT + a timer into it.

export type HandsFreeStrategy = "continuous" | "safeword";

export type StrategyConfig = {
  strategy: HandsFreeStrategy;
  triggerPhrase: string;       // safeword: activation phrase
  endPhrase: string;           // safeword end phrase / optional continuous end
  continuousSilenceMs: number; // continuous: pause that finalizes a dictation
};

export type MachineState = "armed" | "dictating";

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("de-DE")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Token = { n: string; start: number; end: number };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = match[0] ?? "";
    const n = normalize(raw);
    const start = match.index;
    if (n && start !== undefined) out.push({ n, start, end: start + raw.length });
  }
  return out;
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokenMatch(a: string, b: string): boolean {
  // Exact, or a single-edit fuzzy match for longer words (STT robustness).
  return a === b || (a.length >= 4 && b.length >= 4 && withinOneEdit(a, b));
}

/** Locate `phrase` in `text` (whitespace-insensitive, lightly fuzzy). */
export function splitOnPhrase(text: string, phrase: string): { before: string; after: string } | null {
  const candidate = normalize(phrase).split(" ").filter(Boolean);
  if (candidate.length === 0) return null;
  const words = tokenize(text);
  for (let start = 0; start + candidate.length <= words.length; start++) {
    if (candidate.every((part, offset) => tokenMatch(words[start + offset]!.n, part))) {
      const from = words[start]!.start;
      const to = words[start + candidate.length - 1]!.end;
      return {
        before: text.slice(0, from).trim(),
        after: text.slice(to).replace(/^[\s,.:;!?-]+/, "").trim(),
      };
    }
  }
  return null;
}

export class HandsFreeMachine {
  state: MachineState = "armed";
  private buffer: string[] = [];
  private lastSegmentAt = 0;

  constructor(
    private cfg: StrategyConfig,
    private onCommand: (text: string) => void,
    private onPartial?: (text: string) => void,
  ) {}

  reset(): void {
    this.state = "armed";
    this.buffer = [];
  }

  private emitPartial(): void {
    this.onPartial?.(this.buffer.join(" ").trim());
  }

  private finalize(): void {
    const text = this.buffer.join(" ").trim();
    this.buffer = [];
    this.state = "armed";
    this.emitPartial();
    if (text) this.onCommand(text);
  }

  /** Feed a transcribed utterance heard at time `at` (ms). */
  pushSegment(text: string, at: number): void {
    const clean = (text ?? "").trim();
    if (!clean) return;
    this.lastSegmentAt = at;

    if (this.cfg.strategy === "safeword") {
      if (this.state === "armed") {
        const match = splitOnPhrase(clean, this.cfg.triggerPhrase);
        if (!match) return; // ambient speech ignored until the activation phrase
        this.state = "dictating";
        this.buffer = match.after ? [match.after] : [];
        this.emitPartial();
        return;
      }
      const end = this.cfg.endPhrase ? splitOnPhrase(clean, this.cfg.endPhrase) : null;
      if (end) {
        if (end.before) this.buffer.push(end.before);
        this.finalize();
        return;
      }
      this.buffer.push(clean);
      this.emitPartial();
      return;
    }

    // continuous — arm on first speech, then also honour an optional end phrase
    // in the very same utterance.
    if (this.state === "armed") {
      this.state = "dictating";
      this.buffer = [];
    }
    const end = this.cfg.endPhrase ? splitOnPhrase(clean, this.cfg.endPhrase) : null;
    if (end) {
      if (end.before) this.buffer.push(end.before);
      this.finalize();
      return;
    }
    this.buffer.push(clean);
    this.emitPartial();
  }

  /** Call periodically; finalizes a continuous dictation after a long pause. */
  tick(now: number): void {
    if (this.state === "dictating" && this.cfg.strategy === "continuous" && this.buffer.length) {
      if (now - this.lastSegmentAt >= Math.max(1000, this.cfg.continuousSilenceMs)) {
        this.finalize();
      }
    }
  }
}
