# Tauri-App und lokale LLM-Bereitstellung – Analyse und Optimierungsoptionen

Stichtag: 2026-09-11
Grundlage: Arbeitsstand `app/` auf Commit `47aa7a9` mit 122 uncommitteten Dateien (Dirty Worktree). Alle Zeilenangaben beziehen sich auf diesen Stand.

Dieses Dokument ist eine Code- und Betriebsanalyse, keine zweite Statuswahrheit neben `IST-Zustand.md`. Es benennt Optionen; keine davon ist eine Freigabeempfehlung ohne eigene Messung.

---

## 1. Kurzfassung

Die native Local-Model-Schicht ist sicherheitsseitig ungewöhnlich sauber: signiertes Manifest, Hash-gebundene Readiness, Scope-Eigentum am Prozess, Loopback-Bindung mit Listener-Ownership-Prüfung, per-Prozess-API-Key als Datei, `env_clear` mit minimalem Environment, unveränderliche Read-Guards auf GGUF und Runtime. Diese Eigenschaften sollten bei jeder Optimierung erhalten bleiben.

Der Preis dafür ist derzeit Latenz an drei Stellen:

1. **Prompt-Cache ist vollständig deaktiviert** – jeder Chat-Turn prefillt die komplette Konversation neu.
2. **Jeder Prozessstart hasht 17,7 GB erneut** – auch wenn dieselben, gegen Schreibzugriff gesperrten Handles bereits offen sind.
3. **Ein Projekt- oder Repowechsel beendet den Prozess** – der Scope-Digest enthält `projectId`/`repoId`, also folgt ein vollständiger Kaltstart.

Dazu kommen kleinere, klar lokalisierte Hebel im Streaming-Hotpath des Renderers und im Release-Build.

---

## 2. Analyse der Tauri-App

### 2.1 Aufbau

| Ebene | Stand |
| --- | --- |
| Shell | Tauri 2.9.3, `de.luczor.desktop`, Single-Instance, Tray, Global-Hotkey `CmdOrCtrl+Alt+Space` |
| Native | ~33.900 Zeilen Rust in 51 Modulen, davon 13.158 Zeilen in 16 `local_model*`-Modulen |
| Frontend | Vue 3.5 / TypeScript / Vite 7, 173 Vitest-Dateien, `src/services` ~2,0 MB, `src/App.vue` ~108 KB |
| Fenster | `main`, `luczor-mini`, `luczor-system-status`, `luczor-browser` – je mit eigener Capability |
| IPC | 100+ registrierte Kommandos in `lib.rs` |

Die Capability-Trennung ist korrekt geschnitten: Mini-Chat und Systemstatus bekommen nur Event- bzw. Client-Permissions, das Browser-Webview bekommt ausschließlich `browser-report`. Modell- und Toolausführung bleiben im Haupt-Webview; `ensure_main_webview()` schützt die sensiblen Kommandos zusätzlich zur Laufzeit.

`build.rs` bildet einen SHA-256-Fingerprint über `src/`, `permissions/`, `capabilities/`, `Cargo.toml`, `Cargo.lock`, `build.rs` und `tauri.conf.json` und bindet Testevidenz daran. Das ist ein starkes Mittel gegen „Test war grün, Code war ein anderer".

### 2.2 Befunde Build und Konfiguration

**B-1 Release-Profil optimiert global auf Größe.** `src-tauri/Cargo.toml` setzt `opt-level = "s"` für das gesamte Release-Profil. Für `sha2` ist bereits eine Ausnahme mit `opt-level = 3` definiert – dieselbe Begründung gilt aber für weitere CPU-gebundene Abhängigkeiten im Produktpfad: `tree-sitter*` (Repository-Index), `rusqlite` (FTS5), `regex`, `image`, `zip`.

**B-2 Kein Updater konfiguriert.** `tauri.conf.json` enthält keinen `plugins.updater`-Block, `bundle.targets` steht auf `"all"`. Das deckt sich mit den offenen Punkten P0.3 und P0.6 im `SOLL-Zustand.md`, ist aber die konkrete Fundstelle: ohne Updater-Konfiguration und Signaturschlüssel gibt es keinen Update-/Rollbackpfad.

**B-3 CSP erlaubt breiten Loopback-Zugriff.** `connect-src` enthält `http://localhost:*`, `http://127.0.0.1:*`, `https://…` und `ws(s)://…` für beide Loopback-Formen. Der Renderer spricht die lokale Runtime jedoch nie direkt an – der gesamte Modellverkehr läuft über IPC und `reqwest` im nativen Teil. Die Loopback-Einträge sind damit im Release vermutlich nur für den Vite-Dev-Server nötig.

**B-4 `App.vue` als Sammelpunkt.** ~108 KB Single-File-Component. Dort sitzt auch der in `README.md`/`IST-Zustand.md` benannte offene P0-Egress-Punkt (dieselbe `baseMessages`-Liste wird als `externalBaseMessages` weitergereicht). Die Turn-Orchestrierung aus `App.vue` herauszulösen ist damit zugleich Architektur- und Sicherheitsarbeit.

---

## 3. Analyse der lokalen LLM-Bereitstellung

### 3.1 Kette bis zum laufenden Prozess

1. **Manifest** – Laravel signiert Katalog/Routing; `verify_envelope_with_trust` prüft RSA-Signatur, Key-ID, Trust-Domain, Monotonie der Versionen, Ablaufzeitpunkt.
2. **Akzeptanz** – `local_model_begin_manifest_acceptance` bindet eine Session-ID und Generation; Reload oder Katalogwechsel retiriert ältere Sessions und invalidiert laufende Requests.
3. **Artefakte** – `verify_configured_artifacts` (local_model.rs:2280) öffnet GGUF und `llama-server.exe` mit `FILE_SHARE_READ` (Windows) bzw. als Linux-Bundle, prüft Größe gegen Manifest und hasht beide Dateien vollständig mit SHA-256, abbrechbar (local_model.rs:4298).
4. **Capacity** – `validate_capacity` prüft Gesamt-/freies RAM gegen die signierte Policy; Storage über `ensure_model_storage` inkl. Storage-Class und Removable-Ausschluss.
5. **Acceleration** – `choose_acceleration` (local_model_gpu.rs:191) startet den Runtime-Binary zweimal als Probe (`--help`, `--list-devices`), gleicht Gerätebudgets konservativ gegen NVML ab und wählt `--n-gpu-layers`, ggf. `--split-mode layer` und `--tensor-split`.
6. **Ressourcenplan** – `plan_resources_configured` (local_model_resources.rs:214) leitet Threads, `--threads-batch`, `--batch-size`, `--ubatch-size`, Loadmode (`mmap` / `--load-mode none` / `--no-mmap`), `--poll 0`, `--threads-http 2` aus realer Hardware ab. Drei Profile: `memory_saving` (128/32), `balanced` (512/128), `throughput` (1024/256).
7. **Start** – `start_runtime_attempt` (local_model.rs:3244) reserviert einen Loopback-Port, erzeugt einen UUID-API-Key als private Datei, startet mit `env_clear` plus minimalem Environment, Job-Object-Lifetime-Guard, `stderr` in einen Startup-Monitor.
8. **Health** – `await_health` pollt alle 200 ms `/health` und verifiziert bei jedem Durchlauf über die TCP-Tabelle, dass der Listener dem eigenen Kindprozess gehört.
9. **Benchmark** – `run_signed_benchmark` muss die signierten Schwellen für TTFT, Prefill- und Decode-Durchsatz erfüllen, bevor ein Nutzerrequest zugelassen wird.
10. **Readiness** – 10-Minuten-Lease, gebunden an Manifest-Hash, Artefakt-Hash, Runtime-Hash und Resource-Revision. `refresh_resident_runtime` erneuert die Lease am laufenden Prozess, ohne 17 GB neu zu laden – das ist bereits korrekt gelöst.

### 3.2 Feste Startargumente

```
--model <gguf> --alias <id> --host 127.0.0.1 --port <reserviert>
--api-key-file <datei> --no-webui --jinja --parallel 1
--ctx-size <manifest> --no-cache-prompt
+ Acceleration-Argumente + Ressourcenplan-Argumente
```

Nicht gesetzt und im gesamten Code nicht vorhanden: `--flash-attn`, `--cache-type-k`, `--cache-type-v`, `--cont-batching`, `--mlock`, `--defrag-thold`, `--keep`.

### 3.3 Betriebsweise zur Laufzeit

- **Ein Prozess, ein Scope.** `RuntimeScope::Prepared` → `Bound(digest)` beim ersten echten Request. `ManagedRuntime::reuse` gibt nur `true` zurück, wenn Modell-ID, Resource-Revision, Kontextgröße **und** Scope-Digest passen.
- **Scope-Digest** (coordinator.ts:1257) = `principalId + deviceId + serverInstance + desktopSessionId + projectId + repoId`.
- **Kontextwachstum** – reicht der Kontext nicht, berechnet `context_budget::growth_target` ein größeres Fenster bis zum signierten Maximum und ruft `ensure_runtime` erneut auf, was einen neuen Prozess bedeutet.
- **Streaming** – `generation_stream::Stream` mit drei Deadlines (erstes Token aus der signierten TTFT-Schwelle × 10, Idle 60 s, gesamt 30 min), 32-KB-Chunking, 128-MB-Obergrenze.
- **Idle-Arbeit** – `use_case = "context.optimize"` läuft über einen separaten, jederzeit abbrechbaren HTTP-Pfad (`local_model_idle.rs`), der beim Abbruch nachweislich den Socket schließt. Gut getestet.
- **Thinking-Budget** – `reasoning_budget` mit Live-Kontrolle (`more` / `answer`), `reasoning_content` verlässt den nativen Teil nie.

---

## 4. Optimierungsoptionen

Bewertung: **Wirkung** = erwarteter Effekt auf wahrgenommene Latenz/Durchsatz. **Aufwand** = Entwicklungsaufwand inkl. Tests. **Risiko** = Auswirkung auf die bestehenden Sicherheitszusagen.

### Klasse A – Inferenzlatenz (größte Hebel)

**A-1 Prompt-Cache aktivieren.** *Wirkung hoch · Aufwand mittel · Risiko mittel, beherrschbar*

Fundstelle: `--no-cache-prompt` (local_model.rs:3329) und `"cache_prompt": false` im Request-Body (local_model.rs ~3673), kommentiert mit „Keep model weights resident while each request supplies its entire conversation".

Konsequenz heute: Jeder Turn prefillt die gesamte Historie neu. Bei 8.192 Kontexttokens und den gemessenen 351–731 Prompt-Token/s sind das 11–23 s reiner Prefill pro Turn, wachsend mit der Konversationslänge – und zwar **vor** dem ersten sichtbaren Token.

Das Sicherheitsargument gegen Prompt-Caching ist ein KV-Cache-Rest über Scope-Grenzen hinweg. Genau das ist hier aber bereits anders abgesichert: Ein Prozess gehört exakt einem `RuntimeScope::Bound(digest)`, und bei jedem Scope-Wechsel wird der Prozess heute ohnehin beendet. Ein slotgebundener KV-Cache verlässt den Scope damit strukturell nicht.

Vorgehen:
- `cache_prompt: true` und `--no-cache-prompt` entfernen, **gebunden an** `RuntimeScope::Bound`. Solange `Prepared` (also Benchmark/Prepare ohne privaten Scope), weiter ohne Cache.
- Beim Scope-Wechsel explizit `POST /slots/{id}?action=erase` vor der Freigabe, damit auch bei einem späteren Prozess-Reuse (A-4/B-1) kein Rest bleibt.
- Negativtest ins Releasegate: Konversation A, Scope-Wechsel, Konversation B – die Runtime darf für B keinen Prefill-Treffer aus A zeigen (`timings.prompt_n` bzw. `cache_n` aus der Response prüfen).

Erwartung: TTFT bei Folgeturns von zweistelligen Sekunden auf den Bereich des Decode-Starts.

**A-2 Flash-Attention und KV-Cache-Quantisierung prüfen.** *Wirkung hoch · Aufwand niedrig · Risiko niedrig*

`--flash-attn` und `--cache-type-k/-v q8_0` kommen im Code nicht vor. Bei einem 27B-Q4_K_M-Modell mit 8.192 Kontext spart Q8-KV rund die Hälfte des KV-Speichers und schafft Raum für mehr Offload-Layer oder ein größeres Fenster; Flash-Attention erhöht den Prefill-Durchsatz spürbar.

Das Muster für die Kapazitätsprüfung existiert bereits: `RuntimeOptions::from_help` (local_model_resources.rs:120) parst die `--help`-Ausgabe des gepinnten Builds. Neue Flags dort ergänzen und nur setzen, wenn der verifizierte Build sie kennt – damit bleibt die Bindung an den signierten Runtime-Hash intakt.

Vor Aktivierung: Qualitätsvergleich gegen den unquantisierten KV-Cache im Rahmen von P0.2. Q8 ist konservativ, Q4-KV nicht.

**A-3 Artefakt-Hash an das offene Handle binden.** *Wirkung hoch · Aufwand mittel · Risiko niedrig*

`verify_configured_artifacts` liest und hasht bei **jedem** `start_runtime` 17,7 GB neu (local_model.rs:2317). Der 139.335 ms lange E2E-Lauf vom 2026-09-06 enthält diesen Anteil ausdrücklich.

Die Datei ist zu diesem Zeitpunkt aber bereits über `open_artifact_guard` gegen Schreibzugriff gesperrt, und dieses Handle lebt für die gesamte Runtime-Laufzeit weiter. Ein zweites Hashing derselben, durchgehend gesperrten Datei liefert per Konstruktion dasselbe Ergebnis.

Vorgehen: Hash-Ergebnis in einem prozessweiten Cache halten, verschlüsselt über Pfad + Größe + `mtime` + Volume-/File-ID (Windows: `BY_HANDLE_FILE_INFORMATION`; Linux: `dev`+`ino`) **und** einem noch offenen Guard-Handle. Cache-Eintrag verfällt, sobald der Guard fällt. Das verändert die Sicherheitszusage nicht: Der Beleg hängt weiterhin am selben, gegen Schreibzugriff gesperrten Handle.

Erwartung: Warmstart und Kontextwachstum sparen je nach Datenträger 10–60 s.

**A-4 Kontextwachstum ohne Prozessneustart.** *Wirkung mittel · Aufwand mittel · Risiko niedrig*

`stream_completion` startet bei Kontextmangel über `ensure_runtime` einen neuen Prozess mit größerem `--ctx-size` und wiederholt anschließend den signierten Benchmark.

Zwei Varianten:
- **Einfach:** direkt mit dem signierten `runtime.max_context_tokens` starten statt mit `context_limit` und zu wachsen. Kostet mehr KV-Speicher beim Start – zusammen mit A-2 ist das aber meist neutral.
- **Sauber:** Kontextgröße als Eigenschaft des Ressourcenplans behandeln und beim Wachstum nur dann neu starten, wenn A-3 den Hash-Anteil bereits eingespart hat.

**A-5 Tokenizer-Round-Trips reduzieren.** *Wirkung mittel · Aufwand niedrig · Risiko keins*

`context_budget::fit_adaptive_context_with_ingress` ruft pro Kandidat `/v1/chat/completions/input_tokens` auf und serialisiert dafür jedes Mal die vollständige Konversation (local_model.rs ~3690–3740). Mit dem 60-Sekunden-Timeout als Schutz sind mehrere Durchläufe eingeplant.

Option: konservative lokale Vorabschätzung (Bytes → Tokens mit Sicherheitsfaktor) zur Kandidatenauswahl und nur **eine** serverseitige Verifikation des finalen Kandidaten. Die Zusage „gemessen, nicht geschätzt" bleibt erhalten, weil die finale Entscheidung weiterhin auf der echten Tokenizermessung beruht.

**A-6 Zweiter Slot für Hintergrundarbeit.** *Wirkung mittel · Aufwand mittel · Risiko niedrig*

`--parallel 1` bedeutet: Hauptchat, Mini-Chat und Idle-Context-Optimierung serialisieren auf einem Slot. Die Idle-Arbeit ist bereits sauber preemptibel gebaut, blockiert aber trotzdem.

Option: `--parallel 2 --cont-batching`, Idle-Arbeit fest auf Slot 2. Zu beachten: `--ctx-size` wird in llama.cpp auf die Slots aufgeteilt – entweder `--ctx-size` verdoppeln (KV-Speicher, siehe A-2) oder den Idle-Slot bewusst klein halten. Der Scope bleibt unverändert, da beide Slots zum selben Prozess und damit zum selben Scope gehören.

### Klasse B – Start- und Wechselkosten

**B-1 Scope-Wechsel ohne Prozesstod.** *Wirkung hoch · Aufwand mittel · Risiko mittel*

Der Scope-Digest enthält `projectId` und `repoId` (coordinator.ts:1257). Jeder Projektwechsel im UI erzwingt damit heute `stop()` und einen vollständigen Kaltstart inklusive Re-Hashing (A-3) und Benchmark.

Option: Beim Scope-Wechsel den Prozess behalten und stattdessen den Zustand explizit löschen – alle Slots `erase`, Scope am `ManagedRuntime` neu binden, Readiness neu ausstellen. Voraussetzung ist A-1s Erase-Pfad; ohne aktivierten Prompt-Cache ist der Prozess ohnehin zustandslos, dann genügt das Neubinden des Scopes.

Das ist zusammen mit A-1 der größte spürbare UX-Hebel. Es braucht ein eigenes Negativtestpaket (Scope-Wechsel unter laufendem Request, Reload während des Wechsels, zwei Projekte im Wechsel).

**B-2 Runtime-Proben cachen.** *Wirkung niedrig · Aufwand niedrig · Risiko keins*

`choose_acceleration` startet den Runtime-Binary pro Kaltstart zweimal (`--help`, `--list-devices`). Die `--help`-Ausgabe ist für einen per Hash gepinnten Build invariant und kann am Runtime-SHA-256 gecacht werden. `--list-devices` bleibt dynamisch, verträgt aber einen kurzen Cache (z. B. 60 s), weil die Gerätebudgets ohnehin konservativ gegen NVML korrigiert werden.

**B-3 Portreservierung schließt das Zeitfenster nicht.** *Wirkung niedrig · Aufwand niedrig · Risiko keins*

`reserve_loopback_port` (local_model.rs:4391) bindet `127.0.0.1:0`, liest den Port aus und schließt den Listener sofort. Zwischen Freigabe und dem späteren `bind` durch `llama-server.exe` liegt ein Zeitfenster, in dem ein fremder Prozess den Port belegen kann. Der Fehler wird durch die Ownership-Prüfung sicher erkannt – der Start scheitert dann aber, statt auszuweichen.

Option: mehrere Kandidatenports reservieren und bei Kollision ohne Nutzerfehler retryen.

**B-4 TCP-Tabelle nicht pro Request enumerieren.** *Wirkung niedrig · Aufwand niedrig · Risiko niedrig*

`loopback_listener_owned_by` (local_model.rs:4417) liest über `netstat2` die vollständige TCP-Tabelle – im Health-Wait alle 200 ms und zusätzlich bei **jedem** `verified_runtime_endpoint`, also pro Request. Auf Systemen mit vielen Sockets kostet das messbar.

Option: Ergebnis mit kurzer TTL (≈1 s) an PID + Port cachen; die Sicherheitswirkung bleibt, weil ein Portwechsel immer einen neuen Prozess bedeutet.

### Klasse C – Renderer- und IPC-Hotpath

**C-1 Quadratische Stream-Verarbeitung.** *Wirkung mittel · Aufwand niedrig · Risiko keins*

Der native Teil sendet **pro Token** ein `Delta`-Event mit nur dem neuen Chunk (korrekt). Im Renderer passiert dann dreimal Gesamttextarbeit pro Token:

- `tauriLocalRuntime.ts:264` – `observation.delta(accumulated)` mit dem kompletten String
- `tauriLocalRuntime.ts:265` – `request.onToken?.(accumulated)`
- `localModelManager.ts:388` – `visibleLocalContent(accumulated)`, das `stripReasoningBlocks` mit `matchAll` über den **gesamten** akkumulierten Text laufen lässt

Bei einer 4.000-Token-Antwort sind das 4.000 Regex-Durchläufe über einen wachsenden String, plus Vue-Patch und Markdown-Neurendering je Token.

Option: inkrementeller Streaming-Parser mit Zustand (offene Tag-Liste + Tail-Puffer für abgeschnittene Marker), der nur den neuen Chunk verarbeitet und den sichtbaren Text fortschreibt. Die Sicherheitseigenschaft (kein `<think>`-Leck, kein Flackern von `<thi`) ist mit Zustand sogar einfacher korrekt zu halten als durch wiederholtes Neuparsen.

**C-2 Delta-Events koaleszieren.** *Wirkung niedrig · Aufwand niedrig · Risiko keins*

Ein IPC-Event mit JSON-Serialisierung pro Token. Ein Fenster von 30–50 ms oder ≥16 Zeichen im nativen Teil reduziert die Eventzahl um etwa eine Größenordnung, ohne dass der Stream stockend wirkt.

**C-3 `App.vue` entflechten.** *Wirkung indirekt · Aufwand hoch · Risiko niedrig*

Die Turn-Orchestrierung aus der ~108-KB-Komponente in ein eigenes Modul zu ziehen, ist die Voraussetzung dafür, den bereits unit-getesteten Context Broker im aktiven Chatpfad zu verdrahten (offener P0-Egress-Punkt). Performance ist hier der Nebeneffekt, nicht der Hauptgrund.

### Klasse D – Build, Release, Betrieb

**D-1 Release-Profil differenzieren.** *Wirkung mittel · Aufwand niedrig · Risiko keins*

Die für `sha2` bereits getroffene Ausnahme (`opt-level = 3`) auf die übrigen CPU-gebundenen Abhängigkeiten ausdehnen: `tree-sitter`, `tree-sitter-*`, `rusqlite`, `regex`, `image`, `zip`. Alternative: `opt-level = 3` als Profilstandard und `"s"` nur dort, wo Binärgröße wirklich zählt.

**D-2 Update- und Rollbackpfad schließen.** *Wirkung hoch für Betrieb · Aufwand hoch · Risiko keins*

Kein `plugins.updater` in `tauri.conf.json`, kein Signaturschlüssel. Das ist die konkrete technische Lücke hinter P0.3/P0.6. Zusammen zu klären: Code-Signing, Installerprüfung, Rollback auf den letzten freigegebenen Runtime-/Modellstand, Quarantäne fehlgeschlagener Artefakte.

**D-3 CSP im Release verengen.** *Wirkung sicherheitsseitig · Aufwand niedrig · Risiko niedrig*

`connect-src` erlaubt beliebige Loopback-Ports über http/https/ws/wss. Da der Renderer die lokale Runtime ausschließlich über IPC erreicht, kann eine Release-Variante der CSP diese Einträge weglassen. Damit kann eine kompromittierte Renderer-Seite keine lokal lauschenden Dienste mehr direkt ansprechen.

**D-4 Idle-Verhalten definieren.** *Wirkung mittel · Aufwand mittel · Risiko niedrig*

Im nativen Manager ist kein Idle-Timeout erkennbar: Der Prozess bleibt resident bis `stop`, App-Exit oder Scope-Wechsel. 17,7 GB VRAM/RAM bleiben also dauerhaft belegt, auch wenn stundenlang kein Chat stattfindet.

Option: konfigurierbarer Idle-Timeout (Vorschlag: 30 min ohne Request) mit sauberem `stop()` und danach explizit ausgewiesenem Kaltstart. Die vorhandene `local_model_recover_memory`-Mechanik (`K32EmptyWorkingSet`, 60-Sekunden-Drossel) deckt nur das Working Set des Tauri-Prozesses ab, nicht die Runtime.

**D-5 `--mlock` als Option prüfen.** *Wirkung niedrig–mittel · Aufwand niedrig · Risiko mittel*

Bei CPU- oder Hybridbetrieb mit mmap kann das OS Modellseiten auslagern, was zu unregelmäßigen Decode-Einbrüchen führt. `--mlock` verhindert das, ist bei knappem RAM aber gefährlich. Die vorhandene `StartupMemoryGuard`-Logik liefert bereits die Messgrundlage, um den Schalter nur bei ausreichendem Headroom zu setzen.

### Klasse E – Messbarkeit (Voraussetzung für A–D)

**E-1 Vergleichbare Benchmarks herstellen.** *Wirkung Voraussetzung · Aufwand mittel · Risiko keins*

Die vorliegenden Zahlen stammen aus zwei verschiedenen Kontextprofilen (Preflight 2026-09-05 mit 4.096 Tokens: 351,33 Prompt-Tok/s, 27,77 Decode-Tok/s; Capacity-Benchmark: 730,82 / 31,44) und sind untereinander nicht vergleichbar. Der E2E-Wert von 139.335 ms mischt Hashing, Scope- und Prozessvorbereitung mit der eigentlichen Inferenz.

Ohne ein fixes Harness lässt sich für keine der Optionen A-1 bis A-6 ein Gewinn belegen. Mindestumfang:

- getrennt ausgewiesen: Kaltstart (Hash + Load + Benchmark), Warmstart, Prefill, TTFT, Decode
- fixe Historienlängen (z. B. 500 / 2.000 / 6.000 Tokens) statt eines Einzelprompts
- jeweils drei Läufe, Median, mit Host-Zustand im Report
- gleicher Kontextwert über alle Läufe

Das ist zugleich der Unterbau für P0.2 (OrcaRouter als Releasekandidat) und P1.1 (eigene Evaluationsstrategie).

---

## 5. Vorgeschlagene Reihenfolge

| Schritt | Inhalt | Begründung |
| --- | --- | --- |
| 1 | E-1 Benchmark-Harness | ohne Baseline ist jede weitere Aussage unbelegt |
| 2 | A-3 Hash-Cache am Handle | größter Einzelposten im Kaltstart, geringes Risiko |
| 3 | A-2 Flash-Attention + KV-Q8 (kapazitätsgeprüft) | kleiner Eingriff, messbarer Durchsatz |
| 4 | A-1 Prompt-Cache scope-gebunden + Erase-Pfad | größter Latenzhebel, braucht Negativtests |
| 5 | B-1 Scope-Wechsel ohne Prozesstod | baut direkt auf 4 auf |
| 6 | C-1 / C-2 Streaming-Hotpath | isoliert, gut testbar |
| 7 | A-5, B-2, B-3, B-4, D-1 | kleine Hebel, sammelbar in einem Durchgang |
| 8 | D-4 Idle-Timeout, A-6 zweiter Slot | Betriebsverhalten, nach stabiler Baseline |
| 9 | D-2 Updater/Rollback, D-3 CSP | Releasearbeit nach P0.3/P0.6 |

---

## 6. Was nicht angetastet werden sollte

Diese Eigenschaften tragen das Sicherheitsmodell und sollten jede Optimierung überleben:

- Fail-closed-Standardkatalog ohne ausführbare Artefaktmetadaten
- Signaturprüfung, Trust-Domain, Versionsmonotonie, Akzeptanzsession und Generation
- Bindung der Readiness an Manifest-, Artefakt- und Runtime-Hash sowie Resource-Revision
- unveränderliche Read-Guards auf GGUF und Runtime über die gesamte Prozesslaufzeit
- ein Prozess gehört genau einem Scope; Reload und Katalogwechsel invalidieren laufende Requests
- Loopback-Bindung, per-Prozess-API-Key als private Datei, Listener-Ownership-Prüfung
- `env_clear` mit minimalem Environment und Job-Object-Lifetime-Guard
- `reasoning_content` verlässt den nativen Teil nicht
- kein stiller externer Fallback nach lokalem Fehler
