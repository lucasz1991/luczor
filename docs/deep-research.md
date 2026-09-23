# Deep Research im Chat

## Bedienung

Im Hauptchat `/research deep <Thema>` senden oder im Werkzeugmenü **Recherche · /research deep** wählen und ein Thema ergänzen. `/research <Thema>` startet denselben Rechercheablauf. Der Modus **Handeln** und ein verfügbares lokales Modell sind erforderlich; die Browser-Vorschau führt keine echte Recherche aus.

Die Freigabe nennt den tatsächlichen Ausgabeordner und umfasst die vorgesehenen Recherchewerkzeuge sowie erforderliche Downloads. Ein gebundener Projektordner verwendet `research/<Datum-Thema-Laufkennung>/`; freie Chats und Projekte ohne Ordner verwenden standardmäßig den Dokumentenordner unter `Luczor/Research/`. **Rechercheordner wählen** im Werkzeugmenü setzt einen anderen zentralen Ort für neue Läufe. Bestehende Freigaben für Terminal und weitere Aktionen bleiben wirksam.

Die Karte im Chat zeigt Plan, Phase, Quellen, Dateien und Hindernisse. **Pausieren** erhält den Arbeitsstand; **Fortsetzen** prüft Freigaben, Bindungen und gespeicherte Dateien erneut. **Stoppen** beendet den Lauf; Dateien bleiben erhalten. **Bericht öffnen** und **Ordner öffnen** öffnen die lokal gespeicherten Ergebnisse. Nach einem Neustart werden offene Läufe pausiert angezeigt und benötigen eine bewusste Fortsetzung.

Bei pausierten oder blockierten Läufen kann **Ergänzung zur Recherche** fehlende Angaben oder eine präzisierte Fragestellung aufnehmen. **Fortsetzen** plant dann im selben Rechercheordner neu; vorhandene Quellen und Dateien bleiben erhalten. Ergänzungen heben keine Freigaben oder Sperren für unklare Werkzeugwirkungen auf.

Es gibt kein Gesamtlimit für Zeit, Tokens oder Werkzeugaufrufe. Einzelne Modellabschnitte, Werkzeugaufrufe und Dokumentlesevorgänge bleiben begrenzt. Drei Abschnitte ohne neue beobachtete Belege, Quellenabdeckung oder bestätigte Aussagen stoppen die automatische Fortsetzung mit einem offenen Zwischenstand. Wiederholte Texte, neue Kennungen für dieselbe Quelle oder wechselnde erfolglose Prüfungen zählen nicht als Fortschritt.

Auch eine umfangreiche Quellenprüfung kann sich über mehrere Abschnitte erstrecken. Verifizierte Lesequittungen werden gespeichert und zählen als Fortschritt, solange der geprüfte Inhalt und Auftrag unverändert bleiben. Nach einer Unterbrechung setzt die gesonderte Prüfung mit diesem Stand fort.

## Ablauf und Abschluss

1. Kernfragen und Suchplan festlegen.
2. Quellen suchen, tatsächlich lesen und benötigte Dateien herunterladen.
3. Aussagen mit gespeicherten Quellenabschnitten verknüpfen.
4. In einer gesonderten Prüfung jeden zitierten Abschnitt erneut lesen, Aussagen prüfen, Aktualität bewerten und Widersprüche klären.
5. Bericht schreiben, Dateien zurücklesen und Hashwerte prüfen; erst danach den Lauf abschließen.

Suchtreffer, ungelesene Downloads und Teilagenten-Antworten sind keine gelesenen Quellen. Quellen enthalten die beobachtete URL, Titel, Abrufzeitpunkt, Inhaltsnachweis und gelesene Abschnitte; Veröffentlichungsdatum, Aktualisierungsdatum und Herausgeber bleiben unbekannt, wenn sie nicht beobachtet wurden. Ein aktuelles Abrufdatum macht einen alten Inhalt nicht automatisch aktuell.

Ein Abschluss verlangt Antworten auf alle Kernfragen, belegte und unabhängig geprüfte Aussagen, erfüllte Aktualitätsanforderungen und verifiziert gespeicherte Berichte. Offene Kernfragen erzeugen einen Zwischenbericht. Die Prüfung sichert Quellenzuordnung und kontrollierten Ablauf; die inhaltliche Beurteilung bleibt eine Modellprüfung und keine Wahrheitsgarantie.

## Dateien und technische Einbindung

- `bericht.md` und `bericht.html`: lesbarer Bericht mit Aussagen, Belegen, Quellen und offenen Punkten.
- `quellen.json`: Quellenverzeichnis mit tatsächlich gelesenen Abschnitten.
- `recherche.json`: öffentlicher Rechercheplan und Berichtsstand, ohne Kontobindung, Werkzeugtranskript oder technische Fortsetzungsdaten.
- `downloads/` und `belege/`: benötigte Originaldateien und gespeicherte Quellenauszüge.

`src/services/research/service.ts` bindet den festen Ablauf an den vorhandenen Agenten und seine Ausführungsfreigaben. `controller.ts` kontrolliert Phasen, Fortsetzung, Pausen und Fortschritt; `store.ts` speichert den Arbeitsstand im bestehenden verschlüsselten Run-Archiv. Quellenprüfung und Berichtserzeugung liegen in `evidence.ts` und `report.ts`; native Ordner- und Dateizugriffe in `src-tauri/src/commands/research.rs` bleiben an Konto, Chat, Lauf und Zielordner gebunden.

Interner Browser, Terminal und freigegebene Werkzeuge laufen über die vorhandenen Ausführungs-, Ressourcen- und Not-Aus-Regeln. Die Recherche verwendet das lokale Modell. Webseiten und heruntergeladene Inhalte werden als untrusted Daten behandelt. Die HTML-Ausgabe enthält keine ausführbaren Modell- oder Seitenelemente.

## Grenzen und Wiederaufnahme

PDFs mit extrahierbarem Text sowie TXT, CSV und JSON werden abschnittsweise gelesen. Bildbasierte PDFs ohne auslesbaren Text erzeugen keinen Textbeleg; geschützte oder nicht lesbare Dateien bleiben als Hindernis sichtbar. Begrenzte Lesevorgänge zeigen ihre Teilabdeckung ausdrücklich.

Geänderte Dateien, ein anderer Projektordner oder ein Kontowechsel erlauben keine ungeprüfte Wiederaufnahme. Allgemeine Werkzeugaktionen mit unklarem Ausgang, etwa ein unterbrochener Terminalbefehl, müssen vor Wiederholung abgeglichen werden. Wird ein ephemerer Werkzeugkontext verworfen, bleibt hierfür ein Hinweis ohne sensible Argumente im Archiv erhalten. Die vier eingeschränkten Rechercheadapter besitzen einen gesondert geprüften Wiederholungsweg.

Eine geschlossene App recherchiert nicht weiter. Veröffentlichte Webseiten können sich nach dem dokumentierten Berichtsstand ändern. Dateien im Ausgabeordner unterliegen den bereits vorhandenen Synchronisierungseinstellungen dieses Ordners.

## Prüfung

Die fokussierten Tests unter `tests/unit/research*.test.ts` prüfen Quellen- und Abschnittsbezüge, Datumsbewertung, unabhängige Lesequittungen, sichere Berichte, Fortschrittsschleifen, Pausen und Stopps, Kontowechsel, Archivierung, Download-/Dokumentadapter und den Ablauf im Service. Native Prüfungen decken Ordnerbindung und tatsächliche Dateioperationen ab.

Die lokale Seite `/tests/fixtures/research-card.html` enthält ausschließlich **UI-Testdaten** und die echte Karte mit App-Styles. Bei 390 Pixeln und Desktopbreite beide Themes, lange Pfade, aufklappbare Details, Tastaturfokus sowie Pause/Fortsetzen/Stoppen prüfen. Sie ersetzt keine native Abnahme.

Zur Desktop-Abnahme eine öffentliche Primärquelle und ein benötigtes Dokument recherchieren, Quellen und lokale Dateien prüfen, anschließend Pause/Fortsetzen sowie App-Neustart erproben. Eine unbelegte Kernfrage, eine geänderte Datei, ein unterbrochener allgemeiner Werkzeugeffekt und Not-Aus müssen den Abschluss zuverlässig verhindern. Nach einem echten Modelllauf den Bericht gegen die gespeicherten Fundstellen kontrollieren; reine Builds, Fixtures und Adaptertests belegen diesen vollständigen Weg nicht.
