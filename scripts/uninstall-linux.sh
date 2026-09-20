#!/usr/bin/env bash
# Package-manager removal only. Never delete application data or model/workspace paths.
set -uo pipefail

desktop_mode=false

usage() {
  printf '%s\n' 'Usage: bash uninstall-linux.sh [--package luczor|luczor-local-test] [--check] [--desktop]'
}

package_status() {
  local selected="$1" rows name state
  # Query the database successfully even when this package has no remaining row.
  # A failed query must never be mistaken for a successful uninstall.
  rows="$(dpkg-query --show --showformat='${Package}\t${db:Status-Status}\n' 2>/dev/null)" || return $?
  while IFS=$'\t' read -r name state; do
    if [[ "$name" == "$selected" ]]; then
      printf '%s' "$state"
      return 0
    fi
  done <<< "$rows"
  printf '%s' not-installed
}

main() {
  local package=luczor check_only=false status result
  while (($#)); do
    case "$1" in
      --package)
        if (($# < 2)); then usage >&2; return 2; fi
        package="$2"
        shift 2
        ;;
      --check) check_only=true; shift ;;
      --desktop) desktop_mode=true; shift ;;
      --help|-h) usage; return 0 ;;
      *) usage >&2; return 2 ;;
    esac
  done
  case "$package" in
    luczor|luczor-local-test) ;;
    *) printf '%s\n' 'Es kann nur ein bekanntes Luczor-Paket entfernt werden.' >&2; return 2 ;;
  esac
  if [[ "$(uname -s)" != Linux ]]; then
    printf '%s\n' 'Diese Deinstallation ist für Debian/Ubuntu-Pakete bestimmt.' >&2
    return 2
  fi
  if ! command -v dpkg-query >/dev/null || ! command -v apt-get >/dev/null; then
    printf '%s\n' 'Die Debian-Paketverwaltung ist nicht verfügbar. Ein Quellcode-Start oder AppImage ist kein installiertes DEB-Paket.' >&2
    return 2
  fi
  # Keep the package identity separate from the executable name (tauri-app).
  status="$(package_status "$package")"
  result=$?
  if ((result != 0)); then
    printf 'Die Paketdatenbank für %s konnte nicht gelesen werden.\n' "$package" >&2
    printf '%s\n' 'Für Luczor Local Test: --package luczor-local-test. AppImages und Quellcode-Starts werden hier nicht gelöscht.' >&2
    return "$result"
  fi
  case "$status" in
    not-installed|config-files)
      printf 'Das Programm-Paket %s ist nicht installiert oder bereits entfernt. Persönliche Daten bleiben erhalten.\n' "$package"
      printf '%s\n' 'Die Testversion verwendet --package luczor-local-test. AppImages und Quellcode-Starts werden hier nicht gelöscht.'
      return 0
      ;;
    installed|unpacked|half-installed|half-configured|triggers-awaited|triggers-pending) ;;
    *) printf 'Unbekannter Paketstatus für %s; keine Änderung vorgenommen.\n' "$package" >&2; return 1 ;;
  esac
  printf 'Paket: %s\nStatus: %s\n' "$package" "$status"
  printf '%s\n' 'Chats, Erinnerungen, Einstellungen, Zugangsdaten, Modelle und Projekte bleiben erhalten.'
  printf 'Paketverwaltung: sudo apt-get --no-auto-remove remove -- %s\n' "$package"
  if "$check_only"; then return 0; fi

  printf '\n%s\n' 'Luczor bitte zuvor über das Tray-Menü „Beenden“ schließen. Fenster-X blendet die App nur aus.'
  printf '%s\n' 'Ubuntu zeigt die zu entfernenden Pakete an und fragt vor der Deinstallation nach Bestätigung.'
  # No -y, purge, autoremove, lock deletion or process-name based termination.
  if [[ "$(id -u)" == 0 ]]; then
    apt-get --no-auto-remove remove -- "$package"
  elif command -v sudo >/dev/null; then
    sudo apt-get --no-auto-remove remove -- "$package"
  else
    printf '%s\n' 'Administratorrechte erforderlich. Bitte den oben gezeigten Befehl in einem administrativen Terminal ausführen.' >&2
    return 1
  fi
  result=$?
  if ((result != 0)); then
    printf '%s\n' 'Die Paketverwaltung hat die Entfernung nicht abgeschlossen. Ihre Meldung steht oben; bei belegter Paketsperre später erneut versuchen.' >&2
    return "$result"
  fi

  # APT also returns success when the user declines. Read the actual result.
  status="$(package_status "$package")"
  result=$?
  if ((result != 0)); then
    printf '%s\n' 'Der Abschluss konnte nicht anhand der Paketdatenbank bestätigt werden.' >&2
    return "$result"
  fi
  if [[ "$status" != not-installed && "$status" != config-files ]]; then
    printf '%s\n' 'Das Paket ist weiterhin installiert; die Deinstallation wurde nicht durchgeführt.'
    return 1
  fi
  printf 'Das Paket %s ist entfernt. Persönliche Daten und andere Luczor-Varianten bleiben erhalten.\n' "$package"
}

main "$@"
result=$?
if "$desktop_mode" && [[ -t 0 ]]; then
  printf '\n%s' 'Zum Schließen dieses Fensters Enter drücken … '
  read -r _ || true
fi
exit "$result"
