# Luczor Mini

Luczor Mini ist ein eigenes, rahmenloses Tauri-Fenster. Es öffnet sich unten rechts,
bleibt standardmäßig über anderen Anwendungen und ist unabhängig davon, ob das
große Luczor-Fenster minimiert ist. Im Browser dient dieselbe Oberfläche als
verschiebbares Overlay innerhalb der Seite.

## Bedienung

- Den Kreis anklicken, um den temporären Chat zu öffnen. Kreis oder Griff ziehen,
  um ihn zu verschieben; am fokussierten Griff funktionieren auch die Pfeiltasten.
- Über Minus wieder auf den Kreis reduzieren. Das Schließen-Symbol blendet ihn
  aus. Wieder öffnen: Stern-Schaltfläche im Hauptfenster, Systemstatus oder
  Tray-Menü **Luczor Mini anzeigen**.
- Die Vordergrund-Schaltfläche im nativen Fenster schaltet „Immer im Vordergrund“
  um. Das Fenstersymbol öffnet das große Luczor-Fenster.
- Enter sendet, Shift+Enter fügt eine Zeile ein. Während einer Anfrage kann ein
  Entwurf geschrieben oder die laufende Anfrage gestoppt werden.
- Antwortvorschläge senden eine neue Nachricht. Werkzeugfreigaben haben eigene
  Schaltflächen **Ablehnen** und **Einmal ausführen**; Details lassen sich aufklappen.
  Offene Freigaben des Projektchats können ebenfalls im Mini-Fenster beantwortet
  werden. Eine Auswahlantwort erteilt keine Werkzeugfreigabe.
- Eine neue Antwort erscheint eingeklappt zwölf Sekunden als Sprechblase. Beim
  Darüberfahren bleibt sie stehen. Die Markierung **Neue Antwort** bleibt bis zum
  Öffnen bestehen. Offene Entscheidungen verschwinden nicht nach einem Timer.
- **Neuer temporärer Chat** leert nach Bestätigung Unterhaltung und Entwurf und
  bricht eine laufende Anfrage ab. **Not-Aus** nutzt die bestehende Werkzeugsperre.

## Bedeutung der Kreisanimation

Die Darstellung übernimmt die konzentrischen Ringe des bisherigen Live-Status.
Farbe, Symbol und Beschriftung ergänzen sich; Bewegung ist keine Prozentanzeige.

| Zustand | Darstellung | Tatsächliche Quelle |
| --- | --- | --- |
| Bereit | Ruhiger blauer Kreis | Keine laufende Anfrage |
| Verarbeitet | Rotierende blaue Segmente | Agentenrunde und Empfangsstatus |
| Führt aus | Orange Segmente | Werkzeugstatus `executing` |
| Deine Entscheidung | Gelber Kreis mit Ausrufezeichen | Offene Freigabe |
| Hört zu | Cyanfarbener Ausschlag | Mikrofonstatus und gemessener Pegel im Hauptfenster |
| Spricht | Grüner Puls | Aktive Sprachausgabe |
| Neue Antwort | Grüner Haken und Markierung | Ungelesene abgeschlossene Antwort |
| Anfrage fehlgeschlagen | Rotes Fehlersymbol | Tatsächlich fehlgeschlagene Anfrage |
| Not-Aus aktiv | Graues Stoppsymbol | Gemeinsamer Kill-Switch |

Die Info-Schaltfläche erklärt diese Zustände und bietet das Zurücksetzen der
Position. Betriebssystem und Luczor-Einstellung für reduzierte Bewegung werden
berücksichtigt. Fenstergrößen und Positionen werden an die Monitor-Arbeitsfläche
angepasst, einschließlich Bildschirmen mit negativen Koordinaten.

## Temporäre Sitzung und Laufzeit

Der Mini-Chat besitzt einen eigenen flüchtigen Nachrichtenverlauf und ein eigenes
flüchtiges Werkzeugjournal. Sie werden nicht in Projektverlauf, Sync oder Memory
geschrieben. Die Sitzung bindet sich bei der ersten Nachricht an das sichtbare
Projekt und behält diesen Kontext bis zum Leeren. Ein API-Identitätswechsel leert
sie ebenfalls. Ausblenden allein leert die Sitzung nicht; ein Neustart tut es.

„Temporär“ betrifft diesen lokalen Gesprächsverlauf. Explizit freigegebene
Werkzeugaktionen können weiterhin dauerhafte Auswirkungen haben. Die Aufbewahrung
beim tatsächlich verwendeten Inferenzanbieter wird dadurch nicht geändert.

Das Hauptfenster besitzt die einzige Agentenlaufzeit. Das Mini-Fenster übermittelt
validierte, typisierte Aktionen und erhält begrenzte Zustandsabbilder. Es startet
keine zweite Mikrofon-, Modell- oder Sync-Laufzeit und besitzt keine Dateisystem-,
Credential- oder allgemeinen Event-Sendeberechtigungen. Externe Antwortlinks
verwenden den vorhandenen geprüften HTTP(S)-Öffnungspfad.

Hauptchat und Mini-Chat starten keine parallelen Agentenläufe. Abbruch und Leeren
verwerfen verspätete Ergebnisse und Freigaben; die Ausführungssperre bleibt bis
zum tatsächlichen Ende des alten Laufs erhalten. Bestehende Modus-, Projekt-,
Routing-, externe Datenfreigabe- und Ausgabekontrollen gelten auch im Mini-Chat.
Text wird erst nach der bestehenden Ausgabeprüfung schrittweise dargestellt.

## Lokale Prüfung

- Gesamtsuite: 53 Vitest-Dateien, 489 Tests bestanden; ESLint ohne Befund.
- Rust: 74 Tests bestanden; Cargo Check und Clippy ohne Warnungen.
- TypeScript-Prüfung und Vite-Produktionsbuild bestanden.
- Nativer finaler Debug-Testbuild mit `--no-bundle` und der bestehenden
  `src-tauri/tauri.local-test.conf.json` erfolgreich, 6. September 2026,
  02:55:14 UTC: `src-tauri/target/debug/tauri-app.exe`, 41.983.488 Bytes,
  SHA-256 `35EBDF5CAE216D8EB42F165FCF124372E095C1990B4D937EF590BEB2B86B8DF8`.
  Auch der Release-Build bestand; der Debug-Build enthält die letzte
  Layoutkorrektur. Kein Installer wurde ausgeführt.
- Browser: freies Verschieben, Öffnen/Einklappen, Freigabe, Auswahlantwort,
  Abbruch, Leeren und kompakte Fenstergröße geprüft.
- `tests/fixtures/mini-chat.html` ist eine ausdrücklich beschriftete Testseite
  mit synthetischen Beispieldaten und gehört nicht zum produktiven App-Einstieg.
  Sie ruft kein Modell, Mikrofon oder echtes Werkzeug auf.

Native Windows-Kompilierung ist getrennt von einer interaktiven Abnahme von
Always-on-top, Hauptfenster-Minimierung, echter Inferenz und Mikrofonbetrieb zu
betrachten. Die Browserprüfung bestätigt diese Windows-Funktionen nicht.

Die frühere UI-Bibliothek und ihr Menüpunkt wurden auf Wunsch entfernt. Die im
Chat verwendeten Beautiful-UI-Komponenten bleiben wiederverwendbar vorhanden.
