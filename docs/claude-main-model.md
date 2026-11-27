# Claude als Hauptmodell

Stand: 2026-11-23 · Quellstand, nicht ausgeliefert.

## Modi

Der Modus wird als Standard unter Einstellungen → Chat & Agenten („Hauptmodus“) gewählt und lässt sich je Chat im Eingabefeld (Schild-Symbol) umstellen.

| Modus | Wert | Führendes Modell | Bei Ablehnung durch Claude |
| --- | --- | --- | --- |
| Lokal | `local` | lokales Modell | – |
| Lokal + extern | `auto` | lokales Modell | – |
| Claude + lokal | `claude_local` | Claude über den Luczor-Server | lokales Modell übernimmt automatisch |
| Nur Claude | `claude` | Claude über den Luczor-Server | Rückfrage im Chat |
| Nur extern | `external` | vom Server gewählte externe Modelle | – |

Die drei bestehenden Modi sind unverändert. Claude-Modi sind nur wählbar, wenn der Server sie freigibt (`bootstrap.routing.main_model.claude_modes_allowed`) und für das Konto ein geprüfter Zugang besteht.

## Modell und Denktiefe

Beides wird je Chat im Eingabefeld gewählt (`ModelSelector.vue`). Die Modellliste kommt vom Server; die Denktiefe wird auf den Anthropic-Parameter `effort` abgebildet (Schnell → `low`, Ausgewogen → `medium`, Gründlich → `high`, Maximal → `xhigh`, Ultra → `max`). Neue Chats starten mit dem zuletzt gewählten Modell. Das lokale Modell bleibt eine Geräteeinstellung.

## Schlüssel

Der Anthropic-Schlüssel wird unter Einstellungen → Claude API eingegeben, einmalig an den Luczor-Server übertragen und dort verschlüsselt gespeichert. Der Desktop speichert ihn nicht und zeigt nur die maskierte Form. Das Gerät braucht die Fähigkeit `provider.keys`.

## Einrichtung je Konto, nicht je Gerät

Die Claude-Einrichtung gehört zum Benutzerkonto und liegt auf dem Server: Schlüssel, Schlüsselquelle, die Option „Claude-Ausweichmodell“ und das zuletzt gewählte Modell. Der Server liefert sie bei jedem Gerätestart in `bootstrap.routing.main_model.access` mit (`connected`, `source`, `provider_fallback`, `preferred_model` – nie Schlüsselmaterial, auch nicht maskiert). Jedes Gerät übernimmt sie automatisch (`adoptClaudeAccountSetup` in `services/inference/claudeMain.ts`); ein zweites Gerät desselben Benutzers kann Claude damit sofort nutzen, ohne den Schlüssel erneut einzugeben. Wird der Schlüssel auf einem Gerät entfernt, verlassen die anderen Geräte beim nächsten Start den Claude-Modus.

Gerätebezogen bleiben der Hauptmodus (Standard für neue Chats) und die Wahl je Chat, weil nicht jedes Gerät ein lokales Modell hat.

## Ablauf eines Claude-geführten Auftrags

1. `App.vue` hält Modus und Modell bei der Annahme des Auftrags fest und bereitet ihn wie einen lokalen Auftrag vor.
2. `services/agents/claudeTurn.ts` startet die Werkzeugschleife mit dem Gateway aus `services/inference/claudeGateway.ts`. Es sendet das providersichere Nachrichtenpaket an `POST /api/v1/proxy/chat` mit `task_type: chat.main`, `main_model_profile` und `effort`. Jede Runde wird gehasht; das Gateway ist an Serveridentität, Modell, Ablaufzeit und eine Rundenobergrenze gebunden.
3. Meldet der Server eine Ablehnung (`finish_reason: content_filter`, Feld `luczor_refusal`), wird die Teilausgabe verworfen. In `claude_local` läuft derselbe Auftrag lokal; in `claude` erscheint eine Rückfrage. Hat Claude bereits Werkzeuge ausgeführt, wird nicht neu gestartet: „Weiterarbeiten“ setzt den gesicherten Stand lokal fort.
4. Lokal übernommene Runden werden als gerätelokal markiert (`dataHandling: ephemeral`, `meta.handoff`) und gehen nie an einen Provider. Der Chat bleibt lokal (`localContinuation`), bis „Wieder Claude verwenden“ gewählt wird.

Die Übergabe reagiert ausschließlich auf das Signal der API. Für sprachlich formulierte Absagen gibt es unter der neuesten Claude-Antwort „Lokal neu beantworten“.

## Werkzeuge

Claude verwendet dieselben registrierten Werkzeuge wie das lokale Modell (Dateien, Repository, Memory, Browser, Terminal, Bildschirm, Aufgaben, Workflows …) – auf ausdrückliche Vorgabe des Betreibers vom 2026-11-23. Der Berechtigungsmodus des Chats (Beobachten, Handeln, Vollzugriff) und alle Freigabedialoge gelten unverändert.

Folge: Werkzeugergebnisse sind Teil der nächsten Anfrage und gehen damit über den Luczor-Server an Anthropic – auch Dateiinhalte, Bildschirmaufnahmen, Zwischenablage, Memory-Treffer und Seiteninhalte. Die Projekteinstellung für die externe Repository-Weitergabe (`repository_external_policy`) wird in Claude-geführten Aufträgen nicht angewendet, weil die Werkzeuge wie beim lokalen Modell laufen. Wer etwas auf dem Gerät halten will, wählt für diesen Chat den Modus „Lokal“.

Frühere Claude-Antworten eines Chats bleiben im Verlauf für Claude erhalten, auch wenn sie auf Werkzeugergebnissen beruhen. Vom lokalen Spezial-Agenten übernommene Runden gehen nie an einen Provider.

Die Delegation an Unter-Agenten (`agent_assist`) und die Zielverfolgung sind in Claude-geführten Aufträgen abgeschaltet. Zielrunden, Fortsetzungen, Mini-Chat und Workspace-Modus laufen weiterhin lokal.

## Grenzen

- Für alles, was an die Anthropic-API gesendet wird, gelten deren Nutzungsrichtlinien; eine abgelehnte Anfrage ist dort bereits eingegangen.
- Der Proxy spielt keine Denkblöcke zurück; ein Modellwechsel mitten im Chat ist möglich, der Prompt-Cache gilt je Modell.
- Nicht abgenommen: Lauf gegen die echte Anthropic-API, installierter Client, Zielserver.
