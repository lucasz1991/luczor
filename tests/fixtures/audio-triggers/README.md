# Synthetic audio fixtures

Generated locally on 2026-09-08 with the installed Piper `de_DE-thorsten-medium` voice. No microphone or personal recording.

- `wake.wav`: Luxor.
- `wake-probe.wav`: separate synthesis of Luxor.
- `close.wav`: Auftrag beenden.
- `negative.wav`: Termin prüfen.

The tests resample the PCM audio to the same 16 kHz format as live capture. These prove deterministic template matching and negative examples, not recognition accuracy across real microphones, rooms or speakers.
