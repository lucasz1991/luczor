# Beautiful UI in Luczor

Die Tauri-App verwendet eine Vue-3-Adaption von
[Beautiful UI](https://www.beautifului.dev/). Die Originale stammen aus Revision
`06557d7ff33a1eb70d5987bae9ac4c70fa0e20c4` und liegen zusammen mit der vollständigen
MIT-Lizenz unter `vendor/beautiful-ui/`. Die tatsächlichen App-Komponenten liegen
unter `src/components/ai/` und benötigen keine zusätzlichen Laufzeitpakete.

## Öffnen

In der linken Navigation **UI-Bibliothek** öffnen. Die Chat-Vorschau zeigt einen
ausdrücklich als Beispiel gekennzeichneten Ablauf; **Ablauf abspielen** demonstriert
Loader, Schritte, Tool-Chips, Textausgabe und Stoppen. **Alle 21 Komponenten** zeigt
den vollständigen Katalog mit Suche und bedienbaren Vorschauen.

Die echte Chatoberfläche verwendet die vorhandenen Projekt-, Modell-, Tool-,
Freigabe-, Memory- und Sprachfunktionen. Die Bibliothek ruft weder ein Modell noch
native Werkzeuge auf und schreibt keine Beispielwerte in den Projektzustand.

## Komponenten und Einbindung

| Beautiful UI        | Vue-Komponente           | Verwendung                                                                         |
| ------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| Loading State       | `LoadingState.vue`       | Laufzeit und Pixelraster im echten Chatstatus; drei Varianten                      |
| Thinking            | `ThinkingState.vue`      | Aufklappbare Modellrunden und Arbeitsschritte pro Antwort                          |
| Streaming Text      | `StreamingText.vue`      | Rich Text, Code, Kopieren, Vorlesen und Folgefragen im Chat                        |
| Approval Card       | `ApprovalCard.vue`       | Vorhandene Tool-Freigaben mit expliziter einmaliger Entscheidung                   |
| Tool Chips          | `ToolChips.vue`          | Tatsächliche Tool-Aufrufe im jeweiligen Nachrichtenzeitraum                        |
| Task Rows           | `TaskRows.vue`           | Agentenplan in `PlanPanel.vue`; Liste und Kapseln                                  |
| Chat                | `ChatComposer.vue`       | Chatfläche mit Scrollverfolgung, Sprung zur neuesten Nachricht und optionalen Tabs |
| Prompt Bar          | `PromptBar.vue`          | Echte Eingabe, Projektkontext, Aktionen, Modelleinstellungen, Mikrofon und Stoppen |
| Recommendation Card | `RecommendationCard.vue` | Memory-Kandidaten mit bestehenden Übernehmen-/Verwerfen-Funktionen                 |
| Context Cards       | `ContextCards.vue`       | Bestehende Projektzusammenfassungen im Kontextbereich                              |
| Diff Table          | `DiffTable.vue`          | Wiederverwendbare Auswahl vorgeschlagener Änderungen; interaktive Bibliothek       |
| Records Table       | `RecordsTable.vue`       | Generische sortierbare Tabelle; interaktive Bibliothek                             |
| Filter Table        | `FilterTable.vue`        | Statusfilter für generische Datensätze; interaktive Bibliothek                     |
| Sidebar Nav         | `SidebarNav.vue`         | Echte Projektliste, Suche, Einklappen, Systemstatus und Einstellungen              |
| Search              | `SearchList.vue`         | Aktionssuche in der Eingabeleiste, einschließlich Tastaturbedienung                |
| Flowchart           | `Flowchart.vue`          | Generische Statusschritte mit Details; interaktive Bibliothek                      |
| Insight Cards       | `InsightCards.vue`       | Generische Einblicke mit Kurven und Navigation; interaktive Bibliothek             |
| Code Block          | `CodeBlock.vue`          | Code und Unified Diffs in Chatantworten mit Zeilennummern und Kopieren             |
| Fine-tune Card      | `FineTuneCard.vue`       | Gebundene Werte für Radius, Schriftgröße und Abstand; interaktive Bibliothek       |
| Selection Actions   | `SelectionActions.vue`   | Markierten Antworttext als neuen bearbeitbaren Auftrag vorbereiten                 |
| Agent Screen        | `AgentScreen.vue`        | Slot/Bild für eine vorhandene Ansicht; leer ohne echte Bildschirmquelle            |

Alle Datenkomponenten erhalten Werte über Props und geben Aktionen über typisierte
Vue-Events zurück. Für Funktionen ohne bestehenden Luczor-Datenvertrag stellt die
Bibliothek die Komponenten bereit, ohne Live-Daten, Werkzeugausführungen,
Bildschirmzugriff oder Erfolgsmetriken vorzutäuschen.

## Streaming und Denkstatus

`runAgent()` meldet zusätzlich zu seiner bestehenden Antwortschnittstelle
`onProgress`-Ereignisse: Routing, Modellrunde, Anzahl empfangener Zeichen und
Tool-Verarbeitung. Darin befinden sich keine Modelltexte, Arbeitsnotizen,
Tool-Argumente oder Ergebnisse. `chatActivity.ts` verwaltet diese Ereignisse pro
Antwort ausschließlich im lokalen flüchtigen UI-Zustand. Sie werden nicht als
Memory gespeichert oder synchronisiert.

Die vorhandene Ausgabekontrolle bleibt aktiv: Modelltext einer Tool-Runde sowie
erkannte interne Arbeitsnotizen werden zurückgehalten. Sichtbarer Antworttext wird
erst nach Freigabe der finalen Runde über `onToken` an die Oberfläche gegeben.
`useStreamReveal` zeigt diesen bereits freigegebenen Text schrittweise an. Das ist
eine Darstellung nach der Ausgabeprüfung, kein ungefiltertes Token-Streaming des
Providers. Die numerische Empfangsanzeige ist bereits während des echten Streams
aktiv. **Sofort anzeigen** überspringt die Darstellungsanimation.

Abbruch und Fehler beenden aktive Statusschritte. Späte Fortschrittsereignisse
können einen abgeschlossenen oder abgebrochenen Ablauf nicht erneut aktivieren.
Toolstatus kommt aus der bestehenden Freigabe-/Ausführungsverwaltung. Rohdaten
bleiben im vorhandenen Tool-Protokoll und in den dafür vorgesehenen Freigaben.

## Bedienung und Darstellung

- Enter sendet, Shift+Enter erzeugt eine neue Zeile; IME-Komposition sendet nicht.
- Die Eingabe bleibt während der Verarbeitung beschreibbar; Stoppen ersetzt Senden.
- Slash-Aktionen füllen einen Auftrag vor oder öffnen bestehende Einstellungen.
- Escape schließt die Aktionssuche, ohne den Entwurf zu löschen.
- Freigaben verhindern doppelte Entscheidungen; keine Komponente umgeht die
  bestehende Modus-, Tool-, Projekt- oder Datenfreigabe.
- Inhalte werden mit Vue-Escaping oder dem vorhandenen `renderRichText` gerendert.
  Externe Markdown-Links behalten den nativen, geprüften `open_url`-Pfad.
- Scrollverfolgung folgt der Antwort nur, solange der Nutzer nahe am Ende bleibt.
- Systemseitig reduzierte Bewegung und Luczors Einstellung werden berücksichtigt.
- Die Bibliothek bietet eine lokale helle/dunkle Vorschau. Das bestehende
  Einstellungssystem und die nativen Sprachfunktionen bleiben die zuständigen
  Laufzeitpfade.

## Lokale Prüfung

Node und pnpm über `scripts/with-pinned-node.ps1` verwenden. Die neuen Tests stehen
in `tests/unit/chatActivity.test.ts` und `tests/unit/aiComponents.test.ts`.
`agentModeAndTools.test.ts` prüft zusätzlich, dass Live-Fortschritt keine internen
Modelltexte offenlegt. Kompilierung und Tests sind keine Bestätigung eines echten
Modell-, Mikrofon- oder produktiven Tool-Laufs.

Prüfstand vom 6. September 2026:

- 48 Vitest-Dateien mit 360 bestandenen Tests; ESLint ohne Befund.
- TypeScript-Prüfung und Vite-Produktionsbuild erfolgreich.
- Nativer Windows-Release-Testbuild mit `--no-bundle` und der vorhandenen
  `tauri.local-test.conf.json` erfolgreich. Ausgabedatei:
  `src-tauri/target/release/tauri-app.exe` (14.118.400 Bytes; SHA-256
  `D90605D52789A32D5AE1C277EA42D62BA9AED04318B98E5A608395208FC12C5D`).
- Browserprüfung: 800 × 600 und 390 × 844 Pixel, normale Fenstergröße,
  helle/dunkle Bibliothek, Komponentenfilter, Tabellenfilter, Clipboard,
  einmalige Freigaben, Vorschau-Stop, Enter/Shift+Enter und Escape.
- Testbuild erstellt, kein Installer ausgeführt und kein Deployment vorgenommen.
  Echter Modellstream, Mikrofon und native Tool-Ausführung wurden in diesem
  UI-Arbeitsschritt nicht interaktiv geprüft.
