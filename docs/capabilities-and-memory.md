# Funktionssteuerung, Erinnerungen und Computerzugriff

Stand: 6. September 2026. Die Beschreibung bezieht sich auf den lokalen Quellcode.

## Bedienung

Unter **Einstellungen → Ausführung & Freigaben** zeigt die durchsuchbare Übersicht die registrierten Werkzeuge für Projekte und Aufgaben, Dateien, Computer, Coding-Agenten und Erinnerungen. Die Liste wird aus derselben Registrierung wie die Modellwerkzeuge erzeugt. Sie zeigt die Freigaberegel für den aktuellen Chatmodus und die im Formular ausgewählten Einstellungen; sie ersetzt keine Prüfung von Projektordner, Gerätezugriff oder Modellverbindung.

- **Beobachten:** Datenverändernde Werkzeuge bleiben gesperrt. Sensible Lesezugriffe können eine Einzelbestätigung verlangen.
- **Handeln:** Werkzeuge folgen ihrer jeweiligen Freigaberegel. Die Option zur automatischen Ausführung überspringt nur die Bestätigung erlaubter datenverändernder Werkzeuge. Sensible Lesezugriffe behalten ihre Bestätigung.
- **Vollzugriff:** Einzelbestätigungen entfallen innerhalb der vorhandenen Werkzeug- und Projektgrenzen.
- **Not-Aus:** Alle neuen Werkzeugausführungen sind gesperrt.

Eine gespeicherte Änderung der Ausführungsoption gilt vor dem nächsten Werkzeugaufruf, auch innerhalb eines laufenden Auftrags. Bereits gestartete Betriebssystemaktionen lassen sich damit nicht rückwirkend zurücknehmen. Modus, Abbruch und Not-Aus werden vor der Ausführung erneut geprüft.

## Erinnerungsabruf

Mit `memory_recall` kann der Agent gezielt nach Projekt- oder Benutzererinnerungen suchen. Beispielsweise: „Welche Entscheidung haben wir zum Exportformat getroffen?“ Der Projektzugriff ist an das aktive Projekt gebunden; das Modell kann kein fremdes Projekt über einen Dateipfad oder eine Projekt-ID auswählen. Das Werkzeug liefert höchstens 20 passende Einträge innerhalb eines begrenzten Antwortumfangs.

Die gemeinsame Abrufschicht berücksichtigt Inhalt, Tags und technische Funktionsschlüssel. Unpassende rein lexikalische Treffer werden entfernt; vom Server erneut gegen SQL geprüfte semantische Treffer bleiben zulässig. Inhaltsdubletten und doppelte Funktionsfassungen werden zusammengeführt. Lokale Datenschutzentscheidungen, vorgemerkte Löschungen und noch nicht synchronisierte Ersatzfassungen haben Vorrang vor verspäteten Serverantworten. Nach einem Kontowechsel wird das Ergebnis eines alten Abrufs verworfen.

Unter **Server** befinden sich Quelle, automatische Kontextergänzung, automatische Erinnerungsvorschläge und Trefferzahl. Die Trefferzahl kann zwischen 0 und 20 liegen. Der gezielte Abruf und der Projektstart verwenden die verbesserte gemeinsame Abrufschicht. Der erfolgreiche serverseitige `/context/ask`-Pfad behält seine eigene SQL-/Cognee-Auswahl; bei dessen Ausfall greift die lokale Abrufschicht. SQL bleibt die gemeinsame maßgebliche Datenquelle, Cognee eine abgeleitete semantische Projektion.

Private lokale Daten werden durch diese Erweiterung nicht automatisch für externe Modelle freigegeben. Flüchtige Werkzeugargumente und Ergebnisse werden für das gespeicherte Chatarchiv redigiert. Die aktuelle Freigabeanzeige und die laufende Modellrunde erhalten weiterhin die benötigten Inhalte. Beim Wiederladen sind redigierte, zuvor noch laufende Werkzeugvorschläge als abgebrochen markiert.

## Computeranalyse und Steuerung

`os_environment` liefert native Bildschirm-IDs, Positionen, Auflösung, Skalierungsfaktoren, Fenstergeometrien und Systemmetriken. Die Antwort unterscheidet vollständige, teilweise und fehlende Daten (`ready`, `partial`, `unavailable`) und nennt den Zustand jeder Quelle. Teilweise Ergebnisse bleiben für das Modell nutzbar, ohne vollständigen Erfolg vorzutäuschen.

`os_screen_capture` erfasst standardmäßig den tatsächlichen Hauptbildschirm. Mit `monitor_id` aus der Umgebungsanalyse lässt sich ein anderer Bildschirm wählen. Eine fehlgeschlagene neue Aufnahme entfernt eine zuvor angezeigte Aufnahme. Das Bild bleibt in der lokalen Oberfläche; sein Bildinhalt wird dem Modell nicht automatisch visuell übergeben.

Auf Windows verwendet die Mauspositionierung physische Desktopkoordinaten über [`SetPhysicalCursorPos`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setphysicalcursorpos). Dadurch werden auch Bildschirme mit negativen Ursprüngen unterstützt. Vor einer positionierten Eingabe werden Koordinaten, Bildschirmgrenzen und Klickparameter geprüft; vor dem Klick muss die Maus die Zielposition erreicht haben. Fenster-IDs und Geometrien sind Beobachtungsdaten; diese Erweiterung führt keine zielgebundene Fenstersteuerung oder automatische Bilderkennung ein.

## Abnahmegrenzen

Automatische Tests und ein nativer Lesetest prüfen die Verträge und Bildschirm-/Fenstererkennung. Eine echte Maus-/Tastaturaktion, visuelle Modellinterpretation, produktive Modellinferenz und eine installierte Endnutzerfassung benötigen eine gesonderte interaktive Abnahme. Die lokalen Änderungen installieren oder veröffentlichen keine neue App-Version.
