// Small, conservative client-side guard for Whisper's non-speech markers.
// Only a transcript made entirely of bracketed markers is discarded, so a
// real command such as "Musik starten" remains untouched.

const NON_SPEECH_MARKERS = new Set([
  "blank",
  "blank audio",
  "music",
  "musik",
  "silence",
  "stille",
  "noise",
  "background noise",
  "background music",
  "unintelligible",
  "inaudible",
  "applause",
]);

function normalizeMarker(value: string): string {
  return value
    .toLocaleLowerCase("de-DE")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True only for a transcript consisting exclusively of known non-speech markers. */
export function isSttPlaceholderTranscript(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;

  let foundMarker = false;
  const remaining = text.replace(/\[\s*([^\]]+?)\s*\]|\(\s*([^)]*?)\s*\)|<\|\s*([^|]*?)\s*\|>/gu, (full, square, parentheses, whisper) => {
    const marker = normalizeMarker(square ?? parentheses ?? whisper ?? "");
    if (!NON_SPEECH_MARKERS.has(marker)) return full;
    foundMarker = true;
    return "";
  });

  return foundMarker && remaining.replace(/[\s,.;:!?…—–()[\]{}-]/gu, "").length === 0;
}

export function cleanSttTranscript(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return isSttPlaceholderTranscript(text) ? "" : text;
}
