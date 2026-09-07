# Hybride Agententeams

Stand: 7. September 2026. Die Desktop-Implementierung benötigt den passenden Agententeam-Endpunkt des aktualisierten Admin-Servers.

Im Chat startet der Agentenschalter unmittelbar ein Team. Die Auswahl daneben bietet den Admin-Standard, lokale Planung mit Free-Spezialisten, günstige externe Planung mit Free-Spezialisten und ein vollständig lokales Team.

## Ablauf und Berechtigungen

Das lokale Modell koordiniert. Externe Recherche-, Coding- und Reviewrollen bearbeiten unabhängig voneinander den separat zusammengestellten externen Gesprächskontext. Das Budgetprofil ergänzt einen externen Planungsbeitrag. Die Modelle werden durch getrennte Serverprofile gewählt; der Desktop sendet keine frei wählbare Modell-ID.

Die externe Recherche liefert Vorschläge und benennt fehlende Quellenprüfungen. Diese Spezialisten haben selbst keine Browser-, Datei- oder Computerwerkzeuge. Der lokale Arbeitsagent übernimmt ihre Vorschläge als ungeprüfte Daten, führt erlaubte Werkzeuge aus und prüft die Ergebnisse anschließend lokal. Beobachten-Modus, Workspace-Bindung, Tool-Freigaben, Not-Aus und die einstellbaren Tool-Runden gelten weiterhin.

Eine gemeinsame Vorschau zeigt alle externen Pakete, Kandidaten, Datennutzung und Kosten-/Ausgabelimits. Jedes Paket hat einen eigenen einmaligen Hash. Die angezeigte Serverrichtlinie ist zusätzlich per Revision an den Versand gebunden. Änderungen an Modellen, Preisen oder Regeln führen zum Abbruch und erfordern eine neue Freigabe. Eine Ablehnung oder ein nicht verfügbarer Spezialist wird im Ergebnis benannt; das lokale Team kann weiterarbeiten.

Lokale Checkpoints, Toolantworten, private Erinnerungen und Repository-Kontext werden nicht als externe Spezialistenprompts wiederverwendet. Das Verbot „Code an externe Modelle“ sperrt Repository-Snippets, nicht ausdrücklich freigegebene öffentliche Fragen. Ein Wechsel dieser Regel während einer Freigabe verwirft die vorbereiteten Aufträge.

## Modellvorschlag und Lernen

Die Recherche liegt unter `../../.lmzdev/artifacts/reports/2026-09-07-agent-model-research.md`, einschließlich maschinenlesbarem Snapshot und Quellen. Empfohlen sind verschiedene kostenlose Spezialisten und optional DeepSeek V4 Flash 0731 für Planung. Das sind Startkandidaten, keine auf Luczor-Aufgaben bereits bewiesenen Sieger. Kostenlose Kontingente und Provider-Datennutzung bleiben relevant.

Unter einer Teamantwort zeigt „Agentenbeiträge“ das tatsächlich verwendete Modell, den öffentlichen Vorschlag, Dauer und Tokenverbrauch. Jeder Beitrag lässt sich separat bewerten. Erst mindestens fünf unterschiedliche bewertete Aufträge je Modell/Rolle qualifizieren das adaptive Ranking; bloßer HTTP-Erfolg ist kein Qualitätsnachweis. Mehrfachbewertungen desselben Auftrags erhöhen die Stichprobe nicht. Ein Ausgabelimit wird als unvollständiger Beitrag angezeigt. Kein Test wird aus einer Modellbehauptung automatisch als bestanden markiert.

## Lokale Bereitschaft

Siehe [Hintergrundvorbereitung](background-preparation.md). Beide Optionen sind standardmäßig aktiv. Modellgewichte bleiben innerhalb derselben Desktop-, Konto-, Projekt- und Repository-Sitzung auch bei einem Wechsel von Chat zu Coding oder Planung erhalten. Der vollständige Gesprächskontext wird je Anfrage übergeben; native Promptübernahme aus alten Slots ist deaktiviert. Kontext-/Kontowechsel können daher weiterhin zusätzliche Arbeit erfordern.

## Abnahmegrenzen

Automatisierte Tests decken Rollenverteilung, Paketbindung, Abbruch, Rechte, Filterung, Hintergrundvorbereitung, Cache-Invalidierung und Modellresidenz-Verträge ab. Das Browserlabor `agent-team-lab.html` prüft Bedienung und parallele Abläufe mit simulierten Agenten. Im normalen Release wurde außerdem der automatische Start des echten lokalen Modellprozesses ohne Chat und dessen Bereitschaft per HTTP-Health-Check geprüft; derselbe Prozess blieb anschließend geladen. Rund 107 Sekunden vergingen beim ersten Start bis zum Modellprozess. Dies ist keine Messung der gesamten Zeit bis zur ersten Antwort. Eine echte externe Modellanfrage und ein neuer Chat-Leistungsbenchmark wurden für diesen Stand nicht durchgeführt. Serverfreigabe/Aktivierung und Desktop-Datei sind getrennte Schritte.
