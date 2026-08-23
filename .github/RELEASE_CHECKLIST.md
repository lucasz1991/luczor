# Luczor release checklist

The `Release readiness` workflow is deliberately manual and does not publish artifacts. It fails closed until updater trust and platform signing are fully configured.

## Repository checks

- `pnpm version:check` confirms that `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` use the same version.
- The complete desktop CI workflow must pass on the release commit.
- The release tag must match the verified manifest version.
- Build only from the protected release branch or an approved tag in `lucasz1991/luczor`.

## Updater trust prerequisites

Do not enable the updater with placeholder values.

- Add and register `tauri-plugin-updater` in the Rust runtime.
- Set `bundle.createUpdaterArtifacts` to `true`.
- Configure an HTTPS updater endpoint and its real public verification key under `plugins.updater`.
- Store the matching private key only as GitHub secret `TAURI_SIGNING_PRIVATE_KEY`.
- Store its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Test a signed update from an older production build before publishing automatically.

## Platform signing secrets

The readiness gate expects this initial CI signing strategy:

- Windows PFX: `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`.
- macOS certificate and notarization: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

Azure Artifact Signing can replace the Windows PFX route later, but its account, certificate profile, and GitHub OIDC permissions must be reviewed before the workflow is changed.

## Publishing boundary

Only add a publishing workflow after the readiness gate is green and the exact GitHub Release updater endpoint is confirmed. The publishing job must import the platform certificates into temporary runner storage, use the project-local PNPM/Tauri CLI, create a draft release first, verify native signatures plus updater signatures, and clean temporary certificate files even when a build fails.
