# Chatplanung und optionales Planungsfenster testen

Planung findet in Luczor standardmäßig im normalen KI-Chat statt. Ziel, Rückfragen, Alternativen und Planänderungen bleiben dadurch Teil derselben Unterhaltung. Das optionale Planungsfenster ist für Aufgaben gedacht, die zusätzlich einen strukturierten DAG, eine gespeicherte Reviewrevision und eine getrennt freizugebende Ausführung benötigen. Ein fertiger Lauf ist noch keine automatische Abnahme. Die Schrittausgaben, das Abschlussreview und alle als unbekannt oder fehlgeschlagen markierten Kriterien müssen anschließend geprüft werden.

## Planung im normalen KI-Chat

Beschreibe die Aufgabe wie jede andere Anfrage im Chat, zum Beispiel „Analysiere zuerst die Ausgangslage und erstelle danach einen Plan“. Der Startvorschlag **Gemeinsam planen** füllt dafür den Chat-Composer. `/plan <Ziel>` wird beim Absenden in einen normalen Chatauftrag umgewandelt. Beide Wege lassen das Planungsfenster geschlossen. Der Plan kann anschließend mit Rückfragen und Korrekturen direkt im Gespräch weiterentwickelt werden.

Eine vorhandene Checkliste bleibt im Chatkontext verfügbar. Ihr optionaler Knopf **Im Planungsfenster ausarbeiten** wechselt bewusst in den strukturierten Ablauf. Er startet keine Ausführung.

## Strukturierter Ablauf im optionalen Planungsfenster

1. Öffne in der Seitenleiste ausdrücklich **Planungsfenster**. Bei einer bereits vorhandenen Planung öffnet **Planungsfenster öffnen** im Statusbereich denselben Stand. Eine Checkliste kann über **Im Planungsfenster ausarbeiten** als Ausgangsziel übernommen werden.
2. Beschreibe Ziel, Randbedingungen und Ausschlüsse. Wähle den Planer:
   - **Codex** darf das gebundene Projekt für Analyse und Planung lesend untersuchen und muss konkrete Belege nennen.
   - **Eigenes Modell** arbeitet lokal über das zugelassene Modellprofil.
   - **Modellrichtlinie** wählt ein zugelassenes Profil lokal zuerst. Lokale und richtliniengesteuerte Planer erhalten keinen direkten Datei- oder Toolzugriff; ihre Analyse weist diese Zugriffsgrenze ausdrücklich aus.
3. Klicke **Analysieren und planen**. Analyse und Plan sind zwei getrennte, ausschließlich lesende Agentenaufträge. Der Dialog zeigt beide Phasen und kann den Lauf explizit abbrechen.
4. Prüfe Zusammenfassung, Befunde, Belege, Annahmen, Risiken und offene Fragen. Offene Fragen sperren die Ausführung. Trage die Entscheidung unter **Präzisierungen** ein und starte **Mit Präzisierungen neu planen**.
   Zieländerungen und zusätzliche Präzisierungen sperren ebenfalls die Ausführung des bisherigen Plans. **Analysieren und planen** kann die Planung auch ohne offene Fragen erneut erstellen. Bereits beim ersten Start werden eingetragene Präzisierungen berücksichtigt.
5. Prüfe jeden Planschritt. Titel, ID, Beschreibung, Abhängigkeiten, Abnahmekriterien und Verifikation sind editierbar. Gesamtabnahme und Punkte außerhalb des Umfangs gehören ebenfalls zur Revision. Nach jeder Änderung muss **Planänderungen übernehmen** geklickt werden; ein schmutziger Entwurf kann nicht ausgeführt werden.
6. Wähle Executor, Modell und Berechtigung. Die Vorgabe ist **Nur lesen / Patchvorschlag**. Schreibzugriff ist nur mit Codex und nur außerhalb des Beobachten-Modus wählbar.
7. Klicke **Geprüften Plan ausführen · Revision …**. Luczor bindet die Freigabe an Sitzungs-ID, Revision, Konto, Projekt, Workspace und aktuellen Steuerungsmodus. Ein Konto-, Projekt-, Modus- oder Not-Aus-Wechsel verwirft den alten Lauf.
8. Prüfe im Ausführungslauf jeden Knoten. Der Abschlussreview bewertet jedes Abnahme-, Verifikations- und Gesamtkriterium als **belegt**, **fehlgeschlagen** oder **unbekannt** und nennt nur vorhandene Nachweise. Der Status **Ausführung beendet** bedeutet deshalb lediglich, dass der Lauf terminiert ist.

Das Schließen des Planungsfensters versteckt eine laufende Planung; es bricht sie nicht ab. **Lauf abbrechen** beziehungsweise **Ausführung abbrechen** ist die explizite Abbruchaktion. Während ein normaler Chat-Turn läuft, bleiben Review und Export sichtbar, neue Analyse oder Ausführung sind gesperrt.

## Externe Modellfreigabe

Wenn eine Planungs- oder Ausführungsaufgabe einen externen Provider benötigt, erscheint die Freigabe im Planungsdialog. Sie ist auf die aktuelle Planungssitzung beziehungsweise deren Teamlauf begrenzt. Vor der Zustimmung zeigt Luczor Ziel, Ablaufdatum, Client-Paket-Hash und das vollständige Client-JSON einschließlich der zu sendenden Nachrichten. **Dieses Paket freigeben** gilt nur für genau diesen vorbereiteten Auftrag; **Ablehnen** beendet ihn.

Die dargestellte Prüfsumme deckt das Client-Paket ab. Der Laravel-Server ergänzt derzeit noch seine Systemprompts, ohne dem Desktop vor der Freigabe einen abschließenden Hash über den daraus entstehenden vollständigen Provider-Prompt zurückzugeben. Eine durchgängige Ende-zu-Ende-Freigabe des finalen Serverprompts ist daher noch offen.

## Plan importieren und exportieren

**JSON anzeigen** und **JSON herunterladen** exportieren die aktuelle Analyse und Planrevision. Laufzeitausgaben, Fehler und der ausgeführte Teamlauf werden nicht als wiederaufzunehmender Zustand exportiert. Beim Import prüft der Controller Formatversion, Zeichenlimits, Projekt, Konto, Workspace, Analyse, Schritt-IDs und den azyklischen Abhängigkeitsgraphen erneut.

Ein importierter Plan bleibt im Reviewstatus. Import und Wiederherstellung starten weder Analyse noch Ausführung automatisch. Ein Export ist deshalb ein prüfbares Übergabedokument, keine Sitzungswiederaufnahme.

## Synthetisches Browserlabor

Das Labor nutzt den echten `PlanningController` sowie den echten `AgentTeamOrchestrator`. Es ersetzt Projekt-Snapshot, Analyseantworten, Planantworten und Knotenausgaben durch begrenzte Fixtures. Es startet keine Modelle, Provider, Codex-Tasks oder Dateiaktionen.

Starte den Entwicklungsserver unter Windows mit der im Repository fixierten Node-Version:

```powershell
cd E:\projekte\luczor\app
.\scripts\with-pinned-node.ps1 -Executable pnpm -Arguments @('lab:planning')
```

Öffne danach [http://127.0.0.1:1433/planning-lab.html](http://127.0.0.1:1433/planning-lab.html). Die drei Szenarien prüfen unterschiedliche Steuerungspfade:

- **Vollständiger Lauf:** Analyse, Plan, manuelle Revision, explizite Ausführung und Abschlussreview.
- **Offene Frage:** Die Ausführung bleibt gesperrt, bis eine Präzisierung eine neue Planung auslöst.
- **Ausführungsfehler:** Der zweite Schritt schlägt synthetisch fehl; abhängige Knoten und der Gesamtstatus zeigen die Fehlerweitergabe.

Für den manuellen Test sollte zusätzlich geprüft werden, dass das Schließen und erneute Öffnen denselben sichtbaren Lauf zeigt, ein bearbeiteter Plan bis zum Speichern nicht ausführbar ist, ein Import nicht startet und Escape beziehungsweise Tastatureingaben im Dialog keinen Chat- oder CLI-Auftrag auslösen.

## Automatisierte Prüfung

```powershell
cd E:\projekte\luczor\app
.\scripts\with-pinned-node.ps1 -Executable pnpm -Arguments @('test:planning')
```

Die fokussierten Tests prüfen Controller-Verträge, JSON- und DAG-Validierung, Principal- und Revisionsbindung sowie die produktive Vue-Oberfläche mit echten Klicks. Dazu gehören schmutzige Planrevisionen, offene Fragen, explizite Ausführung, Import ohne Autostart, Dialogschließen ohne Abbruch, planungsspezifische externe Freigaben und das Leeren privater Formdaten bei einem Identitätswechsel.

## Bekannte Grenzen

- Planungssitzung, DAG und Knotenausgaben leben im Renderer. Native Task-Metadaten und externe Sessionlinks können fortbestehen, es gibt aber noch kein Reattach oder Recovery einer Planungssitzung nach App-Neustart.
- Luczor erstellt aus dem Planungsfenster kein ChatGPT-Desktop-Projekt und keinen Sidebar-Task automatisch.
- Lokale und richtliniengesteuerte Planer können ohne explizit bereitgestellten Projektkontext keine echten Datei- oder Toolbelege liefern.
- Das Browserlabor belegt die Steuerungslogik mit synthetischen Adaptern. Es ist kein Nachweis für einen realen Provider, native Dateieffekte oder die fachliche Qualität eines Modells.
- Ein interaktiver Smoke-Test der Planungsoberfläche in der nativen Windows-App ist noch auszuführen.
