# Zwischenkommentare vorlesen und Wortmarkierung

## Auftrag und bestätigte Ursache

Zwischenkommentare blieben sichtbar, wurden aber nach lokalen Werkzeugzugriffen nicht vorgelesen. Im gespeicherten Verlauf stehen die kommentierten Runden 2 bis 6 mit serverSpeechAllowed=false. Der bisherige serverSpeechText-Filter gab für diese Einträge leeren Text zurück; die Warteschlange übersprang sie still.

Am 7. September 2026 hat der Nutzer ausdrücklich zugestimmt, Kommentare und Antworten aus lokalen Datei-/Memory-Zugriffen zum aktivierten Vorlesen an den eingerichteten Sprachserver zu senden. Diese Zustimmung betrifft die Sprachausgabe, nicht Synchronisierung oder Modellprovider.

## Änderung

- Separate Vorlesefreigabe in Einstellungen → Chat. Standard ohne Zustimmung bleibt false. Zustimmung wird in luczor.speech-consent.json an die konfigurierte Server-URL und Clientkennung gebunden gespeichert. Für diesen Arbeitsplatz wurde ausschließlich diese neue Datei angelegt; die von der laufenden App verwendete allgemeine Settings-Datei blieb unverändert. Ein Server-/Kontowechsel über die Einstellungen setzt die Zustimmung zurück.
- Queue und manuelles Vorlesen prüfen die aktuelle Zustimmung. Nur fertige sichtbare Nachrichten/Kommentare dürfen die Ausnahme nutzen. Ihre ephemeral/serverSpeechAllowed-Klassifikation bleibt unverändert. Widerruf, Voice-Einstellungswechsel und Abbruch stoppen die bestehende Warteschlange. Fehlende Freigabe wird sichtbar erklärt.
- Eigene Wiedergabeidentität für jeden Kommentar und die Antwort. ReadAloudText markiert das aktuelle Wort im gerade gesprochenen Text, zeigt gelesene Wörter dezenter und unterscheidet Vorbereitung, Wiedergabe und Audiopause. Normale Nachrichtendarstellung kehrt beim Abschluss/Stoppen zurück.
- Timing nutzt currentTime/duration des tatsächlichen HTMLAudioElement, satzweise mit Textoffsets. requestAnimationFrame zeichnet flüssig; timeupdate/durationchange bleiben zusätzliche Ereignisquellen. Wartende und abgebrochene Wiedergabe beendet die Markierung; alte Callbacks können eine neue Ausgabe nicht verändern. Der Zustand bleibt flüchtig und wird nicht protokolliert oder gespeichert.
- Referenz ausschließlich gelesen: C:/xampp/htdocs/RailTime/App/resources/js/chatbot.js (ttsTokenState/playAudioUrl) sowie die Speech-Token-Darstellung in resources/views/livewire/tools/chatbot.blade.php. Wie dort ist die Wortzuordnung aus dem Audiotakt näherungsweise. Der verwendete WAV-Vertrag liefert keine exakten Wortzeitstempel; die Oberfläche bezeichnet dies ausdrücklich.

## Prüfung

- Zwei echte HTTPS-Anfragen an den konfigurierten Luczor-Sprachserver mit dem vorhandenen geschützten Device-Key und ausschließlich synthetischen Sätzen: beide HTTP200, gültiges WAV; 67.628 Bytes/1,533 Sekunden und 75.308 Bytes/1,707 Sekunden. Keine Schlüssel oder Request-Header im Report. Reproduzierbares Skript und secret-freier Ergebnisreport unter artifacts/temp/read-aloud/.
- Browser-Fixture benutzt diese WAV-Dateien mit echter HTMLAudioElement-Wiedergabe, der produktiven streamSpeak-Funktion, Queue und UI. IPC/Netzwerk sind auf synthetische Fixturewerte ersetzt. Beobachtet: lokaler Kommentar vor finaler lokaler Antwort, markierte Wörter entlang des Audiotakts und keine Markierung nach Abschluss. Widerruf erzeugt eine verständliche Meldung und keine TTS-Anfrage.
- Feste Prüfposition markiert genau Codex-Daten. Audiopause entfernt die aktuelle Markierung; Stoppen stellt normalen Text wieder her. Der neue Einstellungs-Schalter bedient die Freigabe. 1280x720 und 320x720 geprüft; bei 320 Pixeln document.scrollWidth=320, genau ein markiertes Wort, kein horizontaler Überlauf. Browser-Konsole ohne Warnungen/Fehler. Viewport zurückgesetzt und Prüftab geschlossen.
- Maßgebliche Regressionen: lokale Zustimmung/Widerruf/abgebrochener Consent-Lookup, Settings-Destination, unveränderte Datenschutzklassifikation, echte Audiozeit einschließlich Satzwechsel/Warten/Abbruch und sichere Wortdarstellung ohne HTML-Ausführung.
- Gesamtgates: 103 Frontendtestdateien / 1.083 Tests bestanden; anschließend zwei zusätzliche Tests für geladene/gespeicherte V2-Auswahl und Rücksetzung bei Serveridentitätswechsel, alle sieben Settings-Tests bestanden. Typecheck, ESLint und Prettier bestanden, nach der letzten Fixture-/Testanpassung erneut gezielt geprüft. Backend: 508 Tests / 3.444 Assertions; Speech-Fokus 48 Tests / 199 Assertions, Pint und gezieltes PHPStan bestanden.
- Finaler nativer Releasebuild ohne Bundle erfolgreich (250 Frontendmodule, Rust 3m33s). EXE: src-tauri/target/release/tauri-app.exe, 14.590.464 Bytes, SHA256 8CE0F4E164B47C7C4FA91349176688CE92C04001412DCBE969786DDD805EB232, UTC 2026-09-07T00:06:51. Vorheriger Release unter artifacts/temp/read-aloud/tauri-app.previous-release.exe gesichert; laufende Debug-App PID95888 blieb geöffnet und antwortet.

## V2-Stimmenauswahl und Serververöffentlichung

- Zusatzauftrag aus dem angehängten TTS-Transkript: V2-Auswahl einschließlich Benni. Luczor lädt den bereinigten authentifizierten Stimmenkatalog, bietet Auswahl/Hörprobe/Speichern unter Einstellungen → Sprache und verwendet dieselbe Auswahl für Kommentare und Antworten. Piper bleibt Standard. Fehlende Stimmen werden ausdrücklich angezeigt; keine automatische Ersatzstimme.
- Backend a00d2cbbf3bb39c7a09df77750c05239ec605700 über vorhandenes Plesk-Git veröffentlicht. Private Sicherung: /var/backups/luczor-v2-voices-20260906T235931Z; Guard-Skript im Root unter .lmzdev/artifacts/scripts/2026-09-07-v2-voices-deploy.py. 536 getrackte Dateien verifiziert, .env/Server-Paketlock/Webassetmanifest unverändert, Cachemodus erhalten, Produktionsprüfung erfolgreich. HTTPS Health/Ready beide ok.
- Echter HTTPS-Katalog enthält piper, alba, benni, javert, juergen und ausschließlich id/name/provider/language. Echte Benni-Synthese mit synthetischem Text: HTTP200, 65.324 Bytes, 1,360 Sekunden WAV. Piper erneut erfolgreich. Ohne Authentifizierung 401; synthetische unbekannte Stimme 422. Ergebnisse unter artifacts/temp/read-aloud/server-smoke.json. Keine geheimen Schlüssel im Bericht.
- Browser: echte VoiceSettingsSection mit produktiven Settings-Styles, synthetischem Katalog und tatsächlichem Benni-WAV. Auswahl Benni, echte HTMLAudioElement-Wiedergabe und Abschluss beobachtet; Servertempo 1, Clienttempo 1,25. Leerer Katalog behält die fehlende Auswahl und deaktiviert die Hörprobe. 320 Pixel ohne Überlauf; Desktopansicht geprüft; keine Konsolenwarnungen/-fehler. Prüftab geschlossen, Viewport zurückgesetzt, eigener Vite1444 beendet.
- WAV je Satz erhält die bestehende Queue und Markierung. NDJSON/PCM-Streaming des Sprachdiensts ist nicht Bestandteil der Stimmenauswahl. V2-Servertempo bleibt 1, die gewünschte Sprechgeschwindigkeit wird am Player gesetzt.

## Grenzen

- Die Wortposition ist eine Schätzung innerhalb jedes Satzes, keine phonetisch exakte Ausrichtung.
- Echte Server-Synthese und echte Browser-Audiowiedergabe sind geprüft. Ein neuer nativer Modellauftrag mit privaten Werkzeugdaten wurde nicht ausgeführt; es wurden keine echten Datei-/Memory-Texte zum Sprachtest hochgeladen.
- Bestehende parallele Mini-, Agenten-, Toollimit- und native Änderungen wurden erhalten. Keine eigenen Ruständerungen. Desktopstand bleibt uncommittet; Backend-Stimmenerweiterung ist mit a00d2cb veröffentlicht. Spätere parallele Backend-Agententeamänderungen sind nicht Teil dieses geprüften Deployments.

API-Referenz für den Audiotakt: [MDN timeupdate](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/timeupdate_event).

## Nachoptimierung: flüssige Gesamtausgabe und markierte Auswahl

- Die vorherige Aufteilung an jedem Satzzeichen erzeugte je Satz eine eigene Synthese und Audiodatei. Das war die konkrete Ursache der hörbaren Pausen. Die Aufteilung erfolgt jetzt nur noch bei Überschreitung des 4.000-Zeichen-Serverlimits; normale mehrsätzige Antworten werden einmal vollständig synthetisiert und zusammenhängend abgespielt.
- Die vorhandene Auswahlleiste für Antworten umfasst nun auch Zwischenkommentare. Sie bietet **Auswahl vorlesen**, übergibt ausschließlich die markierte Passage, löscht die Markierung nach einmaliger Auslösung und nutzt die bestehende lokale TTS-Freigabe. Die globale Vorleseanzeige zeigt dabei Auswahltext, Status und näherungsweise aktuelle Wortposition.
- Der Fallback-Schalter ist in die obere Prompt-Control-Zeile neben den Agentenmodus gezogen. Seine bestehende Freigabegrenze bleibt erhalten. Auf direktes Browserfeedback wurden beide Hilfetexte unter dem Composer entfernt und Kopf-/Aktionszeile leicht verkleinert.
- Echter Server-Smoke: eine mehrsätzige Benni-Ausgabe als einzelne WAV-Datei, 426.284 Bytes / 8,880 Sekunden; eine synthetische Auswahl-WAV 126.764 Bytes / 2,640 Sekunden. Browser mit echten WAVs bestätigt: Gesamtausgabe genau eine Anfrage, wandernde Wortmarkierung, markierte Auswahl erzeugt genau eine eigene Anfrage, Auswahlleiste verschwindet danach. Fallback-Control schaltet sichtbar. Desktop 1096px und Mobil 320px ohne horizontalen Überlauf; Hinweise entfernt.
- Regression: 113 Testdateien / 1.246 Tests, Typecheck, ESLint, Prettier und fokussierter Diffcheck bestanden. Finaler nativer Releasebuild ohne Bundle erfolgreich: `src-tauri/target/release/tauri-app.exe`, 14.625.280 Bytes, SHA256 `34359240E360022639C852C23A8EA38190BB9A99C819A750B134B6EF3827FD72`, UTC 2026-09-07T18:55:37. Laufende Debug-App PID114596 blieb geöffnet und reagiert.
