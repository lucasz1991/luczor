#!/usr/bin/env bash
set -euo pipefail

mode="${1:---check}"
case "$mode" in --install|--check|--install-media|--install-control) ;; *) echo 'Usage: bash scripts/setup-desktop.sh [--check|--install|--install-media|--install-control]'; exit 2 ;; esac
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="$(uname -s)"
cd "$project_dir"

install_linux_media() {
  if command -v apt-get >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-pipewire
  elif command -v dnf >/dev/null; then
    sudo dnf install -y gstreamer1 gstreamer1-plugins-base \
      gstreamer1-plugins-good gstreamer1-plugins-bad-free pipewire-gstreamer
  else
    echo 'Install GStreamer tools and the plugins providing fakevideosink and webvttenc.'; return 1
  fi
}

install_linux_control() {
  # Select the portal matching the desktop, not an arbitrary competing backend.
  local desktop="${XDG_CURRENT_DESKTOP:-}"
  if command -v apt-get >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y xdg-desktop-portal pipewire dbus-user-session at-spi2-core \
      libglib2.0-bin libatspi2.0-dev libx11-dev
    case "${desktop,,}" in
      *kde*) sudo apt-get install -y xdg-desktop-portal-kde ;;
      *gnome*|*ubuntu*) sudo apt-get install -y xdg-desktop-portal-gnome ;;
      *) echo 'Use the RemoteDesktop-capable portal provided by your desktop environment.' ;;
    esac
  elif command -v dnf >/dev/null; then
    sudo dnf install -y xdg-desktop-portal pipewire dbus-daemon at-spi2-core at-spi2-core-devel glib2 libX11-devel
    case "${desktop,,}" in
      *kde*) sudo dnf install -y xdg-desktop-portal-kde ;;
      *gnome*) sudo dnf install -y xdg-desktop-portal-gnome ;;
      *) echo 'Use the RemoteDesktop-capable portal provided by your desktop environment.' ;;
    esac
  else
    echo 'Install XDG Desktop Portal, your desktop RemoteDesktop backend, PipeWire and AT-SPI.'; return 1
  fi
  echo 'Desktop sharing permissions are requested by Luczor in the current user session. No system permission is bypassed.'
}

if [[ "$mode" == --install-control ]]; then
  if [[ "$platform" != Linux ]]; then echo 'Linux desktop control dependencies are only needed on Linux.'; exit 0; fi
  install_linux_control
  exit 0
fi

if [[ "$mode" == --install-media ]]; then
  if [[ "$platform" != Linux ]]; then echo 'Linux multimedia repair is only needed on Linux.'; exit 0; fi
  install_linux_media
  for element in fakevideosink webvttenc; do
    gst-inspect-1.0 "$element" >/dev/null
    echo "OK: $element"
  done
  exit 0
fi

if [[ "$mode" == --install ]]; then
  case "$platform" in
    Linux)
      install_linux_media
      install_linux_control
      if command -v apt-get >/dev/null; then
        sudo apt-get update
        sudo apt-get install -y curl ca-certificates git build-essential pkg-config \
          libssl-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
          patchelf cmake libpipewire-0.3-dev clang libclang-dev libgbm-dev libxdo-dev \
          libwayland-dev libegl1-mesa-dev libxcb1-dev
      elif command -v dnf >/dev/null; then
        sudo dnf install -y curl ca-certificates git gcc gcc-c++ make pkgconf-pkg-config \
          openssl-devel webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel \
          patchelf cmake pipewire-devel clang clang-devel mesa-libgbm-devel libxdo-devel \
          wayland-devel mesa-libEGL-devel libxcb-devel
      else
        echo 'Unsupported package manager. Install Tauri 2, PipeWire, GBM, Clang and libxdo development packages.'; exit 1
      fi
      ;;
    Darwin)
      if ! command -v cmake >/dev/null; then
        echo 'Install CMake on the build machine (for example: brew install cmake), then retry.'; exit 1
      fi
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
for tool in node pnpm cargo rustc clang cmake; do
  if command -v "$tool" >/dev/null; then "$tool" --version; else echo "Missing: $tool"; failed=1; fi
done
if command -v node >/dev/null; then node scripts/release-readiness.cjs --mode node || failed=1; fi
if command -v pnpm >/dev/null && [[ "$(pnpm --version)" != 10.27.0 ]]; then echo 'pnpm 10.27.0 required'; failed=1; fi
if [[ "$platform" == Linux ]]; then
  if command -v node >/dev/null; then node scripts/linux-media-check.cjs || failed=1; fi
  for library in webkit2gtk-4.1 ayatana-appindicator3-0.1 libpipewire-0.3 gbm wayland-client egl; do
    if pkg-config --exists "$library"; then echo "OK: $library"; else echo "Missing: $library development files"; failed=1; fi
  done
  if [[ ! -f /usr/include/xdo.h ]] || [[ "$(cc -print-file-name=libxdo.so)" == libxdo.so ]]; then
    echo 'Missing: libxdo development files'; failed=1
  else
    echo 'OK: libxdo'
  fi
  if [[ "${XDG_SESSION_TYPE:-}" == wayland ]]; then
    for element in pipewiresrc pngenc; do
      if gst-inspect-1.0 "$element" >/dev/null 2>&1; then echo "OK: $element"; else
        echo "Desktop capture unavailable: missing $element; run --install-media."; failed=1
      fi
    done
    if command -v gdbus >/dev/null && gdbus introspect --session --dest org.freedesktop.portal.Desktop \
      --object-path /org/freedesktop/portal/desktop 2>/dev/null | grep -q org.freedesktop.portal.RemoteDesktop; then
      echo 'OK: RemoteDesktop portal is advertised (user permission is checked at runtime).'
    else
      echo 'Desktop control unavailable: this session does not advertise a RemoteDesktop portal. Run --install-control and log in to a supported desktop session.'
    fi
  fi
elif [[ "$platform" == Darwin ]]; then
  xcode-select -p || failed=1
fi
exit "$failed"
