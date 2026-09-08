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

Auch unvollständige strukturierte Antworten werden fortlaufend dargestellt: Antworttext, offene Codeblöcke, Rückfragen und Listenpunkte erscheinen bereits während ihrer Übertragung. Auswahlaktionen einer Rückfrage werden erst mit der fertigen Antwort bedienbar.

Öffentliche Zwischenkommentare erhalten pro Modellrunde einen eigenen Eintrag oberhalb der Antwort. Neue Modellrunden und die abschließende Antwort überschreiben diese Einträge nicht. Im Hauptchat werden Kommentare und Arbeitsschritte mit dem Beitrag gespeichert und nach einem Neustart wieder angezeigt. Arbeitsschritte bleiben standardmäßig aufgeklappt; manuelles Einklappen blendet die Kommentare nicht aus. Unterbrochene gespeicherte Abläufe werden beim Laden als abgebrochen abgeschlossen, ohne sichtbaren Teiltext zu entfernen. Der Mini-Chat behält seine bisherige temporäre und begrenzte Speicherung.

Bei aktiviertem automatischem Vorlesen im Hauptchat laufen kurze Statushinweise, fertiggestellte öffentliche Zwischenkommentare und die abschließende Antwort durch dieselbe Warteschlange. Dadurch unterbrechen sie einander nicht. Vor jedem Eintrag werden Einstellung, aktuelle Sitzung und die Freigabe für Server-Sprachausgabe erneut geprüft. „Vorlesen stoppen“, ein Chat-/Projektwechsel oder eine Änderung der Voice-Einstellungen beenden die laufende Ausgabe und leeren die Warteschlange.

Seit 7. September 2026 gibt es unter **Einstellungen → Chat → Auch lokale Inhalte zum Vorlesen freigeben** eine getrennte, widerrufbare Freigabe. Ohne diese Freigabe bleiben Texte aus lokalen Datei-/Memory-Zugriffen für den Sprachserver gesperrt; eine sichtbare Meldung erklärt das Überspringen. Mit Freigabe dürfen die fertigen sichtbaren Kommentare und Antworten vorgelesen werden. Ihre lokale Speicher-/Sync-Klassifikation bleibt erhalten. Unfertige Texte und interne Reasoning-Felder werden dadurch nicht freigegeben. Die Freigabe wird in `luczor.speech-consent.json` an Server und Client gebunden gespeichert; ein über die Einstellungen vorgenommener Server-/Kontowechsel setzt sie zurück. Für den aktuellen Arbeitsplatz wurde sie auf ausdrückliche Zustimmung aktiviert.

Während des Vorlesens zeigt der jeweilige Kommentar oder die Antwort den gesprochenen Text mit einer Markierung des aktuellen Wortes. Bereits gelesene Wörter sind dezenter dargestellt. Vorbereitung und Audiopausen haben eigene Statusanzeigen; nach Stoppen oder Abschluss erscheint wieder die normale Nachrichtendarstellung. Die Markierung folgt der tatsächlichen Audioposition jedes Satzes. Wie beim RailTime-Chatbot ist die Wortzuordnung näherungsweise, da der verwendete WAV-Vertrag keine Wortzeitstempel liefert; dies wird in der Oberfläche angezeigt.

Seit der Optimierung vom 7. September 2026 wird eine normale mehrsätzige Ausgabe vollständig in einer Serveranfrage vorbereitet und als zusammenhängende Audiodatei abgespielt. Satzzeichen erzeugen keine einzelnen Clips und damit keine künstlichen Pausen mehr. Nur wenn der Text die Servergrenze von 4.000 Zeichen überschreitet, teilt Luczor ihn an einer Wortgrenze in möglichst große Abschnitte. Die Wortmarkierung wird proportional zur echten Laufzeit der jeweiligen zusammenhängenden Audiodatei geführt.

Wird mit Maus oder Tastatur ein Teil einer Antwort einschließlich Zwischenkommentaren markiert, erscheint in der vorhandenen Auswahlleiste **Auswahl vorlesen**. Diese Aktion liest genau die markierte Passage einmal vor, entfernt danach die Markierung und nutzt dieselbe widerrufbare Freigabe für lokale Inhalte. Die übrigen Auswahlaktionen bleiben erhalten.

Die Freigabe **Fallback** sitzt als kompakter Schalter in der oberen Leiste des Eingabefelds neben **Agenten**. Sie erlaubt weiterhin nur einen externen Wechsel nach der bestehenden ausdrücklichen Paketfreigabe. Die beiden allgemeinen Hinweiszeilen unter dem Eingabefeld wurden auf Nutzerwunsch entfernt; zugängliche Beschriftungen und Tooltips bleiben vorhanden.

Der zugehörige Windows-Release liegt unter `src-tauri/target/release/tauri-app.exe` (14.625.280 Bytes, SHA256 `34359240E360022639C852C23A8EA38190BB9A99C819A750B134B6EF3827FD72`). Die während der Entwicklung laufende Debug-App wurde nicht beendet; für den sicheren Wechsel die laufende App schließen und anschließend diesen Release starten.

Strukturierte private Reasoning-Felder, Denk-Tags und bekannte interne Arbeitsnotizpräfixe werden nicht angezeigt. Beliebige falsch einsortierte Modelltexte lassen sich damit nicht semantisch vollständig erkennen.

Der Tokenzähler zeigt Eingabe, Ausgabe und Summe über sämtliche Modellrunden einer Antwort. Live-Schätzungen sind gekennzeichnet; gemeldete Runtime-/Providerwerte ersetzen sie am Abschluss. Fehlende Teilwerte bleiben als gemischt/geschätzt erkennbar. Das Kontextfenster ist die Kapazität und wird nicht zum Verbrauch addiert. Gemeldete Ausgabetokens können modellinterne Generierung einschließen.

Abbruch stoppt weitere UI-Updates. Hauptchatwerte bleiben beim gespeicherten Beitrag, Mini-Werte bleiben temporär. Alte Beiträge ohne Zählwerte erhalten keine erfundenen rückwirkenden Zahlen.

## Projektziele und Checklisten

Projektziele und die aktuelle Checkliste sitzen absolut positioniert oben über dem Chat. Beide Bereiche starten eingeklappt und lassen sich unabhängig öffnen und schließen. Aufklappen verändert weder die Position der Nachrichten noch den Eingabebereich. Lange Inhalte scrollen innerhalb des jeweiligen Bereichs; die Bedienelemente bleiben auch beim Scrollen des Chats oben erreichbar. Escape schließt die Bereiche und setzt den Fokus zurück auf den zugehörigen Schalter. Ein Projektwechsel klappt beide Bereiche wieder ein.

## Bereitgestellter Stand

Die Grundbefüllung wurde zuerst in der vorhandenen lokalen SQLite-Testinstanz geprüft: 1 Persönlichkeit und 3 Skills, beim zweiten Lauf 0 und 0.

Am 6. September 2026 wurde die Produktions-Admin-App auf ausdrücklichen Auftrag über Plesk veröffentlicht (Backend-Commit `d49abf0`). Dort sind jetzt „Luczor – klar und freundlich“ und alle drei Skills aktiv. Der zweite Befüllungslauf blieb unverändert. Profil und Bootstrap wurden mit Authentifizierung über echtes HTTPS erfolgreich geprüft; das Modellmanifest behält Version `2026090602` und 32768 Kontexttokens.

Streaming, Tokenzähler und der lokale Modellstatus benötigen den neu gebauten Desktop-Build. Die zuvor laufende Debug-App wurde durch den Serverrollout nicht beendet.

Die Erweiterung für dauerhafte Zwischenkommentare, geordnetes Vorlesen und die Projektbereiche wurde am 6. September 2026 separat als Windows-Debug-Testbuild erstellt: `src-tauri/target/debug/tauri-app.exe`. Die parallel laufende Release-App sperrte ihre ausführbare Datei und wurde nicht beendet. Die neuen Änderungen sind daher erst nach dem Wechsel auf den Testbuild aktiv. Es erfolgte für diese Erweiterung kein weiterer Serverrollout.

Prüfstand dieser Erweiterung: 1.002 Frontendtests bestanden; nach der letzten Wiederherstellungsanpassung zusätzlich 62 gezielte Tests. Typecheck, ESLint, Prettier und der native Debugbuild bestanden. Die Browser-Fixtures prüfen sichtbare Teiltexte, erhaltene Kommentare, Vorlesereihenfolge mit simuliertem Sprecher sowie die Projektbereiche bei 1280 und 320 Pixel Breite. Eine echte Audioausgabe und neue Modellinferenz wurden in diesem Prüfschritt nicht durchgeführt.

## Technische Einstiegspunkte

### Ergänzung vom 7. September 2026: V2-Stimmen und Vorlesemarkierung

Unter **Einstellungen → Sprache → Vorlesestimme** stehen die für Luczor freigegebenen Stimmen des Servers zur Auswahl: Benni, Jürgen, Alba und Javert (V2), zusätzlich Piper als bisherige Standardstimme. **Sprachausgabe testen** spielt die aktuelle Auswahl sofort; **Speichern** übernimmt sie für Antworten und Zwischenkommentare. Die Auswahl bleibt beim Neustart erhalten; ein gespeicherter Server-/Kontowechsel setzt sie zurück. Nicht verfügbare Stimmen werden angezeigt und nicht still durch eine andere ersetzt.

Der Desktop lädt den authentifizierten Katalog über `GET /api/v1/voice/voices` und sendet die gewählte `voice_id` an den bisherigen Luczor-TTS-Endpunkt. Das Backend verwendet dafür `/v2/speech`; ohne V2-Auswahl bleibt `/v1/speech` aktiv. V2 liefert pro Sprachabschnitt WAV bei Servertempo 1; das eingestellte Tempo wird am Audioplayer angewandt. Diese Erweiterung verwendet keinen NDJSON-Audiostream und liefert keine exakten Wortzeitstempel.

Backend `a00d2cb` wurde mit privatem Backup über Plesk veröffentlicht. Live bestätigt: Katalog mit fünf Stimmen, Benni- und Piper-WAV, fehlende Authentifizierung 401, unbekannte Stimme 422, Health/Ready und Produktionsprüfung erfolgreich. Umgebung, vorhandene Webassets und Server-Paketlock blieben erhalten. Keine Migration oder Änderung am gemeinsamen Sprachmodell.

Neuer Windows-Release vom 7. September 2026: `src-tauri/target/release/tauri-app.exe` (14.590.464 Bytes, SHA256 `8CE0F4E164B47C7C4FA91349176688CE92C04001412DCBE969786DDD805EB232`). Die vorher laufende Debug-App blieb geöffnet. Zur Nutzung diese schließen und den neuen Release starten. Geprüft: 1.083 Frontendtests plus zwei zusätzliche Settings-Regressionen (sieben Settings-Tests im Nachlauf), 508 Backendtests, Typecheck/Lint/Format und nativer Releasebuild. Echte Server-Synthese und Browser-Audiowiedergabe mit Wortmarkierung sind geprüft; neue native Modell-/Mikrofonaufträge wurden nicht ausgeführt.

- API: GET /api/v1/assistant-profile mit settings.read; bootstrap.assistant_profile enthält dasselbe Schema.
- Backend: AssistantDefaultsService, AssistantProfileService, PrepareAssistantDefaults.
- Client: assistantProfile.ts, assistantProfileDraft.json, LocalModelStatus.vue, TokenCounter.vue.
- Reproduzierbare UI-Fixture: tests/fixtures/assistant-stream.html. Nur synthetische Daten, kein Modellzugriff.
- Kommentar-/Stream-Fixture: tests/fixtures/conversation-continuity.html; Projektbereiche: tests/fixtures/project-overlay.html. Beide verwenden synthetische Daten und die tatsächlichen UI-Komponenten.
- Kommentarablage und Vorlesewarteschlange: chatCommentary.ts, voice/commentarySpeech.ts; Projektbereiche: ChatProjectOverlay.vue.
- Wortmarkierung und Freigabe: voice/readAlong.ts, voice/speechConsent.ts, ReadAloudText.vue. Prüfansicht: tests/fixtures/read-aloud.html; mit zwei synthetischen WAV-Dateien aus dem beschriebenen Server-Smoke.

Die Zähldaten folgen dem Usage-Format der [llama.cpp-Serverimplementierung](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-common.cpp).
