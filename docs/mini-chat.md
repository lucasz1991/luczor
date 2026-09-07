# Luczor Mini

Luczor Mini verwendet dieselben Oberflächenfarben, Schrift, Chatkomponenten und
Akzentfarbe wie das große Luczor-Fenster. Es läuft als eigenes, rahmenloses
Tauri-Fenster, öffnet sich unten rechts und bleibt standardmäßig über anderen
Anwendungen. Das Hauptfenster kann dabei minimiert sein. Im Browser erscheint
dieselbe Oberfläche als verschiebbares Overlay innerhalb der Seite.

## Zwei Ansichten, eine gemeinsame Laufzeit

| Ansicht         | Gespräch und Kontext                                                                                                               | Aufbewahrung                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Projektchat** | Derselbe Chat des ausgewählten Projekts wie im Hauptfenster; Nachrichten, Antworten und Werkzeugstatus werden gemeinsam angezeigt. | Gehört zum bestehenden Projektverlauf und verwendet dessen Speicher-, Sync- und Memory-Regeln.                            |
| **Workspace**   | Übergeordnete Verwaltung mit eigener Unterhaltung; Projekte und Projektchats gezielt überblicken und Aufträge vorbereiten.         | Unterhaltung und Werkzeugjournal bleiben flüchtig und werden nicht automatisch im Projektchat, Sync oder Memory abgelegt. |

Der lokale Desktop verwaltet derzeit einen fortlaufenden Chat je Projekt. Die
Projektauswahl im Mini öffnet denselben Projektchat auch im Hauptfenster; sie
erzeugt keine zweite Kopie. Beim Wechsel zwischen **Projektchat** und **Workspace**
bleiben beide Gespräche getrennt. Entwürfe sind ebenfalls nach Ansicht und
Projektchat getrennt.

Im Projektchat werden Nachrichten durch denselben Sende- und Generierungspfad
wie im Hauptfenster verarbeitet. Dessen gewählte Modellroute und gegebenenfalls
explizite externe Fallbackfreigabe gelten deshalb auch beim Schreiben aus Mini.
Der Workspace nutzt ausschließlich das lokale Modell. Fehlt dessen Bereitschaft,
zeigt er den Einrichtungs- oder Prüfungsfehler an; er versendet kein externes
Nachrichtenpaket.

## Übergreifend arbeiten

Im **Workspace** kann Luczor:

- eine begrenzte Übersicht der verfügbaren Projekte, Projektchats und verwalteten
  Agentenaufträge lesen;
- abgeschlossene öffentliche Nachrichten eines ausdrücklich ausgewählten
  Projektchats abrufen; versteckte Werkzeugnachrichten und private oder laufende
  Antworten sind von diesem übergreifenden Abruf ausgeschlossen;
- den Namen oder die Zusammenfassung eines ausdrücklich genannten Projekts
  ändern, ohne dessen Chat, Ziele oder Ordnerzuordnung zu ersetzen;
- Code- und Modellagentenaufträge für ein genanntes Projekt vorbereiten, deren
  Status und zulässige Ergebnisse abfragen oder einen Auftrag abbrechen.

Vorbereitete Agentenaufträge werden unter **Agenten** mit ihrem Projektkontext
geprüft und vom Nutzer gestartet. Eine Chatantwort oder die Vorbereitung eines
Auftrags startet keinen Coding-Agenten automatisch. Bestehende Rechte, Freigaben,
Ordnerbindungen und Ergebnisprüfungen bleiben wirksam.

Die Auswahl **Arbeitsprojekt für Dateien & Desktop** bestimmt den Projektkontext
der nächsten Runde. Dateiwerkzeuge verwenden dessen gebundenen Projektordner;
Desktopaktionen verwenden die bestehenden Computerwerkzeuge und deren Freigaben.
Ein übergeordnetes Gespräch hebt diese Grenzen nicht auf. Projektwechsel sind
zwischen Aufträgen möglich. Die Schaltflächen **Projektordner**, **Agenten** und
**Desktop** öffnen die zugehörige bestehende Funktion im Hauptfenster.

Die sechs zusätzlichen Werkzeuge heißen workspace_overview,
workspace_project_update, workspace_chat_read, workspace_agent_prepare,
workspace_agent_status und workspace_agent_cancel. Sie sind nur für einen
lokalen Workspace-Lauf mit geprüftem Konto und einer vorab erfassten Projektliste
verfügbar. Auch ein erfundener Werkzeugaufruf aus einem normalen Projektchat wird
abgewiesen. Übersichten enthalten keine Auftrags-Prompts, Ergebnis-Rohdaten oder
absoluten Ordnerpfade.

## Bedienung

- Den Kreis anklicken, um Mini zu öffnen. Kreis oder Griff ziehen, um das Fenster
  zu verschieben; am fokussierten Griff funktionieren auch die Pfeiltasten.
- Über Minus wieder auf den Kreis reduzieren. Das Schließen-Symbol blendet Mini
  aus. Wieder öffnen: Stern-Schaltfläche im Hauptfenster, Systemstatus oder
  Tray-Menü **Luczor Mini anzeigen**.
- Die Vordergrund-Schaltfläche im nativen Fenster schaltet **Immer im Vordergrund**
  um. Das Fenstersymbol öffnet das große Luczor-Fenster.
- Über **Projektchat** und **Workspace** den Gesprächskontext wählen. Enter sendet,
  Shift+Enter fügt eine Zeile ein. Während einer Anfrage kann ein Entwurf
  geschrieben oder die laufende Anfrage gestoppt werden.
- Antwortvorschläge senden eine neue Nachricht. Werkzeugfreigaben haben eigene
  Schaltflächen **Ablehnen** und **Einmal ausführen**; Details lassen sich aufklappen.
  Offene Freigaben des Projektchats können ebenfalls im Mini beantwortet werden.
  Eine Auswahlantwort erteilt keine Werkzeugfreigabe.
- Eine neue Antwort erscheint eingeklappt zwölf Sekunden als Sprechblase. Beim
  Darüberfahren bleibt sie stehen. Die Markierung **Neue Antwort** bleibt bis zum
  Öffnen bestehen. Offene Entscheidungen verschwinden nicht nach einem Timer.
- **Workspace leeren** entfernt nach Bestätigung die flüchtige Unterhaltung und
  den zugehörigen Entwurf und bricht einen laufenden Workspace-Auftrag ab. Es
  löscht keinen Projektchat. Im Projektchat führt **Workspace öffnen** lediglich
  in die andere Ansicht.
- **Not-Aus** nutzt die gemeinsame Werkzeugsperre. **Stoppen** beendet den gerade
  laufenden Chat-Auftrag, auch wenn inzwischen die andere Ansicht geöffnet ist.

## Bedeutung der Kreisanimation

Die Darstellung übernimmt die konzentrischen Ringe des Live-Status. Farbe,
Symbol und Beschriftung ergänzen sich; Bewegung ist keine Prozentanzeige.

| Zustand                | Darstellung                                | Tatsächliche Quelle                                 |
| ---------------------- | ------------------------------------------ | --------------------------------------------------- |
| Bereit                 | Ruhiger Kreis in der gewählten Akzentfarbe | Keine laufende Anfrage                              |
| Verarbeitet            | Rotierende Segmente in der Akzentfarbe     | Agentenrunde und Empfangsstatus                     |
| Führt aus              | Orange Segmente                            | Werkzeug wird ausgeführt                            |
| Deine Entscheidung     | Gelber Kreis mit Ausrufezeichen            | Offene Freigabe                                     |
| Hört zu                | Cyanfarbener Ausschlag                     | Mikrofonstatus und gemessener Pegel im Hauptfenster |
| Spricht                | Grüner Puls                                | Aktive Sprachausgabe                                |
| Neue Antwort           | Grüner Haken und Markierung                | Ungelesene abgeschlossene Antwort                   |
| Anfrage fehlgeschlagen | Rotes Fehlersymbol                         | Tatsächlich fehlgeschlagene Anfrage                 |
| Not-Aus aktiv          | Graues Stoppsymbol                         | Gemeinsamer Kill-Switch                             |

Die Info-Schaltfläche erklärt diese Zustände und bietet das Zurücksetzen der
Position. Betriebssystem und Luczor-Einstellung für reduzierte Bewegung werden
berücksichtigt. Fenstergrößen und Positionen werden an die Monitor-Arbeitsfläche
angepasst, einschließlich Bildschirmen mit negativen Koordinaten.

## Sitzungs- und Ausführungsgrenzen

Das Hauptfenster besitzt Modell-, Mikrofon-, Speicher- und Sync-Laufzeit. Mini
übermittelt typisierte, validierte Aktionen und erhält begrenzte Zustandsabbilder.
Es besitzt keine eigene Dateisystem-, Credential- oder allgemeine
Event-Sendeberechtigung. Externe Antwortlinks verwenden den bestehenden geprüften
HTTP(S)-Öffnungspfad.

Hauptchat und Workspace starten keine konkurrierenden Chat-Agentenläufe. Während
einer laufenden Anfrage, Planung oder Projektauswahl wird kein weiterer Chatlauf
zugelassen. Abbruch und Leeren verwerfen verspätete Ergebnisse und Freigaben; die
Sperre bleibt bis zum tatsächlichen Ende des alten Laufs erhalten. Konto-,
Projekt- und Moduswechsel widerrufen die zugehörige Ausführungsberechtigung.
Veraltete Fensteraktionen können keinen neu ausgewählten Chat bedienen.

Die Workspace-Unterhaltung bleibt beim Projektwechsel erhalten; das sichtbare
Arbeitsprojekt wird für den nächsten Auftrag übernommen. Ausblenden allein leert
sie nicht. Ein API-Identitätswechsel oder App-Neustart verwirft sie. „Flüchtig“
betrifft den lokalen Gesprächsverlauf: ausdrücklich ausgeführte Projektänderungen,
Dateiänderungen oder andere freigegebene Aktionen können dauerhaft wirken.

Öffentliche Antworttexte und Zwischenkommentare werden während des echten
Empfangs dargestellt. Private Modellkanäle bleiben ausgeschlossen. Die
Fensterübertragung begrenzt Nachrichten, Kommentare und Aktivitätsdetails, damit
auch lange Projektverläufe innerhalb des nativen Snapshot-Limits bleiben.

## Lokale Prüfung – 7. September 2026

- Integrierte Frontend-Suite: **100 Vitest-Dateien, 1.066 Tests bestanden**;
  TypeScript-Prüfung und ESLint bestanden.
- Die Suite enthält die Workspace-Werkzeugprüfungen sowie die Registry-,
  Laufzeit-Isolations- und Bridge-Regressionstests. Sie prüfen insbesondere
  Konto-/Projektgrenzen, lokale Routingpflicht, Freigaben, Abbruch,
  gemeinsame Projektchats, getrennte Workspace-Verläufe und begrenzte Snapshots.
- Native Tests: **122 bestanden, ein interaktiver Test ignoriert**; Clippy und
  Rust-Formatprüfung bestanden.
- Die ausdrücklich beschriftete Testseite tests/fixtures/mini-chat.html arbeitet
  mit synthetischen Beispieldaten und gehört nicht zum produktiven App-Einstieg.
  Sie ruft kein Modell, Mikrofon oder echtes Werkzeug auf. Im Browser geprüft:
  Hauptfenster und Mini gemeinsam, Projektwechsel, dieselbe fertige Antwort in
  beiden Ansichten, erhaltener Workspace-Verlauf sowie Wiederherstellung eines
  Chat-Entwurfs nach dem Ansichtswechsel. Layout und Freigaben wurden auch bei
  420 × 660 Pixeln geprüft; anschließend wurde der Viewport zurückgesetzt.
- Gemeinsamer nativer Release-Build mit **--no-bundle** erfolgreich (Exitcode 0), 6. September 2026,
  22:54:07 UTC: `src-tauri/target/release/tauri-app.exe`, Version 2.9.3,
  **14.585.856 Bytes**, SHA-256
  `96109C1BB7FEB1CFA8ACE0D7F9B9F2E63859243418F36FF07F1C6D8B0484ADDF`.
  Das Artefakt verwendet die bestehende Desktop-Identität und wurde nicht gestartet;
  die laufende Debug-Sitzung bleibt erhalten.

Native Windows-Kompilierung ist getrennt von einer interaktiven Abnahme von
Always-on-top, Hauptfenster-Minimierung, echter Inferenz und Mikrofonbetrieb zu
betrachten. Die synthetische Browserprüfung bestätigt diese Windows-Funktionen
nicht. Es wurde kein Installer ausgeführt und nichts veröffentlicht.

Die frühere UI-Bibliothek und ihr Menüpunkt bleiben entfernt. Die im Chat
verwendeten Beautiful-UI-Komponenten sind weiterhin wiederverwendbar vorhanden.
