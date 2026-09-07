# Decisions

## 2026-09-06 | Luczor Mini als eigene Anzeige mit gemeinsamer Laufzeit

- Context: Der Nutzer verlangt ein verschiebbares, minimierbares Fenster ueber anderen Windows-Apps und die Kreisoptik des vorhandenen Live-Status. Die UI-Bibliothek soll entfallen.
- Decision: `luczor-mini` ist ein eigenes rahmenloses Always-on-top-Webview ohne Parent-Bindung an das Hauptfenster. Nur `main` besitzt Modell-, Mikrofon-, Store- und Agentenlaufzeit. Validierte native Aktionen und begrenzte In-Memory-Snapshots verbinden beide Fenster; die Webvorschau nutzt dieselbe Vue-Oberflaeche als Overlay.
- Decision: Der Mini-Verlauf und sein Tool-Journal bleiben fluechtig und projektgebunden. Gemeinsame Ausfuehrungssperre, echte einmalige Freigaben, API-Identitaetsreset, Abort-/Session-Grenzen und die bestehende Ausgabe-/Routingkontrolle bleiben verbindlich. Temporaer veraendert weder Provider-Aufbewahrung noch Auswirkungen explizit freigegebener Werkzeuge.
- Decision: Kreisfarben und Symbole spiegeln echte Zustaende; Mikrofonpegel kommen ausschliesslich aus dem Hauptfenster. Keine erfundenen Prozent-, Denktext- oder Hardwareanzeigen. UI-Bibliothek, zugehoerige App-Einbindung und Menuepunkt entfernt; verwendete Komponenten bleiben erhalten.
- Consequence: Kein zweiter Agent oder Mikrofonzugriff im Overlay. Hauptfenster-Minimierung und Vordergrundverhalten brauchen eine native interaktive Abnahme; Browser-Fixtures sind nur UI-Nachweis.

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


## 2026-09-06T20:43:03Z | Öffentliche Kommentare und geordnete Sprachausgabe
- Abgeschlossene Modellrunden speichern eigene öffentliche Kommentare am Beitrag; laufender Slot bleibt nur für die aktuelle Runde. Gespeicherte laufende Phasen werden beim Laden abgebrochen, Text bleibt erhalten.
- Status/Kommentare/Antwort teilen sich eine abbrechbare Vorlesewarteschlange mit erneuter Einstellungs-, Sitzungs- und Serverfreigabeprüfung. Private Reasoning-Inhalte werden nicht ausgegeben.
- Projektbereiche sind absolut positionierte, unabhängig bedienbare Disclosures. Separater Debugbuild erhält die laufende Release-Sitzung.

## 2026-09-07 | Mini nutzt Projektchat oder lokalen Workspace
- Entscheidung: Die vorhandene Hauptlaufzeit bleibt Eigentuemerin beider Mini-Ansichten. Projektchat ist derselbe persistierte Verlauf; Workspace bleibt eine fluechtige, ausschliesslich lokal verarbeitete Verwaltungsunterhaltung.
- Der aktuelle Desktop hat einen Chat je Projekt. Ein neues, paralleles Chatschema wird nicht eingefuehrt. Workspace leeren loescht keine Projektnachrichten; Auswahl und Entwuerfe sind eindeutig dem Kontext zugeordnet.
- Uebergreifende Werkzeuge erhalten eine vom Host fixierte Konto-/Projektliste und pruefen diese samt Ausfuehrungsticket vor und nach asynchroner Arbeit. Datei-/Desktopaktionen behalten das ausgewahlte Arbeitsprojekt. Codeauftraege werden nur fuer die bestehende manuelle Agentenfreigabe vorbereitet.
- Darstellung: native Mini-Webview und Browser-Overlay verwenden dieselben Theme-Aliase und Chatkomponenten wie das Hauptfenster. Bei offenen Entscheidungen haben erreichbare Freigabe, Composer und Not-Aus Vorrang vor gesperrten Shortcuts.
- Buildkoordination: gemeinsamer regulaerer Release ohne Bundle im freien Zielpfad, da die laufende Debug-App ihre EXE belegt. Kein Start, Installer oder Austausch der laufenden Nutzersitzung.

- 2026-09-07: Öffentliche lokale Sprachausgabe nutzt separate zielgebundene Zustimmung. V2-Stimmen kommen aus dem freigegebenen Serverkatalog; WAV je Satz bei Servertempo 1 und Client-Wiedergabetempo. Piper bleibt Standard; fehlende Stimme ohne stillen Ersatz. Wortposition ausdrücklich näherungsweise. Bestehende Debug-Sitzung bleibt offen.

## 2026-09-07T00:16:27Z | Explicit specialist selection
- Ordinary chat remains local first. External delegation is an explicit intent restricted to server-managed agent.planning/research/coding/review task types; preferring an external model never grants data egress or bypasses a signed denial. The approved external gateway remains one-shot and bound to the exact request and selected role.

## 2026-09-07 | Hintergrundbereitschaft und Kontextcache
- Nur signierter local_only-Coordinatorpfad bereitet Modelle vor; vorhandene exklusive Nativeprepwarteschlange bleibt massgeblich. Gueltige Readiness vermeidet erneute Prepareaufrufe; abgelaufene signierte Policy wird vor Nativearbeit erneuert. Kein Gateway-/Approvalcache.
- Nur Quellfragmente fuer Projektkontext werden45Sekunden/max4Eintraege in-memory gecacht und pro Turn neu gebunden. Memory-Storeaenderungen invalidieren; bei fehlendem Memorylistener bleibt Memorycache aus. Session/Account/Projekt/Workspace/Policy-/Settingswechsel verwerfen alte Ergebnisse. Nachrichtentimestamps allein sind keine Quellrevision.


## 2026-09-07T00:25:39Z | Process ownership versus request context
- Native process scope binds verified principal, device, server instance, project, repository and native manifest acceptance session. Per-turn context IDs and task types stay request metadata, never process ownership keys. Real inference must disable prompt caching and send the complete request context; account/project/repository/session changes retain process isolation.
