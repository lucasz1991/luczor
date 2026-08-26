# Luczor Desktop

Tauri-2-Desktop-Client für Luczor. Die Vue-3-Anwendung verbindet den lokalen Chat-/Agent-Loop mit der Laravel-Control-Plane und stellt ausschließlich freigegebene native Desktop-, Voice-, Workflow- und Browserfunktionen bereit.

## Voraussetzungen

- Node.js 22.22.0 fuer reproduzierbare lokale Builds (`.nvmrc`); unterstuetzter Bereich: Node 22.12 bis kleiner 23
- Corepack und PNPM
- Rust Stable
- Tauri-2-Systemvoraussetzungen für das Zielbetriebssystem

## Entwicklung

```powershell
$version = (Get-Content .nvmrc -Raw).Trim()
nvm install $version 64
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 node.exe --version
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 corepack.cmd pnpm install --frozen-lockfile
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 corepack.cmd pnpm tauri dev
```

Der Vite-Dev-Server läuft über `pnpm vite:dev`. Das native Fenster und die Rust-Kommandos werden über Tauri gestartet.
Der Wrapper verwendet die installierte NVM-Version nur in seinem eigenen Prozess und fuehrt bewusst kein global wirkendes `nvm use` aus.

## Qualitätsprüfungen

```powershell
pnpm lint
pnpm type-check
pnpm test --run
pnpm test --run --coverage
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Sicherheitsgrenzen

- Provider-Schlüssel gehören ausschließlich in das Laravel-Backend.
- Der Device-Key wird in der nativen OS-Keychain gespeichert, nicht im allgemeinen Settings-JSON.
- Jede Tauri-Capability folgt Least Privilege; Remote-Webviews erhalten keine Desktop-, Datei-, Script- oder Agent-Kommandos.
- Mutierende oder sensible Tools bleiben an Modus, Freigabe und feste Tool-Profile gebunden.
- Netzwerkzugriffe brauchen Zeit-, Redirect- und Größenlimits. Loopback/private Ziele sind nur nach ausdrücklicher Freigabe zulässig.
- Debug-Exporte dürfen keine Schlüssel, Authorization-Header oder unredigierte persönliche Inhalte enthalten.

## Release

```powershell
pnpm bump 2.9.4
pnpm build
pnpm tauri build
```

Das Bump-Script muss `package.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` konsistent aktualisieren. Ein Release ist erst gültig, wenn Tests, Lints, Security-Audits, Signatur und Update-/Rollback-Pfad geprüft wurden.

Einen getrennten, ausdruecklich unsignierten Windows-Testinstaller baut:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-test-installer.ps1
```

Dieser lokale NSIS-Build besitzt eine eigene Testidentitaet und darf nicht veroeffentlicht werden. Der genaue Ordnerdialog-/Approval-Smoke sowie die weiterhin fail-closed bleibenden Produktionsvoraussetzungen stehen in [`docs/desktop-release-smoke.md`](docs/desktop-release-smoke.md).

Der Workspace-übergreifende Betriebsleitfaden liegt in `../README.md`.
