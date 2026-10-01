# Isolated Luczor functional checks

These checks use a fresh run UUID, synthetic data and separate stores. They never import a user's projects, memories, browser cookies, API credentials or production diagnostics. The launcher generates a separate app identity and local Laravel test database. No production model process is reused or stopped.

## Run on Windows

From the `app` repository, validate isolation without starting a process:

```powershell
.\scripts\with-pinned-node.ps1 node.exe scripts/run-isolated-functional-test.mjs --validate-only
```

Start the temporary Laravel control plane and request a real local-model test:

```powershell
.\scripts\with-pinned-node.ps1 node.exe scripts/run-isolated-functional-test.mjs --control-plane-smoke --model-smoke --php C:\xampp\php\php.exe --asset-root D:\Luczor\local-model-test
```

The model test runs only when no resident `llama-server` exists, capacity is confirmed and installed assets match the pinned SHA-256 profile. It uses a separate owned loopback process and reads existing model assets without modifying them. It downloads nothing. A busy model, unknown availability or insufficient capacity produces `WAITING`; it does not attach to the existing runtime. Only the test's own process is stopped afterward.

Run the focused synthetic checks without an actual model:

```powershell
.\scripts\with-pinned-node.ps1 node.exe node_modules/vitest/vitest.mjs run tests/unit/isolatedDreamAcceptance.test.ts tests/unit/memoryDreamPanel.test.ts tests/unit/dreamTrace.test.ts
```

## Dreaming contract and expected results

`dreamAcceptance.ts` reuses the production `IdleContextOptimizer`, maintenance prompts, schema parsers, exact-reference checks and independent verification parser. Its injected generator receives `{runId, stage, messages, maxTokens, signal}` and returns public `{content, finishReason, toolCalls?}`. Proposal and verification are separate calls with the existing 768-token test budget. Private reasoning is not retained.

The synthetic proposal and production prompt now share `MEMORY_OPERATION_CONTRACT`: rewrite requires one target, merge at least two distinct targets, and add/conflict/noop require an explicit empty targets array. Target IDs must also occur in sources and cannot be reused by another operation. This clarification provides no dataset-specific answer and does not repair IDs. Production permits one model correction of a structural proposal failure only after fresh local evidence, consent and owner checks. Independent verification is still required. A real-model rerun is needed to establish whether it resolves the previously observed `invalid_targets` failure.

The synthetic corpus contains two identical facts with a real-looking but fictional relative path and a review constraint, plus two unconfirmed color observations that contradict each other. `PASS` requires a merge of the duplicate pair, preservation of the path/review constraint, a conflict entry retaining both colors and their unresolved status, and an approved independent verification. A no-op, an omitted conflict or a silently decided observation does not pass merely because the verifier approves. These dataset assertions exist only in this test harness; they do not alter production maintenance rules.

The file store persists verified synthetic receipts atomically under the explicit per-run path. Source hashes are rechecked before commit; repeated receipts are idempotent. Reloading the same test identity reuses a valid receipt without another model call. A different identity is rejected. Original corpus sources are retained as evidence rather than overwritten.

Covered failure scenarios include foreground interruption with actual model drain, changed source revisions, incomplete streams, output truncation, invalid JSON, fabricated references and rejected verification. None may produce a successful receipt. Manual and idle startup are tested separately. Test intervals are short; production timing is unchanged.

## Evidence and acceptance limits

Launcher summaries use `luczor-isolated-functional-v1`, one shared `runId` and separate `PASS`, `FAIL`, `WAITING` or `NOT_RUN` phases. Generated summaries reside under the workspace's `.lmzdev/artifacts/reports`; model evidence is grouped by run UUID. Dream events identify proposal, verification, commit and settlement phases. Secrets and private reasoning are excluded.

A dream `PASS` proves the optimizer/maintenance **core integration** with synthetic receipt persistence. It does **not** prove the complete installed worker, production memory facade, native memory database migration or knowledge-space UI applied a rewrite. Native browser tests are separate and cannot be inferred from a model-generated action plan or a Vite preview. Linux requires its own device acceptance. A waiting or unrun phase must remain visible and must not be described as passed.

`tests/unit/isolatedDreamWorkerPersistence.test.ts` additionally runs the actual maintenance worker, memory facade, encryption and commit journal against test-owned temporary files. It checks one correction, independent verification, an atomic rewrite, service reload, and preservation of original data on two invalid proposals. Model responses and the native Store boundary are replaced in that regression test; it is not a real-model/native-client acceptance. These distinctions must remain explicit in reports.

The small production UI correction tracks a newer dream by run ID/start time, removes obsolete skip reasons and clears the message when its account trace is reset. The regression suite verifies that a declined manual request cannot mask the later automatic run's real failure.
