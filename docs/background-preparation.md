# Vorbereitung im Hintergrund

Unter **Einstellungen → Ausführung → Im Hintergrund vorbereiten** sind zwei Funktionen standardmäßig aktiv:

- **Lokales Modell bereithalten:** Nach dem Start und nach Verfügbarkeit einer gültigen signierten Modellrichtlinie bereitet das Hauptfenster das konfigurierte Standardmodell vor. Ein bereits bereites Modell wird nicht erneut geladen. Auch ohne ausgewähltes Projekt kann die Modellvorbereitung beginnen.
- **Projektkontext vorab vorbereiten:** Projektziele, Zusammenfassung, erlaubte Erinnerungen und das Assistentenprofil werden bei einem Projektwechsel beziehungsweise vor der nächsten Eingabe vorbereitet. Es werden keine anfrageabhängigen Repository-Recherchen, Dateiaktionen oder externen Modellaufträge im Hintergrund gestartet.

Das lokale Modell belegt weiterhin Arbeits- und gegebenenfalls Grafikspeicher. Das Abschalten beendet weitere automatische Vorbereitungen; ein bereits verwendetes Modell wird dadurch nicht mitten in einem Auftrag beendet. Die Anwendung beendet ihre verwaltete Modelllaufzeit beim vollständigen Schließen.

## Laufzeitvertrag

`createLocalBackgroundPreparation()` verwendet ausschließlich den bestehenden signierten Coordinatorpfad mit `contextEgress: local_only`. Ein gültiger Bereitschaftsnachweis wird alle fünf Sekunden im vorhandenen Frontendzustand geprüft. Solange dieser gültig ist, erfolgen keine zusätzlichen Prepare-Aufrufe. Fehlversuche haben 60 Sekunden Pause. Ein zuvor signiertes, inzwischen abgelaufenes Manifest wird durch den bestehenden Coordinator erneuert und erneut verifiziert, bevor native Vorbereitung möglich ist.

Nach einem vorübergehenden Bootstrap-/Verbindungsfehler versucht der Hintergrundhook die vorhandene signierte Initialisierung nach einer kurzen Startfrist erneut. Weitere Fehler vergrößern die Pause von 60 Sekunden bis maximal fünf Minuten. Laufende Initialisierung, fehlende oder abgelehnte Signaturen und falsche Kontobindungen werden dadurch nicht übergangen. Die gespeicherte Flash-Experiment-Einstellung gilt ebenfalls; fehlt ein zulässiges experimentelles Modell, bleibt die signierte Fallbackkette maßgeblich. Die Kapazitätsgrenze entspricht dem regulären Chat.

Modellvorbereitung und ein unmittelbar danach gesendeter Chat teilen die vorhandene exklusive Prepare-Warteschlange. Erfolg hält den nativen Prozess resident. Die zehnminütige Bereitschaftslease wird bei Bedarf am residenten Prozess erneuert; sie ist kein Inaktivitätstimer zum Entladen. Ein tatsächlicher Wechsel des privaten Runtime-Scopes, ein Fehler, Abbruch, eine Katalogänderung oder das Schließen der Anwendung kann die Laufzeit weiterhin beenden.

Native Vorbereitung hat derzeit keine öffentlich aufrufbare Abbruch-ID pro Prepare-Auftrag. Der Hintergrundcontroller verwirft veraltete Ergebnisse sofort und hält seinen belegten Platz bis zum tatsächlichen Ende frei von konkurrierender Vorbereitung. Konto-/Kataloginvalidierung nutzt weiterhin die native Kataloggrenze. Es wird kein bereits erstelltes Gateway für spätere Chats zwischengespeichert.

## Kontextgrenzen

`useBackgroundPreparation()` besitzt einen ausschließlich im Hauptfenster lebenden `ScopedPreparationCache`. Dessen Schlüssel bindet Konto, Server, Projekt, Renderer-Ausführungssitzung, Generation, Workspace und eine Revision aller Kontextquellen. Der Zwischenspeicher hält maximal vier Einträge für maximal 45 Sekunden; Ausgabe und Rückgaben sind voneinander unabhängige Kopien.

Projektquellen, gespeicherte Erinnerungen, Einstellungen, API-Identität, Ausführungsgeneration und Richtlinie invalidieren den Cache. Änderungen des bloßen Projekt-Zeitstempels während eines Antwortstreams tun dies nicht. Ohne Änderungsbeobachtung des verschlüsselten Memory-Stores werden erinnerungshaltige Kontexte nicht wiederverwendet. Quellfragmente erhalten ihre Zielgruppe und Sitzung erst beim tatsächlichen Versand erneut durch den ContextBroker. Freigaben, Gateways, private Tool-Journale und turngebundene externe Pakete werden nie gecacht.

Das Assistentenprofil verwendet seinen bereits vorhandenen Identitäts-/Revisionsschutz und den deduplizierten 60-Sekunden-Cache. Der Hintergrundpfad speichert weder Modellprompts noch Kontext in zusätzliche Dateien.

## Prüfung

Gezielte automatische Prüfung am 7. September 2026: zuletzt 156 Tests in acht Dateien erfolgreich, einschließlich Warmup→Send mit genau einer nativen Prepare-Anforderung, Policyablauf, Bootstrap-Recovery mit Backoff, Scopewechsel, verspäteten Ergebnissen, fehlenden Memory-Notifications, Live-Einstellungen und Abschalten. Gezieltes ESLint und der kanonische Typecheck waren erfolgreich.

Die vom Haupttask um 02:34:22 gestartete Release-App (PID106820) startete ohne Chat den lokalen llama-server um 02:36:09 (PID127068, Parent106820). Gezielte Loopback-Health-Prüfung: HTTP200/statusok. Zwei Beobachtungen im Abstand von122,9Sekunden bestätigten dieselbe Prozess-ID und dieselbe Startzeit. Der erste Start kann wegen Prüfung der großen lokalen Modelldatei deutlich länger dauern als ein späterer Auftrag. Es wurde für diese Abnahme keine Chat-Inferenz ausgelöst. Belege: `.lmzdev/artifacts/reports/2026-09-07-background-warmup-live-initial.json` und `-idle.json`.

Auch der abschließende Release mit Bootstrap-Recovery und gespeicherter Flash-Einstellung wurde gestartet und geprüft: Appstart 02:53:10, automatischer Modellprozess nach 103,3 Sekunden, danach zweimal HTTP 200/status ok bei unveränderter Modell-PID. Kein Chat wurde abgesendet. Die Zeiten bis zum Prozessstart sind kein vollständiger Antwortlatenz-Benchmark. Finaler Nachweis: `../../.lmzdev/artifacts/reports/2026-09-07-background-final-release-smoke.json`. Der abschließende Gesamt-Testlauf bestand mit 1168 Frontendtests in 108 Dateien.
