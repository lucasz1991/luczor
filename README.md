# Luczor Desktop

Stichtag: 2026-09-06

Tauri-2-/Vue-3-Desktop-Client für Luczor. Die App besitzt Chat, lokale Inferenz, privaten Gerätezustand und native Werkzeuge. Laravel bleibt eine getrennte Control-Plane für Identität, Policy, signierte Kataloge und gemeinsame Daten.

## Voraussetzungen

- Windows für den aktuell implementierten lokalen `llama.cpp`-Produkt- und Testpfad
- Node.js 22.22.0 über `.nvmrc`; unterstützter Bereich: Node 22.12 bis kleiner 23
- Corepack und pnpm 10.27.0
- Rust Stable und die Tauri-2-Systemvoraussetzungen
- für die isolierten Modelltests die bereits gepinnten Assets unter standardmäßig `D:\Luczor\local-model-test`

## Entwicklung

```powershell
$version = (Get-Content .nvmrc -Raw).Trim()
nvm install $version 64
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 node.exe --version
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 corepack.cmd pnpm install --frozen-lockfile
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 corepack.cmd pnpm tauri dev
```

Der Wrapper aktiviert die gepinnte NVM-Version nur für seinen Kindprozess und verändert den globalen NVM-Symlink nicht.

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

Testzahlen sind nur zusammen mit Datum und Dirty-/Commit-Zustand belastbar. Der lokale Modellpfad befindet sich am Stichtag in einem Dirty Worktree; ein statischer Parser- oder Unit-Test ist kein realer Modell-E2E.

## Gepinntes lokales Testprofil

`scripts/local-model-test.profile.json` ist die gemeinsame Quelle für beide folgenden Starter. Es bindet:

- OrcaRouter Qwen3.8-27B Uncensored Q4_K_M: 17.772.538.112 Bytes, SHA-256 `6c8c7658fe13eef22666aa89862f7fb70aa72109838cf19989e59b15875e5e08`;
- `llama-server.exe`: llama.cpp b10809 / Commit `5266f24da` / CUDA 12.4, SHA-256 `cb29f66008d4d73cce17cab2c2569ab318eb244b0b2ca2a15024b44d90dfcd3f`;
- Node 22.22.0 und pnpm 10.27.0 samt Dateipins;
- Capacity-Grenzen und einen isolierten signierten Testkatalog.

Es werden keine Assets heruntergeladen. Das Produktions-Standardmanifest bleibt davon getrennt und aktiviert kein lokales Modell.

## Testweg A: direkter lokaler Chat

`scripts/run-local-model-chat.ps1` startet dieselben gepinnten GGUF-/Runtime-Assets unabhängig von Laravel, Tauri und Luczor. Dieser Weg eignet sich für einen direkten Runtime-/WebUI-Smoke, ist aber kein Luczor-App-E2E.

Nur Pins und Dateien prüfen, ohne ein Modell zu starten:

```powershell
cd E:\projekte\luczor\app
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local-model-chat.ps1 -ValidateOnly
```

Direkten Chat auf `127.0.0.1:8089` starten und den zufälligen Key kurzzeitig in die Zwischenablage legen:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local-model-chat.ps1 -CopyAccessKey
```

Der Starter prüft zunächst den vollständigen Modellhash, Runtime-/Archivpins, die erwarteten Runtime-Dateien, RAM, freien VRAM und festen Speicher. Danach reserviert er den Loopback-Port, erzeugt einen privaten Laufordner und einen zufälligen API-Key, startet die Runtime versteckt und verlangt den echten Marker `LUCZOR_DIRECT_CHAT_OK`. Ein Zugriff ohne Key muss mit 401 scheitern.

Den kopierten Key in das API-Key-Feld der lokalen Browseroberfläche einfügen. Er wird weder ausgegeben noch an die URL oder den Smoke-Report angehängt. Serverausgaben und der Key liegen nur im ACL-geschützten Laufordner. Mit Enter im Starter-Terminal wird ausschließlich der eigene Runtime-Prozess beendet; die temporäre Keydatei wird entfernt und ein nur von Luczor gesetzter Clipboardwert nach Möglichkeit wiederhergestellt.

Nützliche Optionen:

- `-NoBrowser`: Browser nicht automatisch öffnen;
- `-SmokeOnly`: echten Marker testen und anschließend sofort kontrolliert stoppen;
- `-Port <1024..65535>`: abweichenden Loopback-Port verwenden;
- `-AssetRoot <Pfad>`: anderes bereits vollständig gepinntes Assetroot verwenden.

Am 2026-09-06 lieferte dieser direkte Pfad den Marker in 800 ms und wies den Request ohne Key ab. Das ist laufgebundene Dirty-Worktree-Evidenz, keine Produktfreigabe.

## Testweg B: vollständiger Luczor-Runner

`scripts/run-local-model-test.ps1` prüft den signierten Pfad Laravel → Tauri → Vue → lokale Runtime. Er verwendet keine Produktdaten:

- dediziertes privates Runroot außerhalb beider Checkouts;
- isolierte SQLite-Datenbank und externe Storage-/View-/Cachepfade;
- ein isoliertes `APP_ENV=local` und einen acht Stunden gültigen Key mit exakt `settings.read`;
- extern erzeugte Test-Signierschlüssel und einen Testkatalog, in dem nur OrcaRouter aktiv ist;
- Loopback-Laravel, gepinnte Node-/pnpm-Werkzeuge, Tauri-Testkonfiguration und CDP-Smoke;
- isoliertes Testprojekt, deaktiviertes Server-Memory und keine externe Inferenz.

Vorprüfung ohne Laravel-, Tauri- oder Modelllauf:

```powershell
cd E:\projekte\luczor\app
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local-model-test.ps1 -ValidateOnly
```

Automatischen vollständigen E2E starten:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local-model-test.ps1
```

Automatischen Marker-Smoke ausführen und die Test-App danach für eine manuelle Prüfung offen lassen:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local-model-test.ps1 -Interactive
```

`-Interactive` wird an `scripts/local-model-e2e-smoke.mjs` weitergereicht. Der automatische Test muss zuerst über `local_llama_cpp` exakt `LUCZOR_LOCAL_E2E_OK` liefern. Danach beendet Enter die Sitzung kontrolliert und löst das gemeinsame Cleanup aus.

Ein bestandener Lauf schreibt genau einen neuen Report nach:

```text
$AssetRoot\reports\local-model-e2e-<runId>.json
```

Am Stichtag ist dieser Reportordner leer; der vollständige Luczor-App-E2E ist daher noch offen. Der erste Versuch vom 2026-09-06 stoppte vor GPU-/Modellstart an einem Windows-Cachepfadfehler im Laravel-Package-Manifest. Der anschließend ergänzte Bootstrap-Fix ist durch einen echten `Filesystem::replace`-Regressionstest (1 Test / 3 Assertions) belegt; erst der Wiederholungslauf kann den App-E2E schließen.

## Gemeinsame Runtime-Sperre und Cleanup

Beide Starter verwenden `$AssetRoot\runtime-owner.lock`:

- `FileMode.OpenOrCreate`, Read/Write und `FileShare.None`;
- exklusiver Handle von vor dem Runtime-Start bis zum letzten Cleanup-Schritt;
- persistente Datei, die der Vollrunner mit Schema-1-Metadaten beschreibt; der Direktstarter teilt Pfad und exklusiven Handle, und keiner löscht die Datei zur Stale-Recovery;
- jeder bereits laufende `llama-server.exe` blockiert einen neuen Start fail-closed;
- kein Starter beendet einen fremden Prozess.

Der vollständige Runner bindet eigene Prozesse an PID plus Startzeit. Im Cleanup stoppt er nur diese Prozessbäume, entfernt Token, temporäre Laravel-`.env.local` und Config-Cache, stellt alle übernommenen Umgebungsvariablen einzeln wieder her und prüft Loopback-Ports sowie das Fehlen einer verbliebenen Modellruntime. Primär- und Cleanupfehler werden gemeinsam gemeldet.

## Laravel-Testbootstrap

Der Runner ruft im benachbarten Checkout den Befehl mit allen drei Pfaden auf:

```text
php artisan luczor:local-model-test:bootstrap --test-root=<absolutes-isoliertes-Root> --database-file=<SQLite-Datei-im-Root> --token-file=<geschützte-Datei-im-Root>
```

Der Vertrag gilt nur für `local`/`testing` und tatsächliches SQLite. Details stehen in `../admin_api_app/README.md`.

## Sicherheitsgrenzen

- Provider-Schlüssel gehören ausschließlich in die Laravel-Control-Plane.
- Der Device-Key liegt in der nativen OS-Keychain, nicht im allgemeinen Settings-JSON.
- Remote-Webviews erhalten keine allgemeinen Desktop-, Datei-, Script- oder Agent-Kommandos.
- Sensible/mutierende Tools bleiben an Capability, Modus, Projekt, Freigabe und native Nachprüfung gebunden.
- Private Memory-, Repository- und ephemere Tooldaten werden nicht automatisch synchronisiert.
- Netzwerkzugriffe brauchen Ziel-, Redirect-, Zeit- und Größenlimits.
- Reports und Diagnosepfade dürfen keine Authorization-Header, API-Keys oder beliebigen Benutzerinhalte enthalten; der E2E-Report bindet nur den festen Smoke-Prompt und dessen Marker.

## Release

```powershell
pnpm bump 2.9.4
pnpm build
pnpm tauri build
```

`package.json`, `src-tauri/Cargo.toml` und `src-tauri/tauri.conf.json` müssen dieselbe Version tragen. Ein Release verlangt Tests, Lints, Audit, Signatur, Installer-, Update- und Rollback-Abnahme.

Ein ausdrücklich unsignierter Windows-Testinstaller mit eigener Identität:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-test-installer.ps1
```

Er darf nicht veröffentlicht werden. Der Release-Smoke steht in `docs/desktop-release-smoke.md`; der workspaceweite Stand in `../README.md`.
