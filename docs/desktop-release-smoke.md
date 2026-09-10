# Desktop release and local installer smoke test

This path deliberately separates a local test installer from a publishable Luczor release.

The managed Claude runtime is bundled only by `src-tauri/tauri.windows.conf.json`
for Windows x64. Linux and macOS builds use the shared Tauri configuration without
that Windows resource and report Claude as unavailable until a signed,
platform-matching runtime is supplied. The ordinary local `llama-server` path is
independent of this optional bundle.

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

## Local model paths for normal desktop launches

Normal desktop launches read `local-model/runtime-paths.json` inside the current app identity's Tauri `app_data_dir()`. On Windows the standard app uses `%APPDATA%\de.luczor.desktop\local-model\runtime-paths.json`; `Luczor Local Test` uses its separate `de.luczor.desktop.local-test` directory. This file is local configuration outside the checkout and contains paths only, without provider keys or signing keys.

Create a UTF-8 JSON file without a BOM using exactly these three fields. The paths below are examples; replace both with absolute paths to already installed assets on the current computer:

```json
{
  "version": 1,
  "runtime_path": "C:/Example/llama.cpp/llama-server.exe",
  "model_directory": "C:/Example/models"
}
```

- `runtime_path` points to the actual runtime executable. `model_directory` contains `<model_release_id>.gguf`, using the exact release ID from the signed catalog, not the display name.
- Only schema version `1` is accepted; missing or extra fields and files larger than 16 KiB are rejected. Paths are literal: environment-variable placeholders are not expanded. Forward slashes avoid JSON backslash escaping on Windows.
- Both configured assets and the configuration file, including their parent directories, must be free of symbolic links, junctions and other Windows reparse points. The runtime and GGUF must exist, and the GGUF must remain within the configured model directory.
- A complete process-environment pair, `LUCZOR_LLAMA_CPP_BIN` plus `LUCZOR_LOCAL_MODEL_DIR`, overrides the saved file. Setting only one variable fails; the app never combines environment and saved paths. The isolated test launcher supplies its own pair and continues to use its separate test profile.

Restart Luczor after changing the configuration to clear existing runtime/readiness state. Test the server connection to verify the signed policy, then send a short chat request with the external-fallback option off. The catalog must enable the local release and contain matching artifact/runtime hashes and capacity requirements; preparation also verifies the files, storage, available hardware and signed benchmark thresholds. A successful connection check alone does not establish local model readiness. This path configuration does not download models or override those checks.

### Prepared models remain loaded

Successful preparation leaves the verified llama.cpp process running. Its fixed public benchmark does not claim a private conversation scope: the first chat request claims the already loaded process, and subsequent requests in that same scope reuse it. Preparation hashes the model and executable once at process startup and holds their artifact guards for the process lifetime.

The ten-minute readiness lease remains bounded by the signed manifest expiry. Renewing that lease for the same successfully prepared resident process checks process/listener ownership and authenticated health, without loading the weights again, repeating the benchmark or applying free-RAM startup thresholds to memory already occupied by the model. A renewal never clears the existing conversation scope. It cannot renew a different catalog or a process that has not passed preparation.

There is no inactivity unload timer. App shutdown, explicit stop/cancellation, runtime failure, model or private-scope changes and catalog/session replacement still release the process. A rejected oversized input is not a runtime failure: the model stays loaded and neither native nor frontend health enters cooldown. Prompt caching remains disabled. Keeping the model loaded intentionally keeps its RAM/VRAM allocated; this does not preserve it across app or Windows restarts.

For a real native acceptance check, record the owned llama.cpp PID during initial preparation, after the first reply, after a readiness renewal and after a second reply. They must be identical for an unchanged scope and catalog. Also verify a real local answer, no external chat requests, and the ready state after an idle interval. Frontend clock-based expiry tests alone do not establish process reuse.

### Long conversations and the real context window

The live catalog `2026090602` increases Orca's context from 8,192 to 32,768 tokens. This is a finite, hardware-dependent context window; `--ctx-size 0` would use the model's declared maximum, not make context unlimited. Other installations continue to use their signed catalog. The source evaluation fixture still describes the earlier 8,192-token baseline.

Before every local generation, native code sends the exact completion body, including all tools and chat-template settings, to the owned runtime's `/v1/chat/completions/input_tokens` endpoint. It reserves answer space and a small margin. If necessary, it removes complete older conversation rounds from the transient request, preserving system messages and assistant/tool pairing. Large tool results can retain explicitly marked beginning/end excerpts. The current user request, system policy and tool schemas are never silently truncated. The chat archive is not changed, and the final answer displays a notice when model context was shortened.

If only the requested output reservation is too large, it uses the actual remaining answer space. If the current request itself still cannot fit, Luczor gives a German explanation to process large files in sections and keeps the model ready. Native input/response/time bounds remain in force. There is no claim of unlimited context or lossless summarization.

Endpoint contract: [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/5266f24da/tools/server/README.md); the installed b10809 runtime uses commit `5266f24da`.

## Local chat-template role regression

The native local transport combines all text system instructions, in their original
order, into one leading system message before token counting and generation. This
covers runtime mode, tool descriptions, planning discussion and late retry guidance.
User/assistant messages, tool-call IDs and tool results keep their roles and order;
the saved archive and approved external request are unchanged.

Test an ordinary chat, a plan discussion and a round with two tool results on the
installed GGUF. None should fail with `runtime_chat_history_rejected`. Repeat with
a long older conversation to exercise context fitting. An input role rejection
must leave the local process available for the next valid request, with no cooldown.
Native regression fixtures are in `src-tauri/tests/fixtures/local-system-messages.json`.

Also test an assistant round containing one successful call and one call with
truncated JSON arguments. The failed call must not execute. Its history copy uses
`{}` plus an explicit failed tool result explaining the replacement, allowing the
model to emit corrected arguments on the next round. Valid sibling calls and
original execution arguments must remain unchanged. Non-object JSON arguments
are handled the same way; schema, approval and workspace checks remain mandatory.
Native callers that bypass the agent repair receive `runtime_tool_contract_rejected`
before template rendering, without terminating the resident model or adding cooldown.

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
