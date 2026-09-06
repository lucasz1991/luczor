# Decisions

Record durable decisions with date, context, decision, and consequences.

## 2026-09-06 | Hands-free-Einstellungen sind sichtbar und Auto-Senden ist opt-in

- Context: Sichtbares `voice_mode`/Wake-Word und versteckte Hands-free-Strategy/Triggerwerte waren voneinander getrennt. Lokale STT wurde zugleich von nicht benoetigter lokaler TTS-Readiness abhaengig gemacht.
- Decision: Ein Resolver liefert UI- und Runtimewerte; alte Strategy/Triggerfelder werden ausschliesslich bei fehlenden neuen Feldern gelesen. Diktate landen standardmaessig zur Pruefung im Composer; `voice_auto_submit=true` ist eine ausdrueckliche sichtbare Option. STT-Readiness verlangt standardmaessig keinen lokalen Piper.
- Consequence: Wake-/Close-Wort, Pausenzeit und Sendepolicy lassen sich nachvollziehbar konfigurieren. Aenderungen senden einen Lifecycle-Event; die App muss alte Mikrofon-Sitzungen invalidieren und ihre Steuerung aus einem einzelnen Voice-Snapshot ableiten.

## 2026-09-06 | Beautiful UI als native Vue-Komponenten

- Context: Der Nutzer beauftragt die Uebernahme aller Beautiful-UI-Komponenten in Luczors bestehende Vue-/Tauri-App.
- Decision: Alle 21 Komponenten werden als typisierte Vue-Komponenten umgesetzt. Die MIT-Originale der Revision `06557d7ff33a1eb70d5987bae9ac4c70fa0e20c4` bleiben unveraendert unter `vendor/beautiful-ui/`, einschliesslich Lizenz und verifizierten SHA-256-Werten. React/Next und die kommerzielle Icon-Abhaengigkeit werden nicht in die Runtime aufgenommen.
- Consequence: Chat, Navigation, Eingabe, echte Statusereignisse, Freigaben, Plan, Memory-Vorschlaege und Kontext verwenden vorhandene Luczor-Datenvertraege. Alle Komponenten sind in einer getrennten, expliziten Beispielbibliothek pruefbar; generische Tabellen, Kurven und Bildschirmansichten behaupten keine fehlenden Live-Daten.

## 2026-09-06 | Fortschrittsanzeige respektiert die bestehende Ausgabekontrolle

- Context: Der Agent puffert Modelltext, damit Tool-Runden und interne Arbeitsnotizen nicht als Chatantwort erscheinen.
- Decision: Ein additiver `onProgress`-Callback liefert nur Phase, Rundennummer und Zeichenanzahl. Die UI zeigt reale Arbeitsschritte und Toolstatus; `useStreamReveal` animiert ausschliesslich freigegebenen Antworttext nach der finalen Ausgabepruefung. Status ist fluechtig und pro Antwort gespeichert.
- Consequence: Das bisherige Ausgabe- und Freigabeverhalten bleibt erhalten. Abbruch und Fehler beenden die Anzeige, spaete Ereignisse reaktivieren keine abgeschlossene Antwort. Die Bibliotheksanimation ist sichtbar als Beispieldaten gekennzeichnet.

## 2026-09-06 | Server-TTS ersetzt den lokalen Ausgabe-Default auf ausdruecklichen Auftrag

- Context: Der Nutzer hat die gemeinsame serverglobale Sprachausgabe von FollowFlow/RailTime fuer Luczor beauftragt; die fruehere Local-only-Vorgabe fuer TTS ist damit ueberholt.
- Decision: Nur die Ausgabe verwendet den authentifizierten Luczor-Proxy. Eingabe bleibt whisper.cpp-lokal; kein Piper-/OS-Ausgabe-Fallback wird automatisch versucht. Die Desktop-App kennt ausschliesslich ihren Device-Key, nicht den zentralen Dienstschluessel.
- Consequence: TTS braucht Serververbindung und Device-Key. Abbruch, Identitaetswechsel und Fehler werden explizit verarbeitet; lokale oder vertrauliche Ausgaben muessen durch den App-Aufrufer vor TTS-Egress geprueft werden.

## 2026-09-06 | Settings-Identitaet wird vor Key-Wechsel dauerhaft getrennt

- Context: Server-URL im Tauri-Store und Device-Key im nativen Schluesselspeicher lassen sich nicht gemeinsam transaktional speichern. Ein fehlgeschlagener nativer Key-Write kann den nativen Key bereits veraendert haben, waehrend der JS-Cache noch den alten Key enthaelt; ein naiver Rollback mit saveDeviceKey(old) waere dann unzureichend.
- Decision: Serialisierter Settings-Writer persistiert vor Key-Aenderungen eine nicht netzwerkfaehige, nicht leere URL (`about:blank`), leert native/cache Credentials, schreibt und verifiziert den Zielkey und publiziert erst danach die Ziel-URL. Fehler halten Speech suspendiert und die URL nach Moeglichkeit getrennt; erfolgreicher Retry gibt den Schutz wieder frei. Leere URLs sind als Sperrmarker ungeeignet, da getApiConfig sonst den Produktionsdefault aktiviert.
- Consequence: Kein Teilschreibfehler exponiert alten Key und neuen Server. Ein fehlgeschlagener Save braucht einen erfolgreichen erneuten Save mit gewuenschter URL und Key. Lokale Eingabe und andere lokale Funktionen bleiben davon getrennt.

## 2026-08-23 | Provider-safe memory and bounded transport

- Normal recall is a provider boundary: session secrets and local-only records are excluded rather than relying on downstream callers to remember a privacy flag.
- Metadata DLP fails closed on traversal limits, UTF-8 byte limits, secret-bearing canonical key aliases, and repository source/origin variants.
- All Laravel-facing desktop memory/context/API health traffic uses one 10-second hard deadline that also settles when a transport ignores AbortSignal.

## 2026-08-26 | Lokaler Testinstaller bleibt von Produktionsidentitaet und Signing getrennt

- Context: Ein installierbarer Windows-Smoke-Build soll ohne erfundene Zertifikate oder Updaterwerte moeglich sein und darf eine bestehende Luczor-Produktionsinstallation nicht still ersetzen.
- Decision: `.nvmrc` pinnt Node 22.22.0; projektlokale PowerShell-Wrapper nutzen diese installierte NVM-Version und Corepack nur im Kindprozess, ohne `nvm use`. Der lokale NSIS-Build verwendet `Luczor Local Test`, `de.luczor.desktop.local-test`, `currentUser`, `--no-sign` und eine direkte PE-Zertifikatstabellenpruefung. Das Produktions-Gate verlangt weiterhin die vollstaendige Updaterintegration und echte Signing-Secrets.
- Consequence: Lokale Installer-QA ist reproduzierbar und prod-neutral. Veroeffentlichung, Zertifikatsimport, signierter Build sowie Update-/Rollback-Abnahme bleiben absichtlich blockiert, bis echte Werte und ein eigener Produktionsworkflow vorhanden sind.

## 2026-09-05 | Lokaler Modell-Smoke bleibt von Produktdaten und Secrets getrennt

- Context: Der vollstaendige Orca-Smoke benoetigt Laravel, Tauri, eine signierte Modellrichtlinie und einen kurzlebigen Device-Key, darf aber weder Produktionsdaten noch Provider-/Voice-Secrets verwenden.
- Decision: Der Launcher validiert feste Hashes und Groessen, verwendet eine externe SQLite-/Storage-Instanz und eine dedizierte externe RSA-Testsignierung, schreibt in `.env.local-model` ausschliesslich den oeffentlichen Trust Anchor und aktiviert im Testkatalog nur Orca; Flash sowie externe Ausfuehrung bleiben deaktiviert.
- Consequence: Der Test ist reproduzierbar und fail closed. Token und eigene Prozesse werden im `finally` entfernt beziehungsweise beendet; der persistierte Report enthaelt keinen Klartext-Token.
