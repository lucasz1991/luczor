# Spracheingabe am Eingabefeld

Im Hauptchat und Mini-Chat öffnet **Sprache** die Einstellungen direkt am jeweiligen Eingabefeld. **Speichern & starten** übernimmt die Einstellungen und startet die lokale Erkennung. Das Mikrofon öffnet sich erst nach diesem Klick und der lokalen Bereitschaftsprüfung. Whisper und ein mehrsprachiges Modell einschließlich Deutsch werden mit der App installiert. Eine separate Whisper-/Python-Installation oder Anmeldung am Sprachserver ist für das Diktieren nicht erforderlich.

## Fortlaufende Erkennung

Während des Zuhörens erscheinen erkannte Wörter und Sätze bereits als Vorschau im Eingabefeld. Die Erkennung verarbeitet kurze, wachsende Audioabschnitte; sie wartet nicht auf das Ende des gesamten Diktats. Eine Vorschau darf noch korrigiert werden. Sprechpausen und **Aufnahme stoppen** lassen bereits erkannte Wörter sichtbar, während der letzte Abschnitt bestätigt wird. Das Modell bleibt zwischen Abschnitten geladen. Die Geschwindigkeit hängt vom Gerät ab; dies ist keine garantierte Erkennung jedes einzelnen Wortes ohne Verzögerung.

Bei älteren Installationen die vollständige aktuelle App installieren. Falls Sprachdateien fehlen oder beschädigt sind, wird die Erkennung nicht als bereit gemeldet. Mikrofonberechtigungen werden weiterhin vom Betriebssystem verwaltet.

## Steuerwörter oder eigene Audioaufnahmen

Textmodus: Wake-Word und Close-Word eingeben. Standard: `luczor` und `luczor stopp`. Bekannte Schreibweisen des Produktnamens werden normalisiert.

Audiomodus:

1. Bei **Audio-Startwort** auf **Aufnehmen** klicken, ein kurzes Wort oder eine Phrase deutlich sprechen und **Aufnahme beenden** wählen. Nach fünf Sekunden endet die Aufnahme automatisch.
2. Ein deutlich anderes **Audio-Stoppwort** genauso aufnehmen. Über die Audioplayer lassen sich die Aufnahmen anhören und über **Löschen** entfernen.
3. Mit **Probe erkennen** eine neue Aussprache überprüfen. Eine Probe speichert kein neues Muster und sendet keine Nachricht.
4. **Aufgenommene Audio-Auslöser statt Textwörter verwenden** einschalten, Abschlussverhalten auswählen und **Speichern & starten** klicken.

Die Referenzaufnahmen werden unmittelbar lokal in `luczor.audio-triggers.json` gespeichert. Sie werden nicht an einen Sprachserver übertragen. Löschen einer Referenz schaltet den Audiomodus ab.

Audio-Auslöser einzeln sprechen und anschließend kurz pausieren. Nach dem Startwort auf den sichtbaren Diktatstatus warten, dann den Auftrag diktieren. Das Stoppwort ebenfalls nach einer kurzen Pause einzeln sprechen. Der direkte Audioabgleich ersetzt in diesem Modus das Lesen der Steuerwörter aus dem Whisper-Text. Whisper erkennt anschließend weiterhin den eigentlichen Auftrag.

Der Abgleich verwendet lokale MFCC-Klangmerkmale und zeitliche Ausrichtung mit DTW. Er ist ein Vergleich mit einer persönlichen Referenzaufnahme, kein trainiertes allgemeines Wake-Word-Modell und keine Sprecher-Authentifizierung. Mikrofon, Raum, Abstand und Aussprache können die Trefferquote beeinflussen. Daher beide Wörter unter den tatsächlichen Bedingungen mit **Probe erkennen** prüfen; bessere Erkennung als im Textmodus ist nicht pauschal garantiert.

## Abschluss und Senden

- **Close-Word oder Sprechpause:** Beide Wege beenden das Diktat.
- **Nur Close-Word:** Pausen schließen nichts ab.
- **Nur Sprechpause:** Das Stoppwort ist kein Steuersignal; der Timer schließt ab.

Die Wartezeit von 1 bis 30 Sekunden gilt auch nach dem Wake-Word. Sie läuft erst ab, wenn Sprache und ausstehende Erkennung abgeschlossen sind. Ein leeres, versehentlich aktiviertes Diktat fällt nach Ablauf wieder in den Wartezustand zurück.

Ein bestätigtes Close-Word sendet den vorhandenen Eingabetext. Bei einer Sprechpause bleibt der Text standardmäßig zum Prüfen stehen. **Nach Sprechpause automatisch senden** ist eine separate Option und gilt nur für vollständig diktierten Text. Nach Abschluss wartet der Wake-Word-Modus erneut auf sein Startsignal.

Manuelle Aufnahme wird über den Mikrofonbutton begonnen und beendet, ohne automatisch zu senden. Tippen stoppt das laufende Diktat. Haupt- und Mini-Chat beanspruchen das Mikrofon gegenseitig exklusiv; das aktive Feld erhält die Vorschau. Vorlesen und laufende Anfragen pausieren die Erkennung.

## Prüfstand vom 8. September 2026

- Native lokale Whisper-CLI mit synthetischem deutschen Satz erfolgreich ausgeführt.
- Akustischer Vergleich mit separat synthetisiertem Startwort, veränderter Lautstärke und negativen Phrasen getestet.
- Echter WebAudio-Aufnahmeweg im Browser mit ausdrücklich synthetischer Mikrofonquelle: beide Aufnahmen speichern, wieder öffnen, einschalten, passende und abweichende Probe, Wartezeit speichern/starten.
- Haupt- und Mini-Dialog bei 320 Pixel Breite geprüft.
- Aufnahme und Erkennungsquote mit der echten Stimme des Nutzers und dessen Mikrofon stehen noch aus.
