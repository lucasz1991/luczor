# Isolated Windows browser acceptance

This opt-in harness tests the real Tauri/WebView2 browser commands against a synthetic loopback page. It does not open production projects, load memories, run inference or reuse user browser profiles. Every run receives a new application identifier and temporary workspace. Reusing a run ID fails rather than reusing browser data.

From the `app` checkout:

```powershell
.\scripts\test-browser-panel-native.ps1 -Isolated
.\scripts\test-browser-panel-native.ps1 -Isolated -Visible -ManualSeconds 180
```

The default command without `-Isolated` retains the existing hidden smoke. The isolated fixture omits unrelated Whisper features, so it does not require libclang. The wrapper embeds the Windows Common Controls manifest required by the test executable.

Optional arguments:

- `-RunId <UUID>` correlates this run with other isolated diagnostics.
- `-ReportPath <absolute new JSON file>` writes evidence within the workspace's central `.lmzdev/artifacts` directory. Its parent directory must exist; existing evidence is never overwritten.
- `-ActionsPath <JSON file>` executes at most eight strictly allowlisted actions after the fixed browser checks. The file is limited to 8 KiB. Its source is **not** assumed to be an AI model. A surrounding runner must independently record genuine model evidence if applicable.

The visible window is titled `Luczor — ISOLIERTER BROWSERTEST — <UUID>`. The manual phase comes first: enter `Manual Luczor`, click **Apply**, choose **Linux**, click **Reveal dynamic action**, click **Dynamic action**, then **Confirm manual check**. Automation starts only after confirmation or the bounded deadline. The evidence distinguishes a confirmed manual check from an expired unconfirmed check. An automation pass alone does not prove manual control.

Allowed action document:

```json
[
  { "action": "fill", "target": "name", "value": "Model Luczor" },
  { "action": "click", "target": "apply" },
  { "action": "select", "target": "platform", "value": "linux" },
  { "action": "click", "target": "reveal" },
  { "action": "click", "target": "dynamic-action" }
]
```

The only additional action is `navigate` with `target` `/first` or `/second`. `platform` allows `linux` or `windows`; name text is limited to 120 UTF-8 bytes without control characters. Extra fields, arbitrary selectors, scripts, domains and paths are rejected before any supplied action runs.

Evidence includes per-stage elapsed time, native results, stable session/run identity, invalid-selector refusal, synthetic download metadata and profile/workspace paths. Fixture text values are synthetic. The test does not capture screenshots of other applications, account credentials or private reasoning. Evidence is preserved for review; test workspaces are not silently removed.

This harness isolates native browser behavior from the installed application's orchestration. Passing it does **not** by itself prove a repaired installed-app bug, a model-driven workflow, Linux/WebKitGTK compatibility or production readiness.
