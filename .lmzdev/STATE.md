# Current state

## Confirmed

- LMZ Dev workspace initialized.
- Ordinary desktop memory recall excludes session secrets and every record whose write policy is local-only.
- Repository provenance recognizes canonical source/origin key variants, and DLP inspects UTF-8 byte size plus canonical secret key names.
- API, memory, context and health requests share a hard 10-second fetch deadline.
- Tauri 2 registriert Dialog-, Workspace-, Graph-, Memory- und Systemkommandos konsistent in Plugin-Setup, Invoke-Handler, AppManifest und der nur fuer `main` gueltigen Capability; die Remote-Browser-Webview behaelt ausschliesslich `browser_report`.
- `.nvmrc` pinnt Node 22.22.0. Die Version ist zusaetzlich in NVM installiert; Wrapper und Installer-Build aktivieren sie samt Corepack nur pro Kindprozess und veraendern den globalen NVM-Symlink nicht.
- Ein eigener `Luczor Local Test`-NSIS-Pfad nutzt eine getrennte Bundle-Identitaet, `currentUser`, explizites `--no-sign` und keinen Updater. Produktion bleibt ohne echte Updater- und Signing-Werte fail closed.

## Verification

- `pnpm vitest run --maxWorkers=1`: 30 files, 198 tests passed.
- Focused memory/transport/context tests: 5 files, 31 tests passed.
- Focused ESLint: passed with no findings.
- `pnpm typecheck`: passed.
- `cargo fmt --all -- --check`, `cargo check --all-targets`, 47 Rust-Tests und `cargo clippy --all-targets -- -D warnings`: bestanden.
- `pnpm tauri build --debug --no-bundle`: im finalen integrierten Stand bestanden; erzeugt `src-tauri/target/debug/tauri-app.exe` (40.297.984 Bytes, SHA-256 `7B5DAAC63A23C0C9496AE2A18B9972E3BDD643250BDAE743F8118DC9132037AE`).
- Der erzeugte Windows-Prozess lief zehn Sekunden responsiv und ohne Sofort-Crash; ausschliesslich der gestartete Test-PID wurde danach beendet.
- Der reale lokale Graph-Vertrag mit temporaerem Git-Repository, Hash-/Git-Stale, Secret-/Ignore-/Symlink-Grenzen, Principal-/Projektisolation und Unbind ist gruen; 15/15 Graph-Tests bestanden.
- Sechs Release-/PE-Regressionstests, Node-/Versions-/Local-Readiness, PowerShell-Syntax und Prettier bestanden. Der kanonische Node-22.22-/Corepack-Befehl erzeugte `src-tauri/target/debug/bundle/nsis/Luczor Local Test_2.9.3_x64-setup.exe` (7.792.520 Bytes, SHA-256 `86FC1E8A0A8EE9985E0FE3E747E81B0D936C181EFBCDDAD3C2B32281011F551A`); die PE-Zertifikatstabelle ist leer.

## Risks and blockers

- Die systemweit aktive Node bleibt absichtlich 22.11.0; direkte globale PNPM-Aufrufe warnen weiterhin. Der dokumentierte Wrapper-/Corepack-Pfad ist projektkonform mit Node 22.22.0.
- Der Debug-Build ist erwartungsgemaess nicht code-signiert. Das Hauptfenster und die Projektordner-Schaltflaeche wurden sichtbar bestaetigt; die Windows-Aufnahmehilfe lieferte jedoch keine Klickgeometrie fuer den nativen Dialog. Echte Datei-/Computerfreigaben und ein signierter Installer benoetigen weiterhin eine interaktive Laufzeitabnahme.
- Der lokale NSIS-Installer wurde gebaut, aber nicht installiert. Produktions-Updater, Zertifikatsimport, Code-Signing, veroeffentlichter Update-/Rollback-Pfad und der gemeinsam bediente Ordnerdialog-/Approval-Smoke bleiben externe Abnahmen.
