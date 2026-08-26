# Desktop release and local installer smoke test

This path deliberately separates a local test installer from a publishable Luczor release.

## Pinned Node runtime

The exact Node version lives in `.nvmrc`; `package.json` keeps the supported major range. On Windows, install the pin without changing the globally active NVM symlink:

```powershell
$version = (Get-Content .nvmrc -Raw).Trim()
nvm install $version 64
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 node.exe --version
```

`with-pinned-node.ps1` prepends that NVM directory only inside its own process. It never runs `nvm use`.
The pinned Node installation's own Corepack resolves the `pnpm@10.27.0` value from `package.json`, so this path does not depend on whichever PNPM shim is globally active.

## Unsigned local Windows installer

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-test-installer.ps1
```

The script first runs the local release-readiness gate and then builds an NSIS current-user installer with `--no-sign`. The overlay uses the separate product name `Luczor Local Test` and identifier `de.luczor.desktop.local-test`, so it cannot silently replace the production identity. A direct PE certificate-table check proves that the result is unsigned without depending on a locally loadable PowerShell security module. The installer is a local QA artifact only and must never be published.

Production release readiness remains fail-closed:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/with-pinned-node.ps1 node.exe scripts/release-readiness.cjs --mode production
```

This command must fail until concrete updater endpoints, the updater public key, runtime integration and real signing secrets exist. Never add placeholders to make it pass.

## Joint folder-dialog and approval smoke

Use a disposable test directory containing only synthetic files. Do not select a real source repository for this QA run.

1. Start the installed `Luczor Local Test` app and choose **Projektordner öffnen**.
2. Cancel the native folder dialog once. Confirm that no project binding is created.
3. Open the dialog again and select the disposable directory. Confirm that Luczor shows `@project`, the local display path and the expected Git/non-Git state.
4. Ask Luczor to list a harmless relative file. Reject the approval and confirm that no file content appears.
5. Repeat and approve once. Confirm that the result is marked ephemeral and does not reappear after a new conversation or application restart.
6. Create a new harmless file, approve the write, and verify its content. For replacement writes, verify that a stale SHA-256 confirmation is rejected.
7. Test focus, a small scroll and one harmless hotkey only in a disposable text editor. Keep the emergency stop visible; do not test destructive shortcuts.
8. Remove the project binding. Confirm that the directory and its files remain untouched.
9. Uninstall `Luczor Local Test` after QA. Do not reuse this unsigned build for production data.

Record the installer SHA-256, Windows version, WebView2 version and each pass/fail result. A signed production installer, updater/rollback and real certificate-chain verification remain separate acceptance steps.
