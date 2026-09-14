# Tasks

| Task | Owner | Status | Updated (UTC) |
|---|---|---|---|
| Review project state | unassigned | open | - |
| Harden desktop memory egress and API timeouts | Codex desktop_memory_egress_hardening | completed | 2026-08-23T05:13:32Z |
| Tauri-Manifest, Capabilities, nativen Debug-Build und Startup-Smoke testen | Codex tauri_runtime_test | completed | 2026-08-26T04:04:22Z |
| Realen lokalen Repository-Graph-Lebenszyklus und finalen integrierten Tauri-Build abnehmen | Codex/root | completed | 2026-08-26T04:13:46Z |
| Projektgepinntes Node 22, fail-closed Release-Gates und unsignierten lokalen NSIS-Testinstaller bereitstellen | Codex tauri_runtime_test | completed | 2026-08-26T04:38:57Z |
| Sicheren reproduzierbaren PowerShell-Launcher fuer den lokalen Modell-E2E-Smoke bereitstellen | Codex/root/local_test_bootstrap_command | completed | 2026-09-05T21:54:35Z |
| Separaten lokalen Terminal-Chatstarter und gemeinsame Runtime-Sperre bereitstellen | Codex/docs_e2e_audit | in-progress | 2026-09-05T23:58:16Z |
| Port Beautiful UI components and integrate actual chat, streaming and tools | Codex/root | completed | 2026-09-06T02:00:00Z |
| Gemeinsamen Server-TTS, sichere Settings-Identitaetswechsel und private Vorlesesperre integrieren | Codex/server_tts_desktop | completed | 2026-09-06T01:51:00Z |
| Voice-Einstellungen und Hands-free-Runtime vereinheitlichen, Diktatabschluss/Auto-Senden und STT-Readiness absichern | Codex/server_tts_desktop | completed | 2026-09-06T02:15:00Z |
| Independent always-on-top temporary mini chat with approvals and choices | Codex/mini_overlay | completed | 2026-09-06T02:56:00Z |
| Funktionssteuerung, Memory-Abruf, Archivredaktion und native Computeranalyse erweitern | Codex/root | completed | 2026-09-06T03:39:00Z |


## 2026-09-06T20:43:03Z | Codex/root | Chatkontinuität completed-local
- Zwischenkommentare erhalten/vorlesen, öffentliche Textabschnitte sofort darstellen, Projektziele und Checklisten als einklappbare Overlays umsetzen und prüfen: abgeschlossen.
- Desktop-Testbuild liegt bereit; aktuelle Nutzersitzung nicht beendet.
| Unified mini Chat/Workspace modes and main runtime integration | Codex/mini_workspace | completed-local | 2026-09-07 |

## 2026-09-06T22:24:00Z | Codex/unify_mini_theme | in-progress
- Own only src/styles/mini-chat.css and src/components/mini/StatusOrb.vue for shared visual identity; parent owns behavior and browser checks.

## 2026-09-06T22:26:19Z | Codex/unify_mini_theme | completed
- Narrow ownership returned: src/styles/mini-chat.css and src/components/mini/StatusOrb.vue. Parent owns integrated runtime and browser verification.

- [x] 2026-09-07: Zwischenkommentare mit bestätigter lokaler TTS-Freigabe, Wortmarkierung, V2-Stimmenauswahl und Serverdeploy a00d2cb; Releasebuild/Server-/Browserchecks abgeschlossen.

| Explicit external specialist routing and focused boundary tests | Codex/model_research | completed-local; ownership returned | 2026-09-07T00:16:27Z |

| Background local readiness and scoped context source preparation | Codex/routing_review | completed-local; root owns integrated gates/build | 2026-09-07 |


| Stable resident runtime scope and isolation regression tests | Codex/model_research | completed-local; ownership returned | 2026-09-07T00:25:39Z |

| Flüssige Ganztext-Sprachausgabe, Auswahl vorlesen und Fallback-Control im Promptkopf | Codex/root | completed-local | 2026-09-07 |

- [x] 2026-09-08: Voice-Composer und lokale Audio-Auslöser completed-local; Bericht artifacts/reports/2026-09-08-voice-input.md.

| Agententeam-Recovery und eng begrenzte lokale Systemdiagnostik | Codex/agent_team_recovery | completed-local; ownership returned | 2026-09-08T11:16:16Z |

| Native GPU execution selection, measured status, support-file pins and resident-only lease | Codex/gpu_runtime | completed-local; root owns integration/release | 2026-09-08T11:18:45Z |

## 2026-09-08 | Codex/root | Agententeam/GPU Abschluss
- [x] Root: residente Lease-Erneuerung, TS-Vertrag, gemessener GPU-Status, Integration und Release lokal abgeschlossen.
- [x] agent_team_recovery: Teilteams, Projektbindung, Runden, Diagnosecollector und Tests abgeschlossen; Ownership zurück.
- [x] gpu_runtime: geprüfte Backendauswahl, Begleitdateipins, Offloadmessung, native Tests und Clippy abgeschlossen; Ownership zurück.
- [x] backend_team_gpu: Routingbereitschaft, explizite Rollenreparatur, Runtimevertrag und Adminanzeige abgeschlossen; Ownership zurück.
- [ ] Auslieferungsabnahme: neue EXE nach Nutzer-Chatende starten, echten langen Agenten-/GPU-Lauf prüfen. Produktionsbackend und externe Rollen noch nicht ausgerollt.
- [ ] Separater vorhandener Backendbefund: Windows-Unterstützung der ManagedLocalModelKey-Pfad-/Rechteprüfung sicher klären; fünf Baseline-Tests bleiben rot. Keine Sicherheitsprüfung abgeschwächt.

| Native Datenträgerklassifizierung nach echtem Modellvolumen | Codex/agent_team_recovery | in-progress; only new local_model_storage.rs and approved windows-sys features | 2026-09-08T11:37:20Z |

| Native Datenträgerklassifizierung nach echtem Modellvolumen | Codex/agent_team_recovery | completed-local; ownership returned | 2026-09-08T11:52:02Z |

| Bounded native DXGI GPU inventory | Codex/agent_team_recovery | in-progress; new local_model_accelerators.rs plus approved Windows dependency only; integration gpu_runtime-owned | 2026-09-08 |

| Bounded native DXGI GPU inventory | Codex/agent_team_recovery | completed-local; 8 unit tests plus 1 real readonly probe passed; ownership returned | 2026-09-08T12:22:56Z |

| Device-local resource settings and status UI, independent workflow review | Codex/agent_team_recovery | completed-local; 36 focused tests passed; source ownership returned, final native/browser gates at Root | 2026-09-08T14:09:39Z |

| Systemstatus in Feature-Model, Controller und kleine View-Komponenten aufteilen | Codex/root | completed-local | 2026-09-10T17:24:03Z |

| Liquid-Glass-Design aus Artefakt umsetzen: Sidebar/Topbar/Kontext, Bildschirmrand-Nudge als einziger Mini-Modus, Denkstufen-Regler, Glas-Deckkraft | Claude Code | completed-local; nativer Tauri-Abnahmelauf offen | 2026-09-14 |
| Systemwerte (CPU/GPU/Temperaturen) in das Nudge-Pane bringen (MiniSnapshot-Datenfeed) | unassigned | open | 2026-09-14 |
