# Agentenmodus und Tool-Limits

Im Hauptchat sitzt **Agenten** oben rechts im Eingabefeld. Der Schalter ist beim App-Start aus. Ist er aktiv, beginnt der nächste Auftrag direkt als Agententeam. Das lokale Modell steuert Planung, Bearbeitung und Prüfung; je nach Teamkonfiguration kommen getrennte externe Spezialisten hinzu. Einzelne Tool-Freigaben, der aktuelle Ausführungsmodus und Not-Aus gelten weiterhin. Details zu Teilteams, Geräteanalyse und GPU-Ausführung stehen in [Agententeams und GPU](agent-teams-and-gpu.md).

Unter **Einstellungen → Ausführung & Freigaben → Tool-Limits** lassen sich zwei Werte speichern:

| Einstellung   |  Standard | Bereich |
| ------------- | --------: | ------: |
| Normaler Chat |  6 Runden |    1–64 |
| Arbeitsagent  | 12 Runden |    1–64 |

Eine Runde ist eine Modellanfrage und kann mehrere Tool-Aufrufe enthalten. Die Planung hat eine Textrunde, die Prüfung maximal drei Runden. Gespeicherte Werte gelten beim nächsten Arbeitsabschnitt. Ein leeres Feld, Dezimalzahlen oder Werte außerhalb des Bereichs verhindern das Speichern. Das Kontextfenster des lokalen Modells wird durch diese Werte nicht vergrößert. Die angezeigte Token-Summe umfasst sämtliche Runden.

Erreicht ein Arbeitsabschnitt sein Rundenlimit, erscheinen **Weiterarbeiten** und **Mit Agententeam fortsetzen**. Der erste Button setzt den normalen Tool-Dialog fort, der zweite startet sofort das Team mit dem bisherigen Fortschritt. Ein vorhandener Eingabeentwurf bleibt erhalten. Der Rundenzähler beginnt für den neuen Abschnitt wieder mit dem eingestellten Budget.

Fortsetzungen behalten Tool-Ergebnisse und erfolgreich ausgeführte Änderungen im Arbeitsspeicher. Bereits erfolgreich ausgeführte identische Datenänderungen werden bei einer Wiederholung erkannt. Computer-Eingaben und Prozessaktionen bleiben wiederholbar, da sich ihr Zielzustand geändert haben kann. Es werden keine versteckten Tool-Transkripte in das Chatarchiv geschrieben. Projekt-, Konto- oder Berechtigungswechsel verwerfen die verfügbaren Fortsetzungen; ein App-Neustart ebenfalls. Alte, bereits archivierte Limitmeldungen aus früheren Versionen besitzen keinen nachträglich rekonstruierbaren Checkpoint.

Planungs- und Prüfagenten erhalten keine Schreibrechte. Eine fortgesetzte Prüfung bleibt lesend. Der lokale Kontrollpfad verarbeitet Werkzeuge und Fortsetzungen. Externe Spezialisten erhalten ausschließlich ihr separat freigegebenes Textpaket; die Fallback-Freigabe des normalen Chats überträgt Teamkontexte nicht automatisch an einen externen Anbieter.

## Prüfung

- Unit- und Integrationstests: `agentModeAndTools`, `chatOrchestration`, `toolLimits`, `settingsServerRecovery`, `agentTeams`.
- Browser-Fixture: `/tests/fixtures/tool-limits.html` mit echten Präsentationskomponenten und synthetischem Sendestatus. Es führt keine echten Tools oder Modelle aus.
- Native Modellqualität, Laufzeit und die fachlichen Ergebnisse eines realen Nutzerauftrags müssen zusätzlich mit dem jeweiligen lokalen Modell geprüft werden.
