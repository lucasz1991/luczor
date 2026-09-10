# Systemstatus-Architektur

Der Systemstatus ist als eigenständiges Feature aufgebaut. Die Vue-Komponenten bleiben die View-Schicht; Zustandswechsel und IPC-Aufrufe liegen in Controllern; Typen und abgeleitete Anzeigedaten liegen in Models.

## Frontend

| Schicht | Datei | Verantwortung |
|---|---|---|
| View | `src/components/SystemStatusPanel.vue` | Shell für Mini-, Tab- und Dashboard-Modus |
| View | `src/components/JarvisHud.vue` | Zusammensetzen der Statusbereiche und Starten/Stoppen des Monitors |
| View | `src/features/system-status/components/SystemResourceMeter.vue` | Ein einzelner CPU-, RAM-, GPU- oder Datenträger-Meter |
| View | `src/features/system-status/components/SystemMiniModelUsage.vue` | Kompakte öffentliche Modellmetriken in der Mini-Leiste |
| Controller | `src/features/system-status/useSystemStatusController.ts` | Moduswechsel, native Fensteraufrufe, Tab-Navigation und Fokuslebenszyklus |
| Model | `src/features/system-status/model.ts` | Modi, Bereiche, Statusindikatoren und feste Tab-Metadaten |
| Model | `src/features/system-status/resourceModel.ts` | Ressourcenreihen, Temperatur-/Kapazitätswerte und Verlaufsdaten für die Views |
| Service | `src/services/systemStatusMonitor.ts` | Begrenztes Polling, Verlauf und Freshness-Zustand |
| Transport | `src/services/systemMetrics.ts` | TypeScript-Vertrag und Aufruf des nativen `system_metrics`-Commands |

## Tauri-Backend

| Schicht | Datei | Verantwortung |
|---|---|---|
| Controller | `src-tauri/src/commands/system_status_controller.rs` | Webview-Berechtigung prüfen und den blockierenden Collector aus dem Async-Runtime-Thread auslagern |
| Model | `src-tauri/src/commands/system_status_model.rs` | Serialisierter `SystemMetrics`-Vertrag |
| Service/Collector | `src-tauri/src/commands/system.rs` | Bestehende, begrenzte Geräte- und Prozessmessung |
| Adapter | `src-tauri/src/commands/system_disk.rs`, `system_gpu.rs` | Plattformspezifische Datenträger- und GPU-Abfragen |

## Datenfluss

1. Eine View aktiviert `createSystemStatusMonitor` nur während sie sichtbar ist.
2. Der Monitor ruft den TypeScript-Transport auf.
3. Der Rust-Controller prüft, ob Hauptfenster oder lesendes Systemstatus-Fenster aufruft.
4. Der Collector erzeugt ein `SystemMetrics`-Model.
5. `resourceModel.ts` leitet daraus die reinen Anzeigemodelle ab.
6. Die kleinen View-Komponenten rendern nur ihre Props und führen keine nativen Aufrufe aus.

Das LocalModel-Panel verwendet weiterhin ausschließlich öffentliche Ausgaben und gemeldete Laufzeitdaten. Private Gedankengänge, Zugangsdaten und rohe Tool-Payloads gehören nicht in den Systemstatus.
