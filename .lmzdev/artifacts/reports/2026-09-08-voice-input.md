# Voice input / audio triggers

Status: completed-local; final shared desktop build succeeded and was not launched.

## Scope

Voice settings inside main and Mini composers; close-word/silence/either completion; wake silence bug and empty activation recovery; STT preflight; Mini microphone writes its own draft instead of silently controlling the main composer.

User extension: locally record, store, audition, delete and test start/stop audio templates. Local MFCC + bounded DTW recognition before STT; recorded controls replace text controls and are spoken as isolated utterances. Similar references fail validation; enabled templates require both recordings. Real-world recognition accuracy is not established by synthetic tests.

## Boundaries

Four native IPC commands permit only main/Mini labels, allowlisted voice keys and bounded audio. Mini does not receive the general Store plugin or device credentials, cannot install runtimes, and performs only local STT using the configured installed runtime. Microphone ownership uses a fixed native event; arbitrary event emission is not granted to Mini.

Concurrent changes from Local Model task 01a074b7-2823-7b72-8e7d-f5ec1b03e7d1 remain preserved. Local model ownership returned to that task after coordinating colliding test-import fixes. Main project activity accumulator changed to Map to resolve a lint failure without changing display behavior. No backend changes or server deployment by this voice task.

## Evidence

- Frontend full run: 114 files / 1,259 tests passed. Additional Mini-store boundary regression and engine lifecycle rerun: 2 files / 29 tests passed.
- Vue typecheck and focused Voice ESLint passed (one fixture-path warning). Native voice-input boundary test passed. First release build succeeded before final responsive layout correction.
- Global checks caught concurrent model-test import changes (owned and addressed by Local Model task) and 24 pre-existing/current id-length findings in src/state/store.ts. These do not originate in the Voice implementation; no global green result is claimed until rerun.
- Installed runtime: AppData/Roaming/de.luczor.desktop/voice/2026.07.10/Release/whisper-cli.exe + ggml-base.bin. Synthetic German sentence decoded in about 1.4 seconds; recognizer rendered the product name as Luxua, which was added to the fixed product alias vocabulary. No arbitrary fuzzy text matching.
- Isolated browser fixture /tests/fixtures/voice-input.html: actual WebAudio enrollment from synthetic Piper WAV streams, local fixture storage, successful independent wake probe, rejected negative phrase, saved three-second silence mode and emitted start action. No real microphone, private speech, model action or server message used in the fixture.
- Main and Mini dialogs visually checked at desktop and 320x720. Main popover anchor and border-box sizing corrected after mobile inspection.

Usage: docs/voice-input-and-audio-triggers.md.

## Final build

- `src-tauri/target/release/tauri-app.exe`, 14,660,096 bytes; UTC 2026-09-08T03:28:31.9614259Z.
- SHA256 `ED32C32EBD458B2A380566725BDF768C8F28D92A415882453F747B334B2A48E0`.
- Includes final mobile Voice CSS and the frozen Local Model changes (source modified 03:24:06Z, before final Rust compilation at 03:26:52Z).
- Coordinating Local Model task reported its final 1,262 frontend tests, 29 native model tests, typecheck, focused ESLint and all-target Clippy green. Voice-specific native boundary and frontend regression tests also passed as recorded above. General store.ts lint findings remain outside this scope; full-repository ESLint is not claimed green.
- Own temporary browser tabs closed, viewport override reset and Vite1446 stopped. No actual user microphone recording enrolled and no native app session started/stopped.
- Machine-readable build evidence: `2026-09-08-voice-input-build.json`.
