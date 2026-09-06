# Current state

## 2026-09-06 | Einheitliche sichtbare Diktateinstellungen

- `localVoice.ts` stellt einen gemeinsamen Resolver fuer UI und Laufzeit bereit. Explizites `voice_mode` bestimmt Wake-Word oder Continuous; `hands_free_strategy=continuous` bleibt nur als Fallback erhalten, solange kein neuer Modus existiert. `voice_trigger_phrase` bleibt nur als Fallback fuer ein noch nicht gesetztes `voice_wake_word` erhalten.
- Sichtbar und tatsaechlich benutzt werden Wake-Word, Close-Word (`voice_end_phrase`, Standard `luczor stopp`), Continuous-Stille 1–30 Sekunden (Standard 5) und `voice_auto_submit` (Standard false). Die UI erklaert, dass automatisches Senden Agentenaktionen ausloesen kann; es ist eine explizite Option.
- `handsFreeFromVoice()` leitet die Engine-Konfiguration aus einem einzigen gespeicherten Snapshot ab. Phrase-Validierung nutzt denselben kanonischen Luczor-Alias-/Unicode-Matcher wie die parallel bearbeitete Engine/Strategie und verhindert leere, zu lange oder gleichwertige Start-/Schlussphrasen.
- Nach erfolgreichem Settings-Save wird `luczor:voice-settings-changed` versandt, damit der App-Owner die alte Mikrofon-Sitzung beenden kann.
- `ensureVoiceRuntime()` prueft standardmaessig nur STT; bereits bereite Whisper-Eingabe erzwingt keinen Piper-Download. Explizites `localTts()` verlangt weiterhin TTS-Readiness. Keine Runtime wurde real installiert.
- Abnahme dieses Teilpakets: 37/37 fokussierte Tests mit Node 22.22.0 / `--maxWorkers=1`, ESLint ohne Warnungen, Prettier und Diff-Check bestanden. Gesamtsuite und integrierte Mikrofon-/UI-Abnahme folgen nach Root-Integration.

## 2026-09-06 | Beautiful UI im Tauri-Workspace

- Alle 21 Beautiful-UI-Komponenten als Vue-3-Komponenten unter `src/components/ai/` angelegt; 35 unveraenderte MIT-Originaldateien mit SHA-256-Abgleich und Herkunft unter `vendor/beautiful-ui/` abgelegt. Keine neue Runtime-Abhaengigkeit.
- Neue Chatoberflaeche mit Projekt-Sidebar, PromptBar, echten Modell-/Empfangs-/Tool-Schritten, aufklappbarem Status, Antwortdarstellung, Codebloecken, Plan, Freigabekarten, Memory-Vorschlaegen und Kontextkarten eingebunden. Die UI-Bibliothek bietet alle 21 Komponenten mit expliziten Beispieldaten, Suche sowie heller/dunkler Vorschau.
- Streaming-Text wird erst nach der bestehenden finalen Ausgabekontrolle animiert. Ungefilterte Modellnotizen und Tool-Runden werden nicht angezeigt. Numerische Fortschrittsereignisse kommen bereits waehrend des echten Empfangs; Abbruch/Fehler/verspaetete Ereignisse sind abgedeckt.
- Bestehende und parallele lokale Modell-/Server-TTS-/Settings-Aenderungen erhalten; App-Integration erfolgte auf jeweils frisch gelesenen Dateien. Forschungscheckout und vorherige Diff-/Hash-Snapshots sind unter `.lmzdev/artifacts/research/beautiful-ui/` lokal ignoriert.
- Endgueltige Pruefung mit Node 22.22.0: 48 Vitest-Dateien / 360 Tests bestanden, ESLint ohne Befund, TypeScript und Vite-Produktionsbuild bestanden. Browserpruefung bei 800 x 600 sowie 390 x 844 und normaler Fenstergroesse; helle/dunkle Bibliothek, Filter, Suche, Clipboard, einmalige Freigaben, Vorschau-Stop und Enter/Shift+Enter/Escape geprueft. Fehlende native Browser-Bridge beendet den Chat kontrolliert statt mit endlosem Ladezustand.
- Nativer Release-Testbuild mit `pnpm tauri build --no-bundle --config src-tauri/tauri.local-test.conf.json` erfolgreich: `src-tauri/target/release/tauri-app.exe`, 14.118.400 Bytes, SHA-256 `D90605D52789A32D5AE1C277EA42D62BA9AED04318B98E5A608395208FC12C5D`, fertig 2026-09-06T01:59:48Z. Kein Installer oder Deployment; echte Modell-, Mikrofon- und native Tool-Ausfuehrung wurden in diesem UI-Arbeitsschritt nicht abgenommen.
- Komponenten-/Laufzeitdokumentation: `docs/beautiful-ui.md`.

## 2026-09-06 | Gemeinsame Server-Sprachausgabe

- Desktop-TTS nutzt den authentifizierten Luczor-Endpunkt `/api/v1/voice/tts` mit einem unveraenderlichen API-Snapshot pro Ausgabe. Der gemeinsame Dienstschluessel bleibt im Backend. STT bleibt lokal.
- Servertransport erzwingt HTTPS ausser explizitem Entwicklungs-Loopback, Redirectsperre, 4000 Zeichen pro Abschnitt, 16 MiB WAV-Antwortlimit und eine 160-Sekunden-Gesamtdeadline einschliesslich Body.
- Wiedergabe besitzt genau eine aktive Sitzung, hoechstens einen vorab erzeugten Folgeabschnitt, echte `onplaying`-Statuswechsel sowie Abort-/Blob-URL-Cleanup. Stop und Ersetzung liefern `cancelled`; Identitaetswechsel koennen neue Ausgaben mit `suspendSpeech()` bis zum Abschluss sperren.
- Voice-Einstellungen erklaeren Server-TTS/lokale STT und bieten einen synthetischen Sprachtest ueber den von App injizierten mikrofonstummgeschalteten Callback.
- Verifiziert mit Node 22.22.0 im finalen Stand: Gesamtsuite 48 Dateien / 360 Tests bestanden, Typecheck bestanden, Vite-Produktionsbuild mit 176 Modulen bestanden, fokussiertes ESLint ohne Warnungen sowie Prettier bestanden. Zwischenzeitliche parallele Chat-Fixture-/Typecheckfehler wurden vor der finalen Abnahme korrigiert.
- Settings-Identitaetswechsel sind serialisiert und dauerhaft fail closed: vor jeder Key-Aenderung wird `about:blank` als nicht netzwerkfaehige Serveradresse gespeichert, dann der native/cached Key geleert und der gewuenschte Key verifiziert, danach erst die Zieladresse freigegeben. Fehler halten die Sprachausgabe bis zum erfolgreichen erneuten Speichern gesperrt; die UI zeigt einen konkreten Fehler. 13 Tests decken Teilschreibfehler, Cacheabweichung, Neustartgrenze, Retry und konkurrierende Saves ab.
- Die neue StreamingText-Ansicht erhaelt additive Speech-Disabled-/Begruendungs-Props; App setzt sie ueber denselben serverSpeechText-Guard wie den eigentlichen Aufruf. Private und unvollstaendige Antworten zeigen einen deaktivierten Vorleseknopf mit Begruendung.
- Reale Server-/Audio-/GUI-Abnahme wird vom Root-Werkstrom koordiniert; dieser Desktop-Teil hat keinen produktiven Dienst gestartet oder deployed.

## Confirmed

- LMZ Dev workspace initialized.
- Ordinary desktop memory recall excludes session secrets and every record whose write policy is local-only.
- Repository provenance recognizes canonical source/origin key variants, and DLP inspects UTF-8 byte size plus canonical secret key names.
- API, memory, context and health requests share a hard 10-second fetch deadline.
- Tauri 2 registriert Dialog-, Workspace-, Graph-, Memory- und Systemkommandos konsistent in Plugin-Setup, Invoke-Handler, AppManifest und der nur fuer `main` gueltigen Capability; die Remote-Browser-Webview behaelt ausschliesslich `browser_report`.
- `.nvmrc` pinnt Node 22.22.0. Die Version ist zusaetzlich in NVM installiert; Wrapper und Installer-Build aktivieren sie samt Corepack nur pro Kindprozess und veraendern den globalen NVM-Symlink nicht.
- Ein eigener `Luczor Local Test`-NSIS-Pfad nutzt eine getrennte Bundle-Identitaet, `currentUser`, explizites `--no-sign` und keinen Updater. Produktion bleibt ohne echte Updater- und Signing-Werte fail closed.
- `scripts/run-local-model-test.ps1` und das danebenliegende Profil kapseln den lokalen Orca-E2E-Smoke: gepinnte Assets und Node-/pnpm-Version, externe Testsignierung, isolierte SQLite-/Storage-Pfade, Orca als einzig aktiviertes Modell, hidden Loopback-Prozesse und Secret-freier Abschlussbericht.

## Verification

- `pnpm vitest run --maxWorkers=1`: 30 files, 198 tests passed.
- Focused memory/transport/context tests: 5 files, 31 tests passed.
- Focused ESLint: passed with no findings.
- `pnpm typecheck`: passed.
- `cargo fmt --all -- --check`, `cargo check --all-targets`, 47 Rust-Tests und `cargo clippy --all-targets -- -D warnings`: bestanden.
- `pnpm tauri build --debug --no-bundle`: im finalen integrierten Stand bestanden; erzeugt `src-tauri/target/debug/tauri-app.exe` (40.297.984 Bytes, SHA-256 `7B5DAAC63A23C0C9496AE2A18B9972E3BDD643250BDAE743F8118DC9132037AE`).
- Der erzeugte Windows-Prozess lief zehn Sekunden responsiv und ohne Sofort-Crash; ausschliesslich der gestartete Test-PID wurde danach beendet.
- Der reale lokale Graph-Vertrag mit temporaerem Git-Repository, Hash-/Git-Stale, Secret-/Ignore-/Symlink-Grenzen, Principal-/Projektisolation und Unbind ist gruen; 15/15 Graph-Tests bestanden.
- Sechs Release-/PE-Regressionstests, Node-/Versions-/Local-Readiness, PowerShell-Syntax und Prettier bestanden. Der kanonische Node-22.22-/Corepack-Befehl erzeugte `src-tauri/target/debug/bundle/nsis/Luczor Local Test_2.9.3_x64-setup.exe` (7.792.520 Bytes, SHA-256 `86FC1E8A0A8EE9985E0FE3E747E81B0D936C181EFBCDDAD3C2B32281011F551A`); die PE-Zertifikatstabelle ist leer.
- PowerShell-Parser, JSON-Parse und `git diff --check` fuer Launcher und Profil bestanden. Der reale End-to-End-Lauf wurde in diesem Arbeitsschritt bewusst nicht gestartet.

## Risks and blockers

- Die systemweit aktive Node bleibt absichtlich 22.11.0; direkte globale PNPM-Aufrufe warnen weiterhin. Der dokumentierte Wrapper-/Corepack-Pfad ist projektkonform mit Node 22.22.0.
- Der Debug-Build ist erwartungsgemaess nicht code-signiert. Das Hauptfenster und die Projektordner-Schaltflaeche wurden sichtbar bestaetigt; die Windows-Aufnahmehilfe lieferte jedoch keine Klickgeometrie fuer den nativen Dialog. Echte Datei-/Computerfreigaben und ein signierter Installer benoetigen weiterhin eine interaktive Laufzeitabnahme.
- Der lokale NSIS-Installer wurde gebaut, aber nicht installiert. Produktions-Updater, Zertifikatsimport, Code-Signing, veroeffentlichter Update-/Rollback-Pfad und der gemeinsam bediente Ordnerdialog-/Approval-Smoke bleiben externe Abnahmen.
- Die parallel gehaertete Signatur des Laravel-Bootstrap-Kommandos muss vor dem ersten Lauf mit dem Launcher-Aufruf synchronisiert werden; der uebergebene Minimalstand verwendet noch `--token-file`.
