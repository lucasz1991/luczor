# Luczor Mini: gemeinsamer Projektchat und Workspace

## Ergebnis

- Native Mini-Webview und Browser-Overlay verwenden die Oberflaechen, Schrift, Akzentfarbe, Nachrichten und Freigaben des grossen Chats. Die bestehende Live-Status-Kreisanimation bleibt mit echten Laufzeitphasen verbunden.
- **Projektchat** zeigt den vorhandenen Verlauf des ausgewaehlten Projekts. Eingaben laufen durch dieselbe `App.send`-Funktion; Projektwahl, Stream, Stop und Freigaben teilen sich die Hauptlaufzeit. Ein ungesendeter Entwurf im Hauptfenster bleibt erhalten.
- **Workspace** ist ein eigener fluechtiger, lokal verarbeiteter Verwaltungsdialog. Projekt- und Chatuebersicht, Projektmetadaten sowie vorbereitete Code-Agentenauftraege mit Status/Abbruch sind explizite Werkzeuge. Codeauftraege werden zur bestehenden manuellen Pruefung vorbereitet, nicht automatisch gestartet.
- Datei- und Desktopwerkzeuge behalten das ausgewaehlte Arbeitsprojekt und die bestehenden Freigaberegeln. Schaltflaechen oeffnen Projektordner, Agentenverwaltung oder Desktop-Einstellungen im Hauptfenster.
- Der vorhandene Datenvertrag besitzt einen Chatverlauf pro Projekt. Es wurde kein zweites Chatschema eingefuehrt. Workspace leeren beruehrt den Projektchat nicht.

## Technische Grenzen

- `main` besitzt weiterhin die einzige Modell-, Mikrofon-, Store- und Agentenlaufzeit. Die Mini-Webview bekommt nur begrenzte Abbilder und sendet typisierte Aktionen.
- Jede Ansicht und jeder Projektkontext hat eine neue Aktionskennung. Verspaetete Aktionen koennen keinen Auftrag in einem inzwischen anderen Projekt starten. Ein gemeinsamer Start-/Laufzeit-Lock verhindert parallele Agentenlaeufe.
- Workspace-Werkzeuge sind nur fuer die lokale Modellroute sichtbar und ausfuehrbar. Der Host fixiert Principal und erlaubte Projekt-IDs; jeder Aufruf prueft Identitaet, Ausfuehrungsticket und Zielprojekt erneut. Externe Modellrouten werden vor Uebermittlung des Workspace-Verlaufs abgewiesen.
- Nachrichten, Kommentare, Aktivitaeten und Werkzeuge sind pro Feld und als Gesamt-Abbild begrenzt. Private/verborgene Nachrichten gelangen nicht in den Projektchat-Abzug.
- Ein ResizeObserver haelt das Browser-Overlay nach Groessenaenderungen innerhalb des sichtbaren Fensters. Bei offenen Entscheidungen schaffen ausgeblendete gesperrte Projekt-/Shortcut-Bereiche Platz fuer Freigabe, Eingabe und Not-Aus.

## Pruefung

- Gesamtsuite: **1066 Tests in 100 Dateien bestanden**. Der parallele Chat-Agenten-Werkstrom bestaetigte dieselbe Suite nochmals im final eingefrorenen Stand.
- Node **22.22.0**, kanonischer Typecheck (`vue-tsc --build --force`), ESLint und vollstaendige Prettier-Pruefung bestanden im gemeinsamen finalen Stand.
- Rust durch den koordinierten Desktop-Werkstrom: **122 Tests bestanden, 1 interaktiver Test ignoriert**, Format und Clippy ohne Befund. Die neuen Mini-Aktionsvertraege waren zusaetzlich mit sieben gezielten Rusttests und Cargo Check geprueft.
- Browser: beide Ansichten in der integrierten App sichtbar; gemeinsame synthetische Nachricht und Antwort in Hauptchat/Mini, Projektauswahl, Workspace-Freigabe und Auswahlantworten geprueft. Panel, Freigabe, Composer und Not-Aus bei **420 x 660** sichtbar. Temporaere Viewportvorgabe anschliessend zurueckgesetzt.
- Die Fixture `tests/fixtures/mini-chat.html` kennzeichnet ihre Daten ausdruecklich als synthetisch und ruft kein Modell, Mikrofon oder echtes Werkzeug auf.
- Gemeinsames natives Release-Artefakt ohne Bundle: `src-tauri/target/release/tauri-app.exe`, Version 2.9.3, 14.585.856 Bytes, Dateizeit 2026-09-06T22:54:07.934Z, SHA-256 `96109C1BB7FEB1CFA8ACE0D7F9B9F2E63859243418F36FF07F1C6D8B0484ADDF`. Der koordinierte Desktop-Werkstrom erstellt den Build mit normaler Desktop-Identitaet. Artefakt und Hash direkt nachgeprueft; alle 20 protokollierten Quelldateihashes sind nach Freeze unveraendert. Die laufende Debug-App wird weder gestoppt noch ersetzt.

## Abgrenzung und Handoff

- Der koordinierte Release-Build wurde mit Exitcode 0 abgeschlossen (4m05s). Peer-Abschlussnachweis: `E:/projekte/luczor/.lmzdev/artifacts/reports/2026-09-07-chat-agent-tool-limits-build.json`. Die normale Desktop-Identitaet bleibt `de.luczor.desktop`.

- Keine interaktive native Windows-Abnahme von Always-on-top, Hauptfenster-Minimierung, echtem Modell, Mikrofon oder Desktopaktionen in diesem Arbeitsschritt. Browserpruefung und Kompilierung belegen diese Funktionen nicht.
- Kein Installer, Deployment, Commit oder Reset. Vorbestehende und parallele Chat-/Streaming-/Tool-Limit-Aenderungen wurden erhalten. Ausgangsdiff und Dateihashes liegen in `artifacts/temp/mini-workspace/`.
- Hauptdateien: `src/components/mini/`, `src/styles/mini-chat.css`, `src/composables/useMiniChatHost.ts`, `src/services/miniChat/`, `src/services/tools/workspace.ts`, additive Integration in `src/App.vue`, `src/services/agent.ts`, Tooltypen/Registry und `src-tauri/src/commands/mini_chat.rs`.
- Bedienung und aktuelle Architektur: `docs/mini-chat.md`.
