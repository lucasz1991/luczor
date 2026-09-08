#!/usr/bin/env bash
set -euo pipefail

mode="${1:---check}"
case "$mode" in --install|--check) ;; *) echo 'Usage: bash scripts/setup-desktop.sh [--check|--install]'; exit 2 ;; esac
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="$(uname -s)"
cd "$project_dir"

if [[ "$mode" == --install ]]; then
  case "$platform" in
    Linux)
      if command -v apt-get >/dev/null; then
        sudo apt-get update
        sudo apt-get install -y curl ca-certificates git build-essential pkg-config \
          libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
          patchelf libpipewire-0.3-dev clang libclang-dev libgbm-dev libxdo-dev \
          libwayland-dev libegl1-mesa-dev libxcb1-dev
      elif command -v dnf >/dev/null; then
        sudo dnf install -y curl ca-certificates git gcc gcc-c++ make pkgconf-pkg-config \
          openssl-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel \
          patchelf pipewire-devel clang clang-devel mesa-libgbm-devel libxdo-devel \
          wayland-devel mesa-libEGL-devel libxcb-devel
      else
        echo 'Unsupported package manager. Install Tauri 2, PipeWire, GBM, Clang and libxdo development packages.'; exit 1
      fi
      ;;
    Darwin)
      if ! xcode-select -p >/dev/null 2>&1; then
        xcode-select --install
        echo 'Complete the Apple Command Line Tools installer, then run this script again.'; exit 1
      fi
      ;;
    *) echo 'Use the existing PowerShell setup on Windows.'; exit 1 ;;
  esac

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    installer="$(mktemp)"
    curl --fail --location --proto '=https' --tlsv1.2 \
      https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh -o "$installer"
    bash "$installer"
    rm -- "$installer"
  fi
  # nvm is not nounset-safe on every supported version.
  set +u
  . "$NVM_DIR/nvm.sh"
  nvm install "$(tr -d '\r\n' < .nvmrc)"
  nvm use
  set -u
  if [[ ! -x "$HOME/.cargo/bin/rustup" ]] && ! command -v rustup >/dev/null; then
    installer="$(mktemp)"
    curl --fail --location --proto '=https' --tlsv1.2 https://sh.rustup.rs -o "$installer"
    sh "$installer" -y --profile minimal
    rm -- "$installer"
  fi
  [[ ! -s "$HOME/.cargo/env" ]] || . "$HOME/.cargo/env"
  rustup toolchain install stable --profile minimal --component rustfmt --component clippy
  if command -v corepack >/dev/null; then corepack disable; fi
  npm install --global pnpm@10.27.0
  pnpm install --frozen-lockfile
fi

[[ ! -s "$HOME/.cargo/env" ]] || . "$HOME/.cargo/env"
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  set +u
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use --silent || true
  set -u
fi
failed=0
for tool in node pnpm cargo rustc clang; do
  if command -v "$tool" >/dev/null; then "$tool" --version; else echo "Missing: $tool"; failed=1; fi
done
if command -v node >/dev/null; then node scripts/release-readiness.cjs --mode node || failed=1; fi
if command -v pnpm >/dev/null && [[ "$(pnpm --version)" != 10.27.0 ]]; then echo 'pnpm 10.27.0 required'; failed=1; fi
if [[ "$platform" == Linux ]]; then
  for library in webkit2gtk-4.1 ayatana-appindicator3-0.1 libpipewire-0.3 gbm wayland-client egl; do
    if pkg-config --exists "$library"; then echo "OK: $library"; else echo "Missing: $library development files"; failed=1; fi
  done
  if [[ ! -f /usr/include/xdo.h ]] || [[ "$(cc -print-file-name=libxdo.so)" == libxdo.so ]]; then
    echo 'Missing: libxdo development files'; failed=1
  else
    echo 'OK: libxdo'
  fi
elif [[ "$platform" == Darwin ]]; then
  xcode-select -p || failed=1
fi
exit "$failed"
