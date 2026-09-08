# Agententeams, Geräteanalyse und GPU-Berechnung

## Agententeam verwenden

Der Agentenschalter im Eingabefeld startet den nächsten Auftrag direkt als Team. Das lokale Modell führt Planung, Werkzeuge und Prüfung. Konfigurierte externe Spezialisten können getrennte, ausdrücklich freigegebene Textaufträge übernehmen. Ihr Ergebnis fließt in die lokale Bearbeitung ein. Eine fehlende externe Rolle verhindert nicht mehr den Einsatz der übrigen bereiten Rollen.

Für eine Geräteanalyse genügt beispielsweise: „Analysiere dieses Gerät lesend auf Sicherheits- und Leistungsprobleme und erstelle einen priorisierten Optimierungsplan.“ Ein Projektordner ist dafür nicht erforderlich. Ohne Ordnerbindung bietet das Team keine nicht ausführbaren Projektdateiwerkzeuge an. Das neue Werkzeug `os_system_diagnostics` liefert ausgewählte Windows-, Speicher-, Datenträger-, Prozess- und Sicherheitsdaten. Nicht verfügbare Quellen bleiben als unbekannt gekennzeichnet. Das Werkzeug führt keine Optimierungen aus und akzeptiert keine freien Shellbefehle.

Die Agenten sollen vorhandene Ergebnisse übernehmen, bekannte Geräteangaben nicht erneut erfragen und fehlgeschlagene Werkzeuge erst nach geänderten Voraussetzungen wiederholen. Die sichtbaren Runden zählen tatsächliche Anfragen. Modellbereitschaft, Konfigurationsfehler und echte Laufzeitfehler erhalten unterschiedliche Hinweise. Eine abgelaufene Bereitschaftsbestätigung kann am gesunden, weiterhin passenden residenten Modell erneuert werden, ohne das Modell neu zu laden. Änderungen von Konto, Katalog oder Modell werden dadurch nicht übergangen.

Im Admin unter **Agenten & Ereignisse** zeigt der Einrichtungsstatus die Gründe für nicht bereite Rollen. **Teams ergänzen** kann mit der Option **Leere aktive Rollenketten erneut befüllen** frühere unvollständige Konfigurationen vervollständigen. Bestehende befüllte oder deaktivierte Rollen bleiben erhalten. „Konfiguriert“ ist eine Routingprüfung; erst ein echter Auftrag prüft die Verfügbarkeit beim Anbieter. Siehe auch `admin_api_app/docs/agent-teams.md`.

## GPU-Ausführung erkennen

Im Systemstatus zeigt **Berechnung** den nachgewiesenen Modus: GPU, GPU + CPU, CPU oder noch unbekannt. Die Details nennen das Backend, das Gerät und – soweit von der Laufzeit gemeldet – ausgelagerte Layer und GPU-Puffer. GPU-Puffer sind Modellallokationen, nicht der gesamte Verbrauch der Grafikkarte. Eine vorhandene Grafikkarte allein gilt nicht als Ausführungsnachweis.

Beim nächsten echten Modellstart prüft Luczor den installierten, signierten llama.cpp-Build auf verfügbare Geräte und Fit-Unterstützung. CUDA wird bevorzugt; kompatible Vulkan-/Metal-Geräte können ebenfalls gewählt werden. Die Runtime verteilt Layer passend zum verfügbaren Grafikspeicher und plant 1.024 MiB Reserve ein. Das ist ein Ziel für die Modellallokation, keine exklusive Speicherreservierung gegenüber anderen Anwendungen. Kontextgröße und signierte Modellgrenzen gelten weiter.

Fehlt ein geeignetes GPU-Backend oder scheitert sein Start früh, ist einmalig eine CPU-Ausführung möglich, sofern die signierte Richtlinie sie erlaubt und RAM-/Leistungsprüfungen bestehen. Luczor installiert dabei keine Treiber oder neue Runtime-Bibliotheken. Eine Änderung des signierten Runtime-Backends beziehungsweise der Bibliothekshashes erfolgt im Admin; weitere Informationen stehen in `admin_api_app/docs/local-runtime-backends.md`.

Unter Windows stammt die frühe Grafikspeicherprüfung weiterhin aus NVML. Vulkan-Geräte können deshalb bei Profilen mit zwingender positiver GPU-Mindestkapazität vor dem Runtime-Start noch als nicht nachgewiesen gelten. Standardprofile ohne diese Mindestgrenze können das Gerät über die Runtime erkennen.

## Aktualisierten Build prüfen

Nach Abschluss laufender Chats die alte App regulär beenden und den neuen Desktopbuild starten. Er übernimmt die vorhandene App-Identität und Konfiguration. Bei der anschließenden Modellvorbereitung den Berechnungsstatus prüfen; danach den ursprünglichen Geräteanalyseauftrag mit aktivem Agentenschalter erneut ausführen. Bestehende Grenzen für lokale Daten, externe Kontextpakete und Werkzeugfreigaben gelten unverändert.

Der Build vom 08.09.2026 wurde kompiliert und automatisiert geprüft. Ein vollständiger neuer nativer Modell-/Agentenlauf ist noch offen, da während der Prüfung bereits die Nutzer-App mit einem großen Modell lief. Es wurde keine zweite konkurrierende Modellinstanz gestartet und kein Geschwindigkeitsgewinn gemessen.
