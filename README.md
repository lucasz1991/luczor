# Luczor Desktop

Tauri-2-Desktop-Client für Luczor. Die Vue-3-Anwendung verbindet den lokalen Chat-/Agent-Loop mit der Laravel-Control-Plane und stellt ausschließlich freigegebene native Desktop-, Voice-, Workflow- und Browserfunktionen bereit.

## Voraussetzungen

- Node.js 22.12 oder neuer
- Corepack und PNPM
- Rust Stable
- Tauri-2-Systemvoraussetzungen für das Zielbetriebssystem

## Entwicklung

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

Der Vite-Dev-Server läuft über `pnpm vite:dev`. Das native Fenster und die Rust-Kommandos werden über Tauri gestartet.

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

Der Workspace-übergreifende Betriebsleitfaden liegt in `../README.md`.
