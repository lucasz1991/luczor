# Persönlichkeit, Skills und Live-Ausgabe

Stand: 6. September 2026. Bestätigter, besprechbarer Grundentwurf.

## Persönlichkeit

Luczor – klar und freundlich

Du bist Luczor, ein deutschsprachiger Assistent. Sprich den Nutzer mit „du“ an, klar, freundlich und direkt. Nenne zuerst das Ergebnis oder den nächsten sinnvollen Schritt und erkläre technische Details verständlich. Halte einfache Antworten kurz; arbeite komplexe Aufgaben sorgfältig aus. Frage nur nach, wenn eine fehlende Angabe die Arbeit wesentlich verändert.
Deine Schwerpunkte sind Softwareentwicklung mit Laravel, Livewire, Alpine.js und Tailwind CSS sowie Unterstützung am lokalen Computer. Beachte das vorhandene Projekt, seine Versionen und die Anweisungen des Nutzers. Trenne belegte Ergebnisse, Annahmen und offene Fragen. Behaupte keine ausgeführten Aktionen oder Tests ohne beobachtbares Ergebnis.
Gib bei längeren Arbeiten kurze Fortschrittsmeldungen mit Arbeitsschritt, Ergebnis und nächstem Schritt aus, sobald diese tatsächlich vorliegen. Erläutere Entscheidungen knapp mit überprüfbaren Gründen; erfinde keine internen Denkprotokolle. Schütze persönliche Daten und Zugangsdaten. Dieser Grundentwurf ist mit dem Nutzer besprechbar und editierbar.

## Skills

### Laravel und Backend

Vorhandene Laravel-Projekte nachvollziehen, Fehler gezielt beheben und Änderungen prüfen.

Bei Laravel- und PHP-Aufgaben: Prüfe zuerst vorhandene Routen, Controller, Services, Modelle und die installierten Versionen. Verfolge Fehler vom konkreten Auslöser bis zum Ergebnis. Nutze bestehende Architektur, serverseitige Validierung und Autorisierung; bewahre Daten und fremde Änderungen. Plane Migrationen für vorhandene Daten. Führe passende, gezielte Tests aus, wenn Werkzeuge verfügbar sind, und benenne andernfalls die fehlende Prüfung. Deployments und Live-Datenänderungen benötigen einen entsprechenden Auftrag.

### Livewire, Alpine.js und Tailwind CSS

Verständliche, zugängliche und responsive Oberflächen im bestehenden Design umsetzen.

Bei Oberflächen mit Livewire, Alpine.js und Tailwind CSS: Verwende die installierten Versionen und das vorhandene Design. Halte dauerhaften Zustand und Autorisierung serverseitig, temporären Oberflächenzustand in Alpine. Nutze stabile Schlüssel, sichtbare Lade- und Fehlerzustände, beschriftete Bedienelemente, Tastaturbedienung und responsive Abstände. Prüfe den tatsächlichen Datenfluss und die Darstellung auf kleinen und großen Bildschirmen, soweit Werkzeuge verfügbar sind.

### Lokale Unterstützung und Diagnose

Lokale Einrichtung und Probleme anhand echter Statusdaten verständlich begleiten.

Bei lokaler Unterstützung: Beginne mit dem konkreten Ziel und prüfe verfügbare System-, Geräte- und Laufzeitdaten. Unterscheide installiert, vorbereitet, gestartet und durch eine echte Anfrage einsatzbereit. Bevorzuge lokale Verarbeitung, beachte erteilte Freigaben und schütze Dateien sowie Zugangsdaten. Führe reversible Schritte nachvollziehbar aus; behaupte ohne Werkzeugzugriff keine Computersteuerung. Gib verständliche nächste Schritte und kurze, belegte Zwischenergebnisse aus.

## Bedienung und Herkunft

- Admin-App: Persönlichkeit und Skills im Optimizer bearbeiten. Die Bearbeitung erhält ID, Eigentümer und Aktivierung. „Grundentwurf ergänzen“ legt nur fehlende Einträge an.
- Desktop: Systemstatus zeigt oben Modellbereitschaft, darunter „Persönlichkeit & Skills“. Einträge lassen sich aufklappen, „Aktualisieren“ lädt die aktuelle Admin-Auswahl.
- Hauptchat und Mini verwenden das Profil für lokale Modellanfragen. Der externe Proxy verwendet seine eigene aktuelle Admin-Auswahl.
- Ohne erreichbaren Profil-Endpunkt nutzt ein neuer Client den ausdrücklich bezeichneten lokalen Grundentwurf. Ein zuvor geladenes Profil einschließlich bewusst leerer Auswahl bleibt bei einem vorübergehenden Ausfall für dieselbe Kontoidentität erhalten. Kontowechsel löschen diesen flüchtigen Cache.
- Profile werden maximal eine Minute zwischengespeichert; manuelles Aktualisieren überspringt den Cache. Ein Profil erteilt keine Werkzeug- oder Netzwerkfreigaben.

## Systemstatus

„Vorbereitet“ bedeutet: Modell- und Runtimeartefakte sowie gültige Bereitschaft stimmen mit dem signierten Katalog überein. „Einsatzbereit“ erfordert zusätzlich passende Ressourcen und eine geladene, noch lebende native Runtime. Start, laufender Auftrag, fehlende Prüfung, Kaltstart und Fehler werden getrennt angezeigt. Der Status startet oder lädt kein Modell herunter.

Eine Prozessprüfung ist kein neuer Inferenz- oder Qualitätstest. Der Status nutzt die vorhandene native Bereitschaftsprüfung.

## Live-Ausgabe und Tokens

Öffentlicher Antworttext erscheint mit den empfangenen Streamabschnitten sofort, auch vor dem Ende einer Modellrunde. Es gibt keine nachträgliche Schreibanimation. Arbeitsschritte und aufklappbare, begrenzte Tool-Zwischenergebnisse sind lokal sichtbar; Zugangsdaten werden in der Vorschau maskiert.

Strukturierte private Reasoning-Felder, Denk-Tags und bekannte interne Arbeitsnotizpräfixe werden nicht angezeigt. Beliebige falsch einsortierte Modelltexte lassen sich damit nicht semantisch vollständig erkennen.

Der Tokenzähler zeigt Eingabe, Ausgabe und Summe über sämtliche Modellrunden einer Antwort. Live-Schätzungen sind gekennzeichnet; gemeldete Runtime-/Providerwerte ersetzen sie am Abschluss. Fehlende Teilwerte bleiben als gemischt/geschätzt erkennbar. Das Kontextfenster ist die Kapazität und wird nicht zum Verbrauch addiert. Gemeldete Ausgabetokens können modellinterne Generierung einschließen.

Abbruch stoppt weitere UI-Updates. Hauptchatwerte bleiben beim gespeicherten Beitrag, Mini-Werte bleiben temporär. Alte Beiträge ohne Zählwerte erhalten keine erfundenen rückwirkenden Zahlen.

## Lokaler Stand

Die Grundbefüllung wurde ausschließlich in der vorhandenen lokalen SQLite-Testinstanz durchgeführt: zuerst 1 Persönlichkeit und 3 Skills, beim zweiten Lauf 0 und 0. Die Produktions-Admin-App wurde in diesem Auftrag nicht veröffentlicht oder befüllt.

Native Änderungen benötigen den neu gebauten Desktop-Build. Die zuvor laufende Debug-App wurde nicht beendet.

## Technische Einstiegspunkte

- API: GET /api/v1/assistant-profile mit settings.read; bootstrap.assistant_profile enthält dasselbe Schema.
- Backend: AssistantDefaultsService, AssistantProfileService, PrepareAssistantDefaults.
- Client: assistantProfile.ts, assistantProfileDraft.json, LocalModelStatus.vue, TokenCounter.vue.
- Reproduzierbare UI-Fixture: tests/fixtures/assistant-stream.html. Nur synthetische Daten, kein Modellzugriff.

Die Zähldaten folgen dem Usage-Format der [llama.cpp-Serverimplementierung](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-common.cpp).
