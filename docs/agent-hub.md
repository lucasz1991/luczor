# Projektagenten, Codex und Erinnerungsübertragung

Die Seitenleiste öffnet **Agenten & Erinnerungen** für das aktive Luczor-Projekt. Jeder Auftrag enthält den Projektkontext, seine Rolle und eine sichtbare Freigabe. Die vollständige Vorschau wird erst mit **Auftrag starten** ausgeführt. Auch aus dem Chat vorbereitete Aufträge landen hier.

## Agenten auswählen

| Auswahl | Verhalten |
| --- | --- |
| Codex | Installierte Codex-CLI mit bestehender Anmeldung; arbeitet im gebundenen Projektordner. Modell optional aus der CLI-Konfiguration überschreibbar. |
| Eigenes Modell · lokal | Analyse, Planung, Review und Codevorschläge über den vorhandenen signierten lokalen Modellkatalog. Kein Dateischreiben und keine eigenen Werkzeuge. |
| Modellrichtlinie · lokal zuerst | Aufgabenbezogene Auswahl durch die bestehende Luczor-Richtlinie. Externe Inferenz erst nach Vorschau und Freigabe des konkreten Übertragungspakets. |

Lokale Modelle erscheinen erst bereit, wenn der bestehende signierte Modellbetrieb aktiv ist. Diese Erweiterung installiert keine Modelle und schaltet gesperrte Profile nicht frei. Andere Anbieter werden über die konfigurierten Serverprofile verwendet, nicht durch frei eingegebene Zugangsdaten im Agentenfenster.

Codex benötigt einen unter dem Luczor-Projekt gebundenen Ordner. Die Repository-Richtlinie im Projektkontext muss die externe Übergabe erlauben; bei **Verbieten** bleibt der Start gesperrt. Codex kann seinen Anbieter auch bei einem reinen Leseauftrag verwenden. **Im Projekt schreiben** benötigt **Handeln** oder **Vollzugriff** und gilt nur für den einzelnen Auftrag. Codex behält seine eigene Sandbox; eine fehlende Windows-Sandbox kann Schreibaufträge weiter einschränken.

Projektzusammenfassung und offene Ziele gehören zur sichtbaren Vorschau. Freigegebene Nutzer-/Projekterinnerungen werden nur auf Wunsch hinzugefügt. Absolute Ordnerpfade werden im Modellkontext durch den Projektalias ersetzt. Lokale Modellagenten bekommen ausschließlich diesen überprüften Kontext und den Arbeitsauftrag; sie lesen nicht selbstständig den gesamten Ordner.

## Codex-Projektverknüpfung und Desktop

Ein erfolgreich abgeschlossener, von Luczor gestarteter Codex-Auftrag liefert eine echte Sitzungs-ID. Luczor speichert die Verbindung aus Konto, Projekt, kanonischem Ordner, Bindungsstand und Sitzungs-ID ausschließlich lokal. **Verknüpfte Codex-Sitzung fortsetzen** führt weitere Aufträge in derselben Sitzung aus. Ordnerwechsel und Kontowechsel machen alte Zuordnungen unzulässig; fremde IDs können nicht frei zum Fortsetzen eingegeben werden.

**Im Codex-Desktop öffnen** übergibt den Projektordner oder die verwaltete Sitzung an die installierte Desktop-App. Die verwendeten Windows-Links entsprechen dem offiziellen [Codex-Launcher](https://github.com/openai/codex/blob/main/codex-rs/cli/src/desktop_app/windows.rs) und der [Sitzungsübergabe](https://github.com/openai/codex/blob/main/codex-rs/tui/src/app/history_ui.rs). Die native Antwort bestätigt ausschließlich die Übergabe an Windows. Sie bestätigt weder die Anzeige im Desktop noch ein gespeichertes Projekt in dessen Seitenleiste. Eine automatische Verwaltung der gespeicherten Desktop-Projektliste ist nicht implementiert; dafür liegt keine verifizierte öffentliche Schnittstelle vor.

Für ChatGPT steht bei vorbereiteten Aufträgen **Für ChatGPT kopieren** bereit. Ergebnisse können anschließend als Text oder Export zurückgeführt werden. Die ChatGPT-Desktop-Oberfläche wird nicht automatisch bedient, und private ChatGPT-Erinnerungen werden nicht im Hintergrund ausgelesen.

## Ergebnisse und Erinnerungen

1. Bei einem abgeschlossenen Auftrag **Als Erinnerung prüfen** wählen oder einen ChatGPT-JSON-Export bzw. eine Markdown-/Textdatei öffnen. Die Oberfläche begrenzt Dateien auf 4 MB.
2. Im Export das gewünschte Gespräch auswählen. Es wird nur der aktive Gesprächszweig mit sichtbaren Nutzer- und Assistententexten ausgewertet. Systemnachrichten, Werkzeuge, interne Analysekanäle und Anhänge werden ausgeschlossen.
3. Im bearbeitbaren Erinnerungstext die dauerhaft relevanten Aussagen auswählen. Quelle und Gesprächs-/Sitzungsreferenz bleiben als Herkunft erhalten.
4. Mit **Geprüfte Erinnerung übernehmen** im aktuellen Projekt speichern. Standardmäßig bleibt die Erinnerung privat und lokal; sie wird vom gewöhnlichen Modellabruf ausgeschlossen. Erst die ausdrücklich gewählte Freigabe erlaubt Modellkontext und den vorhandenen Serverabgleich.

Gleiche Quelle, Referenz und normalisierter Inhalt ergeben einen stabilen Erinnerungsschlüssel. Wiederholte Importe ersetzen keine abweichenden Entscheidungen und heben private Sichtbarkeit nicht stillschweigend auf. Zugangsdaten und lokale Dateipfade als Quellenreferenz werden abgewiesen. Die bestehende Erinnerungskontrolle kann die Sichtbarkeit oder Aufbewahrung weiter einschränken. Der tatsächliche Speicherzustand entscheidet über die Erfolgsmeldung.

## Warteschlange und Grenzen

- Zwei Aufträge können global parallel laufen. Derselbe Projektordner sowie übergeordnete/untergeordnete Ordner werden nacheinander bearbeitet. Native Ordnersperren koordinieren auch ältere Workflow-CLI-Aufrufe.
- Abbrechen, Not-Aus, Kontowechsel oder ein entzogener Schreibmodus stoppen betroffene Aufträge. Die Ordnersperre bleibt bis zur bestätigten Beendigung des nativen Prozesses bestehen. Bei unterbrochener nativer Verbindung wird sie vorsorglich weiter gehalten; gegebenenfalls muss Luczor neu gestartet werden.
- Codex-Aufträge sind zeitlich begrenzt und laufen mit begrenztem Ausgabepuffer. Interne Denk- und Werkzeugereignisse werden nicht als Erinnerungen importiert.
- Liveaufträge, Arbeitsaufträge und Ergebnisse werden nicht in Luczors gemeinsamen Chat-/Serverarchiv gespeichert. Die lokale Verknüpfung bleibt nach einem Neustart erhalten. Codex selbst verwaltet seine Sitzungsdaten nach seiner eigenen Konfiguration.
- Modellaufrufe können `agent_job_prepare`, `agent_job_status` und `agent_job_cancel` verwenden. Ergebnisabruf prüft die aktuelle Projekt-/Kontobindung und die Übertragungsrichtlinie erneut. `agent_dispatch` ist ein Kompatibilitätseinstieg für vorbereitete Codex-Aufträge; er startet keine unverwaltete CLI mehr. Der bestehende signierte Workflowkanal bleibt gesondert erhalten.

## Technische Grundlage und Prüfung

Die native Anbindung verwendet [`codex exec --json` mit stdin und Sitzungsfortsetzung](https://learn.chatgpt.com/docs/non-interactive-mode). Sie liest keine Zugangsdaten aus und verändert keine Codex-Konfigurationsdatei. Die Prozessargumente setzen Lese-/Schreibumfang, Freigabeverhalten und zusätzliche Schreibwurzeln für diesen Lauf fest.

Die Unit- und Rusttests prüfen Warteschlange, Abbruch, Kontowechsel, Ordnerwechsel, Quellenfilter, Dubletten, Paketfreigaben und Berechtigungsgrenzen. Eine isolierte Browseransicht prüft die echte Vue-Oberfläche mit synthetischen nativen Antworten und ausschließlich flüchtigem Testspeicher. Diese Prüfungen sind kein Nachweis einer realen Modellinferenz oder einer installierten Endnutzerfassung.
