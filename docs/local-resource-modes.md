# Lokale Ressourcen einstellen

Unter **Einstellungen → Ausführung → Lokales Modell** gelten die Einstellungen ausschließlich für dieses Gerät. Sie werden weder durch Projektabgleich noch durch Serverdefaults ersetzt.

| Modus | Verhalten |
|---|---|
| Automatisch – alle Ressourcen | Bevorzugt die GPU. Reicht eine Karte, bleibt es dabei. Bei Bedarf werden kompatible Karten und anschließend CPU/RAM einbezogen. |
| GPU – Automatik als Ersatz | Versucht vollständigen GPU-Offload. Bei fehlender Kapazität oder nicht bestätigtem vollständigem Offload erfolgt ein erklärter Wechsel zur Automatik. |
| Nur CPU/RAM | Keine Modellschichten auf der GPU. Ein Modell mit verpflichtender GPU-Freigabe bleibt in diesem Modus gesperrt. |

Alle Ressourcen werden nach Bedarf verwendet; eine künstliche Vollauslastung ist kein Ziel. Auch vollständiger GPU-Offload benötigt CPU und RAM für Steuerung und Laden. Modell, Quantisierung und Kontextgröße bleiben bei einem Moduswechsel unverändert.

Die Details bieten GPU-Auswahl, Antwortthreads, Kontextthreads und RAM-/VRAM-Puffer. Leere Felder verwenden die Automatik. Manuelle Threads dürfen die für diesen Prozess verfügbaren logischen Kerne nicht überschreiten. Speicherpuffer sind Planungsreserven, keine vom Betriebssystem exklusiv gesperrten Speicherbereiche. Der RAM-Notfallschutz bleibt aktiv. **Auf Automatik zurücksetzen** setzt den Entwurf zurück; **Ressourcen speichern** übernimmt ihn.

Während eines Chats, einer Planung oder eines Agentenauftrags wird eine neue Einstellung vorgemerkt. Der gesamte Auftrag einschließlich seiner Tool-Runden beendet sich unter derselben Ressourcenrevision. Anschließend wird die eigene residente Runtime einmal neu vorbereitet. Neue Aufträge warten auf die Umschaltung. Hauptchat, Mini-Chat und externe Teamkinder verwenden dieselbe zentrale Barriere.

**Gewählt**, **Angewandt** und die gemessene **Berechnung** sind getrennt. Ein erfolgreicher Health-Check allein bestätigt keinen GPU-Betrieb: Die Startmessung und der signierte Bereitschaftstest müssen abgeschlossen sein. Fehlende oder veraltete Messwerte bleiben unbestätigt. Die GPU-Karte zeigt verwendete Geräte, ausgelagerte Schichten und Modellpuffer. Die Hardwareliste bezeichnet die Gesamtbelegung durch alle Prozesse gesondert.

Mehrere GPUs werden innerhalb eines geprüften Backends kombiniert. NVIDIA/CUDA wird bevorzugt; reicht eine andere kompatible Gruppe vollständig, wird sie vor einer unzureichenden Gruppe gewählt. Automatische Schichtverteilung verwendet den Speicher-Fit der geprüften llama.cpp-Runtime. Mehrkartenbetrieb ist automatisiert geprüft; echte Abnahme benötigt mehrere passende Karten. Bei nicht eindeutig unterscheidbaren identischen Karten bleibt die automatische Auswahl verfügbar.

Der Serverkatalog kann optional `capacity_policy.accelerator_memory_scope` auf `compatible_group` setzen. Ohne dieses Feld beziehungsweise mit `single_device` muss weiterhin mindestens eine einzelne Karte die signierte VRAM-Anforderung erfüllen. Gemeinsam nutzbarer System-RAM zählt nicht als zusätzlicher VRAM. Neue Katalogfelder erst nach Aktualisierung aller beteiligten Desktopclients veröffentlichen.

Die zentralen Implementierungs-, Test- und Hardwareberichte liegen unter `E:\projekte\luczor\.lmzdev\artifacts\reports`. Diese Änderung veröffentlicht keinen Katalog, lädt keine größeren Modelle herunter und führt keinen Produktionsrollout aus.
