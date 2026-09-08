# Automatische Hardwareabstimmung

Luczor ermittelt beim Modellstart die verfügbare Hardware und leitet daraus lokale Startparameter ab. Der signierte Modellkatalog bestimmt weiterhin Modell, Kontext und Mindestanforderungen. Die automatische Abstimmung benötigt keine zusätzlichen CPU-, Batch- oder Laufwerksbuchstaben-Einstellungen.

## CPU und RAM

Der native Sampler liest physische und logische Kerne, die für den Prozess verfügbare Parallelität sowie gesamten und verfügbaren RAM. CPU-Auslastung entsteht erst aus zwei ausreichend weit auseinanderliegenden Messungen; die erste Messung bleibt unbekannt. Der Sampler wartet dafür nicht in der Oberfläche.

Die Startplanung unterscheidet speicherschonenden Betrieb, ausgewogene Verarbeitung und hohen Durchsatz. Sie begrenzt Antwort- und Kontextthreads, berücksichtigt gemessenen CPU-Druck und verkleinert Batchgrößen bei knappem RAM. Mindestens ein Thread bleibt nutzbar. Es läuft weiterhin nur eine lokale Modellanfrage gleichzeitig. Freigehaltene logische Kerne und das RAM-Pufferziel sind Planungswerte, keine exklusiven Betriebssystemreservierungen.

Der Ladeweg berücksichtigt auch den Host-RAM. Bei Windows/CUDA und großen Modellen relativ zum verfügbaren Hostbudget nutzt Luczor den unterstützten gepufferten Ladeweg (`--load-mode none`, bei älteren Builds `--no-mmap`). Damit muss der Windows-Ladepfad nicht die gesamte Modelldatei als Speicherabbildung behalten. CPU, kleine Modelle und andere Plattformen behalten `mmap`, sofern verfügbar. Die Auswahl erfordert mindestens 2 GiB Modellgröße und RAM-Druck oder eine Modellgröße von mindestens 75 Prozent des Hostbudgets nach Pufferziel. Fehlt die CLI-Unterstützung, bleibt das im Status erkennbar. Speicher wird nie mit `mlock` gesperrt. CPU-Polling wird deaktiviert und die Zahl der HTTP-Worker begrenzt, wenn der geprüfte Build diese Optionen anbietet.

Während des Starts schützt ein separater Notboden vor anhaltend fast vollständig aufgebrauchtem RAM: zwei Prozent des Gesamtspeichers, mindestens 512 MiB und höchstens 1 GiB, unterschritten in mindestens drei Messungen über mindestens eine Sekunde. Bei einem gemessenen Wert unter 128 MiB greift der Schutz sofort. Ein vorübergehender Speicheranstieg beim GPU-Upload darf das größere Pufferziel unterschreiten. Bei einem Schutzabbruch folgt kein zusätzlicher CPU-Start. Die Vorbereitung erklärt den Grund, statt ihn als fehlende Modellkonfiguration darzustellen.

Ein residentes Modell wird bei der Kapazitätsprüfung nicht erneut als vollständiger RAM-Bedarf angesetzt. Andere momentan ungeeignete Modellprofile lösen weder unnötige Sofortprüfungen noch periodische Bereinigungen des eigenen Working Sets aus, solange das gültige Modell resident ist. Hardwaredaten werden weiterhin nach Ablauf erneuert; abgewiesene Starts werden beim nächsten Auftrag neu geprüft.

Vor einem Kaltstart wird weiterhin die vollständige GGUF samt Runtime gegen den signierten Hash geprüft. Das Release optimiert gezielt die SHA2-Bibliothek auf Durchsatz, während das übrige Größenprofil erhalten bleibt. Das beschleunigt insbesondere CPUs ohne SHA-Erweiterungen; die Prüfung wird weder übersprungen noch durch einen unsicheren Dateizeitstempel-Cache ersetzt. Ein Kaltstart enthält deshalb weiterhin Zeit für das Lesen und Prüfen der gesamten Datei.

## GPU

Die bereits vorhandene Runtimeerkennung prüft den signierten llama.cpp-Build, seine unterstützten Optionen und Geräte. CUDA wird bevorzugt; GPU-Layer werden mittels Fit an den verfügbaren Grafikspeicher angepasst. Der tatsächliche Layer-Offload und GPU-Puffer werden gesondert angezeigt. Die Ressourcenparameter allein beweisen weder GPU-Ausführung noch eine höhere Geschwindigkeit.

Die frühe Bestandsaufnahme kombiniert unter Windows NVML mit einem begrenzten nativen DXGI-Inventar. AMD-/Intel-Adapter und NVIDIA bei fehlendem NVML können damit als physische Geräte erkannt werden. DXGI bestätigt keinen Inferenz-Backend: Der Backendwert bleibt unbekannt, global freier VRAM bleibt `null`. Nur dedizierter Videospeicher zählt für die VRAM-Mindestanforderung; gemeinsam nutzbarer System-RAM wird separat als Obergrenze geführt und nie addiert. Ein geeigneter DXGI-Kandidat darf bei automatischer Backendauswahl die native Prüfung beginnen, erhält dadurch aber keine Bereitschaftsbestätigung. Der signierte Runtime-/GPU-/Benchmarkcheck bleibt vor Inferenz verbindlich. Explizite Backendbeschränkungen werden nicht gelockert.

Das Inventar erfasst höchstens 32 Adapter und wartet höchstens zwei Sekunden auf seinen einzigen Worker. Software- und Remoteadapter sind ausgeschlossen. Existierende NVIDIA/NVML-Einträge werden bevorzugt; bei nur teilweise zugänglichem NVML auf einem Mehrkartensystem kann NVIDIA in diesem ersten Schritt untererfasst bleiben. Namen oder unterschiedliche Geräteindizes werden nicht zur erfundenen Identitätszuordnung benutzt. Echte Ausführungstests betreffen derzeit Windows mit NVIDIA; AMD/Intel benötigen eigene Geräteabnahme.

## SSD und Modellordner

Unter Windows ordnet Luczor den tatsächlichen Pfad über Volume- und Disk-Extents den physischen Datenträgern zu. Bus und Medienart werden separat ermittelt: Eine USB-SSD ist kein interner NVMe-Speicher. Mehrere Partitionen, mehrere Extents und lange Windows-Pfade werden berücksichtigt. Native Abfragen sind in Dauer, Ausgabemenge und parallel laufenden Arbeitern begrenzt; bei fehlendem Nachweis bleibt die Klassifizierung unbekannt.

Ein bereits eingestellter Modellordner ist verbindlich. Eine schnelle freie SSD auf einem anderen Laufwerk kann dessen ungeeignete Ablage nicht mehr verdecken. Ohne eingestellten Ort bevorzugt die Kapazitätsauswahl feste NVMe-SSDs und danach andere SSDs vor HDDs; dies ist eine Kandidatenauswahl, keine automatische Bestandsmigration oder Installation. Dateien werden nicht verschoben. Die native Modellprüfung bestätigt den tatsächlich verwendeten Speicherort nochmals.

## Anzeige und Abnahme

Im Systemstatus stehen die gewählte Abstimmung, CPU-Aufteilung, RAM-Snapshot beim Start und der konkrete Modellspeicher. Die Prüfdetails ergänzen Batchgrößen, Kontext und Speicherabbildung. „Beim Modellstart angewandt“ bedeutet, dass der Prozess mit den Parametern gestartet und gesund geworden ist; es ist kein Leistungsvergleich. RAM- und freie SSD-Werte in diesem Abschnitt stammen vom Startzeitpunkt.

Die UI-Fixture `tests/fixtures/hardware-resources.html` zeigt die echte Ressourcenkomponente mit ausdrücklich synthetischen Werten in breiter und 320-px-Darstellung. Hardware-Smokes und Modelltests werden unter dem zentralen Workspace-Verzeichnis `.lmzdev/artifacts/reports` dokumentiert. Ein Heuristikprofil ersetzt keine gemessene optimale Konfiguration; Startstabilität, Qualität und Durchsatz müssen am jeweiligen Modell und Gerät geprüft werden.
