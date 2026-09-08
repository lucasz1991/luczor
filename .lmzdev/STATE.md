# Current state

## 2026-09-06 | Luczor Mini und entfernte UI-Bibliothek

- Separates rahmenloses, transparentes Tauri-Fenster `luczor-mini`: standardmaessig Always-on-top, frei verschiebbar, Kreis-/Chat-/Antwortvorschau-Groessen, an Monitor-Arbeitsflaeche und DPI angepasst. Automatischer Start und Wiederoeffnen ueber Header, Systemstatus und Tray. Browser-Fallback verwendet dieselbe Vue-Komponente.
- Kreisoptik aus dem Live-Status mit echten Verarbeitungs-, Ausfuehrungs-, Entscheidungs-, Mikrofon-, Sprach-, Fehler-, Not-Aus- und Antwortzustaenden. Reduzierte Bewegung beruecksichtigt; Antworten kurz als Sprechblase, Entscheidungen dauerhaft bedienbar.
- Temporaerer projektgebundener Verlauf mit eigenem fluechtigem Tool-Journal, Auswahlantworten, Kopieren, Abbrechen und bestaetigtem Leeren. Ein Agentenlauf zur Zeit; Hauptchat-Freigaben sind im Mini erreichbar. Alte Session-Aktionen und spaete Abbruchereignisse werden ignoriert; die Sperre bleibt bis zum wirklichen Laufende erhalten.
- Separater Einstieg verhindert doppelte Modell-, Store-, Sync- oder Mikrofoninitialisierung. Native Capability erlaubt nur validierte Mini-Aktionen, eigene Fensterbedienung, Snapshot-Lesen und den bestehenden geprueften HTTP(S)-Linkpfad. Bestehende Freigaben, Ausgabepruefung und externe Routingkontrolle bleiben aktiv.
- UI-Bibliothek und ihr Menuepunkt auf ausdruecklichen Browser-Kommentar entfernt; verwendete Beautiful-UI-Komponenten und MIT-Herkunft bleiben erhalten. Die bestehende Vorschau auf Port 1428 wurde neu geladen und die Entfernung sichtbar bestaetigt.
- Aktuelle integrierte Frontend-Abnahme: 53 Vitest-Dateien / 489 Tests, ESLint, TypeScript und Vite-Build bestanden. 74 Rust-Tests, Cargo Check und Clippy bestanden. Browserpruefung mit expliziter Fixture: Drag, Oeffnen/Einklappen, kompakte Freigaben, Auswahlantwort, Abbruch, Leeren und 420 x 660 Pixel; normale Viewportgroesse wiederhergestellt.
- Dokumentation: `docs/mini-chat.md`. Native Always-on-top-/Minimierungs-, Hardware- und echte Inferenzabnahme bleiben getrennt von der erfolgreichen Kompilierung und Browser-Fixture; kein Installer und kein Deployment.
- Finaler nativer Debug-Testbuild mit separater Local-Test-Identitaet erfolgreich: `src-tauri/target/debug/tauri-app.exe`, 41.983.488 Bytes, SHA-256 `35EBDF5CAE216D8EB42F165FCF124372E095C1990B4D937EF590BEB2B86B8DF8`, fertig 2026-09-06T02:55:14Z. Auch die Release-Kompilierung bestand; der abschliessende Debug-Build enthaelt die letzte kompakte Freigabedarstellung.

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

## 2026-09-06 | Funktionsumfang und Steuerung erweitert

- 35 registrierte Werkzeuge einschliesslich memory_recall, sichtbare Freigaben, verbesserte Erinnerungsrelevanz und native Monitorsteuerung. Lokale Gesamtgates: 575 Frontendtests, 78 Rusttests, Typecheck, Lint, Format, Build und Clippy bestanden.
- Vollbericht und Grenzen: ../.lmzdev/artifacts/reports/2026-09-06-capabilities-memory-computer.md (bezogen auf app/). Benutzerdokumentation: docs/capabilities-and-memory.md.

## 2026-09-06T04:23:09Z | Projektagenten und Erinnerungsuebertragung

- Agenten & Erinnerungen: verwaltete Codex-Auftraege, eigene und richtliniengesteuerte Modellagenten, persistente Codex-Sitzungsverknuepfung, verifizierte Desktop-Uebergabe und ausgewaehlte ChatGPT-/Codex-Erinnerungsimporte integriert.
- 38 Werkzeuge; Not-Aus/Modus/Kontowechsel, gemeinsame native Ordnersperren, Paketfreigabe und provider-sichere Ergebnisuebergabe. SQL bleibt gemeinsamer Memory-Store, Cognee Projektion.
- Tests: 660 Frontendtests, 89 Rusttests (1 interaktiver Monitor-Smoke ignoriert), kanonischer Typecheck, ESLint, Prettier, Clippy und Diffcheck bestanden. Browser-Fixture mit Start/Ergebnis/Import/Abbruch geprueft.
- Grenzen: Desktop-Oeffnen bestaetigt keine gespeicherte Desktop-Projektanlage. ChatGPT-Uebergabe per kopierbarem Auftrag/ausgewaehltem Import. Keine echte Inferenz, Anmeldung, Installation, Veroeffentlichung oder Produktivmigration.
- Bedienung: app/docs/agent-hub.md. Bericht: .lmzdev/artifacts/reports/2026-09-06-agent-hub-memory-transfer.md.

### Finaler lokaler Build – 2026-09-06

- Windows-Debug-Build mit 186 Frontendmodulen erfolgreich: app/src-tauri/target/debug/tauri-app.exe, 42482176 Bytes, SHA256 DD082DC77BAFA37DE0E2CDEC30AA771AA4D0C553BB2918506E423CBC94AA3F12.
- Build erstellt, nicht installiert/gestartet; keine echte Modellinferenz oder Desktop-Sitzungsuebergabe. QA-Listener1437 beendet. Abschlussdokumentation app/docs/agent-hub.md.


## 2026-09-06T20:43:03Z | Chatkommentare, Vorlesen und Live-Stream
- Persistente öffentliche Zwischenkommentare und Arbeitsschritte, gemeinsamer inkrementeller Parser und FIFO-Vorlesen im Hauptchat fertig. Ziele/Checklisten absolut, unabhängig einklappbar.
- 1.002 Frontendtests plus 62 gezielte Nachprüfungen, Typecheck, Lint, Format, Browser-Fixtures und nativer Debugbuild bestanden.
- Neuer Debug-Testbuild erstellt; laufender Release sperrte seine EXE und blieb offen. Keine neue echte Inferenz/Audioabnahme oder Serververöffentlichung.
- Bericht: E:/projekte/luczor/.lmzdev/artifacts/reports/2026-09-06-chat-commentary-continuity.md. Ownership abgeschlossen.

## 2026-09-07 | Codex/mini_workspace | Gemeinsames Design und Chat/Workspace
- Native Mini-Webview und Browser-Overlay uebernehmen Hauptchat-Theme, Akzent und Komponenten. Statusorb bleibt an reale oeffentliche Laufzeitphasen gebunden.
- Projektchat ist derselbe persistierte Main-Verlauf; Workspace bleibt fluechtige lokale Verwaltung mit sechs expliziten Werkzeugen fuer Projekt-/Chatuebersicht, Metadaten und vorbereitete Agentenauftraege. Dateien/Desktop behalten das gewaehlte Arbeitsprojekt und bestehende Freigaben.
- Gemeinsame Startsperre, Kontextkennungen, getrennte Entwuerfe und begrenzte Zustandsabbilder integriert. Workspace leeren loescht keinen Projektchat. Browsergrenzen und erreichbare Entscheidungen bei420x660 geprueft.
- Final:1066 Frontendtests/100Dateien und122Rusttests/1ignoriert, Typecheck/Lint/Format/fmt/Clippy sowie gemeinsamer nativer Release ohne Bundle erfolgreich. EXE14.585.856Bytes, SHA256 96109C1BB7FEB1CFA8ACE0D7F9B9F2E63859243418F36FF07F1C6D8B0484ADDF. Laufende Debug-App blieb offen.
- Keine neue echte Inferenz/Mikrofon-/native GUI-Abnahme, kein Installer/Deploy/Commit. Bedienung:docs/mini-chat.md; Bericht:artifacts/reports/2026-09-07-mini-workspace.md. Browser1430 fuer Vorschau offen; synthetische Fixture geschlossen und Viewport zurueckgesetzt.

## 2026-09-07T00:09:00Z | Codex/root | Vorlesen und V2-Stimmen abgeschlossen
- Öffentliche lokale Zwischenkommentare/Antworten dürfen nach ausdrücklicher Nutzerzustimmung vorgelesen werden. Separate an Server/Client gebundene Zustimmung aktiviert; allgemeine Settings-Datei der laufenden App blieb unverändert. FIFO, Abbruch und Datenschutzklassifikation erhalten.
- Wortmarkierung aus tatsächlichem Audiotakt mit ausdrücklich näherungsweiser Wortposition. V2-Katalog/Auswahl/Hörprobe/Speichern inklusive Benni, Jürgen, Alba, Javert; Piper bleibt Standard.
- Backend a00d2cbbf3bb39c7a09df77750c05239ec605700 mit privatem Backup veröffentlicht; 536 Dateien geprüft, Produktionschecks und HTTPS Health/Ready/Katalog/Benni/Piper/401/422 erfolgreich. Spätere parallele Agententeamänderungen nicht veröffentlicht.
- 1083 Frontendtests plus 2 zusätzliche Settings-Regressionen (7 Settings-Tests im Nachlauf), 508 Backendtests/3444 Assertions, Typecheck/Lint/Format/Pint/gezieltes PHPStan bestanden. Browser mit echter Audiodatei bei Desktop/320px geprüft; keine neue native Modell-/Mikrofonabnahme.
- Release ohne Bundle: E:/projekte/luczor/app/src-tauri/target/release/tauri-app.exe, 14590464 Bytes, SHA256 8CE0F4E164B47C7C4FA91349176688CE92C04001412DCBE969786DDD805EB232. Laufende Debug-App PID95888 erhalten. Prüftabs und eigener Vite1444 geschlossen.
- Bericht: app/.lmzdev/artifacts/reports/2026-09-07-commentary-read-aloud.md; Bedienung: app/docs/assistant-profile-and-streaming.md. Kein offenes Arbeitspaket dieser Erweiterung; Nutzer muss zum neuen Release wechseln.

## 2026-09-07T00:16:27Z | External specialist routing
- Explicit agent specialist preference is available with unchanged egress/policy approval boundaries. 142 focused tests, typecheck, scoped lint/format/diff passed; full integration and native checks remain root-owned.

## 2026-09-07 | Codex/routing_review | Hintergrundvorbereitung
- Standardmaessige lokale Modellbereitschaft und revisions-/scopegebundener fluechtiger Projektkontextcache integriert; Startup auch ohne Projekt, signierte Policyerneuerung und Abbruch-/Invalidationsschutz. Keine native Modellgenerierung im Hintergrund.
- Finale gezielte Pruefung142Tests/8Dateien sowie ESLint/Format gruen; Gesamtgates/Build durch Root. Bedienung und Abnahmegrenzen: docs/background-preparation.md.


## 2026-09-07T00:25:39Z | Resident local runtime scope
- Local runtime identity now remains stable across chat/coding/planning and conversation changes within one authenticated project/repository/desktop session. 100 coordinator tests and scoped quality gates passed; root owns native cache flag and integration.

## 2026-09-07T18:57:00Z | Flüssiges Vorlesen abgeschlossen

- Satzweise TTS-Anfragen durch eine Ganztextanfrage ersetzt; nur über 4.000 Zeichen bleiben große Wortgrenzen-Abschnitte. Echte mehrsätzige Benni-WAV: eine Anfrage, 426.284 Bytes, 8,880 Sekunden.
- Antwort und Zwischenkommentare teilen eine Auswahlleiste mit „Auswahl vorlesen“. Browser bestätigte genau eine Auswahl-Anfrage, laufzeitbasierte Wortmarkierung und anschließendes Entfernen der Auswahl.
- Fallback-Control in den kompakten Promptkopf verschoben. Beide Hinweise unter dem Composer entfernt; 1096px und 320px ohne horizontalen Überlauf.
- 113 Testdateien / 1.246 Tests, Typecheck, ESLint, Prettier, Diffcheck und Releasebuild ohne Bundle bestanden. EXE 14.625.280 Bytes, SHA256 34359240E360022639C852C23A8EA38190BB9A99C819A750B134B6EF3827FD72. Laufende Debug-App PID114596 blieb geöffnet und reagiert.
