# Linux and macOS setup

## Development on a new machine

From a checkout, run:

```sh
bash scripts/setup-desktop.sh --install
```

The script installs Debian/Ubuntu or Fedora build libraries, the Node version in
`.nvmrc`, pnpm 10.27.0, Rust and locked frontend dependencies. On macOS it uses
Apple Command Line Tools; if absent, finish Apple's installer and rerun the script.
No Homebrew installation is needed for the default desktop build.

Open a new terminal, then:

```sh
nvm use
pnpm doctor:desktop
pnpm tauri dev
```

The Tauri launcher selects a free port starting at 1420 and gives the same port
to Vite and the WebView. Other running projects are not stopped. `pnpm dev` still
uses the fixed frontend-only port; use `pnpm tauri dev` for the complete app.

To create a local Debian package, run `pnpm tauri build --bundles deb` after the
setup step. The build detects the native host and target architecture and bundles
only the matching Claude package. If that optional package is not installed,
Claude remains visibly unavailable with a concrete readiness reason.

## Installing the app without development tools

Node, pnpm and Rust are build tools and are not required by end users.

On Debian/Ubuntu, install the `.deb` through the package manager, which resolves
WebKitGTK, GTK, PipeWire, GBM, X11/Wayland and libxdo runtime dependencies:

```sh
sudo apt install ./Luczor_VERSION_amd64.deb
```

Use the actual downloaded filename. For portable Linux packages, build on the
oldest supported distribution (the workflow uses Ubuntu 22.04). A package built
locally on Ubuntu 26.04 is only a local test artifact, not proof of compatibility
with older distributions. Fedora development is supported by the setup script;
RPM/AppImage distribution is not included in this workflow.

On macOS 13.3 or later, open the DMG and move Luczor to Applications. The workflow
builds a universal app for Intel and Apple Silicon. macOS supplies the WebView;
microphone, screen recording and accessibility permissions must be granted by
the user in macOS when using those features. These permissions cannot be bundled.

The manual GitHub Actions workflow **Linux and macOS test packages** builds native
packages and uploads artifacts. It does not publish a release. macOS production
distribution still requires Apple signing and notarization, using the existing
release-readiness process. Test builds do not bypass Gatekeeper.

## Models and speech

Model policy and public trust are supplied by the backend. A production deployment
of the signing-key endpoint must exist. Model weights, a platform-matching
`llama-server` runtime and speech assets are separate signed resources; this setup
does not invent artifact hashes or distribute Windows binaries on Linux/macOS.
Their platform builds and signed catalog entries must be provided before these
optional local features are available. PHP/Composer are needed only for developing
the separate backend, not for using the desktop app.

The managed Claude worker is selected per platform and architecture. Windows uses
`claude.exe`/`node.exe`; Linux and macOS use their native `claude`/`node` assets.
The Tauri platform overlays point to the same app-owned resource location, while
the build script copies only the package selected for the current native target.
Cross-target builds are rejected for this bundle because the host Node executable
must have the same platform as the packaged worker. This is independent of the
ordinary Luczor chat and of the local `llama-server` model path.

References: https://v2.tauri.app/start/prerequisites/ and
https://v2.tauri.app/distribute/debian/ and
https://v2.tauri.app/distribute/macos-application-bundle/.
