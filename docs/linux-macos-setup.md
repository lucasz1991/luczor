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
setup step. The launcher detects the native host and target architecture and
prepares the matching Claude package when it is available. Development never
declares the optional directory as a static Tauri resource. A package build adds
the resource through Tauri's runtime configuration only after its manifest and
required files exist. If the optional package is not installed, Luczor still
starts and Claude remains visibly unavailable with a concrete readiness reason.

`pnpm tauri dev` also verifies all direct dependencies from `package.json` before
starting Vite. If a checkout has stale or incomplete `node_modules` data after an
update, the launcher runs `pnpm install --frozen-lockfile` once and verifies the
result. This keeps imports such as `@vue-flow/core` consistent on Windows, Linux
and macOS without changing the locked dependency versions.

## Installing the app without development tools

Node, pnpm and Rust are build tools and are not required by end users.

On Debian/Ubuntu, install the `.deb` through the package manager, which resolves
WebKitGTK, GTK, PipeWire, GBM, X11/Wayland and libxdo runtime dependencies:

```sh
sudo apt install ./Luczor_VERSION_amd64.deb
```

Use the actual downloaded filename. The Debian package declares the required GStreamer
base/good/bad plugins as mandatory dependencies, so installation through apt or
a graphical package manager installs them automatically, including when recommended
packages are disabled. Internet access or an existing local package cache is needed
for missing dependencies. A raw `dpkg -i` does not download dependencies; use apt
as shown above. These dependencies also apply when updating an existing installation
with a newly built package. Existing binaries are not updated by source changes.

### Uninstalling on Debian/Ubuntu

Close Luczor through the tray menu **Beenden** first. Window-X only hides the app;
removing a package does not close an already running process.

New DEBs include **Luczor deinstallieren** in the applications menu (English:
**Uninstall Luczor**). It opens a terminal, displays the exact package and asks
for the normal administrator authorization and APT confirmation. A cancelled
confirmation, authorization failure or package-manager lock does not report a
successful uninstall. No package locks are forcibly removed. AppStream metadata
also identifies the app to compatible software managers; available GUI actions
depend on the Ubuntu software manager and its DEB support.

Existing installations can be removed without updating first:

```sh
sudo apt remove luczor
```

The production **package name is `luczor`**, even though its executable is named
`tauri-app`. The separately installed test application uses a different package:

```sh
sudo apt remove luczor-local-test
```

Choose the intended variant. Neither uninstall launcher removes the other one.
To inspect both installed identities first:

```sh
dpkg-query -W -f='${Package}\t${Status}\n' luczor luczor-local-test
```

One missing variant can make that query return a nonzero exit code; it does not
mean that the other displayed installed package is missing.

The source-checkout helper provides the same removal flow for old DEBs:

```sh
bash scripts/uninstall-linux.sh --check
bash scripts/uninstall-linux.sh --package luczor
# For the separate test build:
bash scripts/uninstall-linux.sh --package luczor-local-test
```

`--check` is read-only. Installed helpers live at
`/usr/share/de.luczor.desktop/uninstall.sh` and
`/usr/share/de.luczor.desktop.local-test/uninstall.sh`; they are invoked with
`/bin/bash`, so executable-bit differences from Windows checkouts cannot break
the launcher. The helper removes through APT, never by deleting system files
itself. It does not purge data or run `autoremove`.

Chats, memories, settings, keyring entries, downloaded models and external
project/model directories remain intact. If autostart was enabled, disable it
in Luczor before uninstalling or remove the Luczor entry in the desktop's
Startup Applications settings afterward. A personal autostart entry is separate
from the package-owned application-menu launcher.

An AppImage or a `pnpm tauri dev` checkout has no DEB installation to remove.
The helper reports that the selected package is absent and leaves those files
alone. Stop the development process or portable app and manage its exact file
through the file manager. Do not uninstall shared Node/Rust/system dependencies
just to remove a development checkout.

The package workflow now tests artifact identity, installation and removal,
including preservation of synthetic user data. Its removal checker defaults to
read-only artifact inspection; destructive verification requires an explicit
disposable Linux CI mode. This is not a command to run against a personal
installation.

References: [Ubuntu package management](https://documentation.ubuntu.com/server/how-to/software/package-management/)
and [Tauri Debian file packaging](https://v2.tauri.app/distribute/debian/).

For portable Linux packages, build on the
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

### Existing Linux installs: WebKit multimedia warnings

`fakevideosink not found` and `WebVTT encoder` refer to missing GStreamer
plugins, not CUDA or model memory. Repair only the multimedia packages with:

```sh
bash scripts/setup-desktop.sh --install-media
pnpm tauri dev
```

This does not reinstall Node/Rust or download models. Ubuntu/Debian use
`gstreamer1.0-tools` plus `gstreamer1.0-plugins-base`, `-good`, and `-bad`;
Fedora uses `gstreamer1` plus `gstreamer1-plugins-base`, `-good`, and `-bad-free`.
The repair checks both elements with `gst-inspect-1.0`. The desktop doctor also
checks them; development startup prints an actionable warning without blocking
ordinary chat. New Debian packages require the plugin packages explicitly.

The appindicator deprecation message is separate and does not establish an app
crash. `Finished dev profile` followed by `Running target/debug/tauri-app`
means the build succeeded. Earlier failed invocations in a pasted terminal history
must not be confused with the final invocation.

### Small NVIDIA laptops: diagnose the actual model route

4 GiB of physical VRAM alone does not establish model readiness. In Luczor's
Systemstatus / LocalModel, check the selected model ID, published catalog
availability, installed model and Linux runtime, readiness reason, and GPU offload.
The Qwen3-4B Q4_K_M admin laptop preset is initially a disabled draft; it requires
matching runtime/template/evaluation evidence and catalog publication. Merely
adding the draft does not install or activate the model on any device.

For a hardware snapshot on the affected NVIDIA laptop (read-only):

```sh
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free --format=csv
free -h
```

If NVIDIA's tool cannot connect to the driver, investigate the driver first.
Successful `nvidia-smi` still does not prove the selected llama-server has a CUDA
backend. Use the app's measured readiness/offload status for that conclusion.
Automatic resource mode may distribute layers between GPU and CPU/RAM, subject
to signed model limits; CPU-resident layers also compute on CPU. SSD paging is
not additional fast VRAM. Do not lower memory safeguards to bypass a missing
runtime, unpublished model, or failed readiness probe.

Plugin references:
https://gstreamer.freedesktop.org/documentation/debugutilsbad/fakevideosink.html
and https://gstreamer.freedesktop.org/documentation/subenc/webvttenc.html.

Model policy and public trust are supplied by the backend. A production deployment
of the signing-key endpoint must exist. Model weights, a platform-matching
`llama-server` runtime and speech assets are separate signed resources; this setup
does not invent artifact hashes or distribute Windows binaries on Linux/macOS.
Their platform builds and signed catalog entries must be provided before these
optional local features are available. PHP/Composer are needed only for developing
the separate backend, not for using the desktop app.

The managed Claude worker is selected per platform and architecture. Windows uses
`claude.exe`/`node.exe`; Linux and macOS use their native `claude`/`node` assets.
Static Tauri configurations never require this optional directory. The project
launcher adds it only to a package build whose generated runtime matches the host
and target. Cross-target builds omit the bundle because the host Node executable
must have the same platform as the packaged worker. This is independent of the
ordinary Luczor chat and of the local `llama-server` model path.

References: https://v2.tauri.app/start/prerequisites/ and
https://v2.tauri.app/distribute/debian/ and
https://v2.tauri.app/distribute/macos-application-bundle/.
