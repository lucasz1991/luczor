#!/usr/bin/env bash
# Package-manager removal only. Never delete application data or model/workspace paths.
set -uo pipefail

desktop_mode=false
terminal_mode=false
used_dialogs=false

usage() {
  printf '%s\n' 'Usage: bash uninstall-linux.sh [--package luczor|luczor-local-test] [--check] [--desktop] [--terminal]'
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

# The graphical path needs a session, polkit and one dialog tool.
dialog_tool() {
  [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || return 1
  command -v pkexec >/dev/null || return 1
  if command -v zenity >/dev/null; then printf '%s' zenity; return 0; fi
  if command -v kdialog >/dev/null; then printf '%s' kdialog; return 0; fi
  return 1
}

# show <tool> question|info|error <title> <text>
show() {
  local tool="$1" kind="$2" title="$3" text="$4"
  case "$tool:$kind" in
    zenity:question)
      zenity --question --no-markup --width=440 --title="$title" --text="$text" \
        --ok-label='Deinstallieren' --cancel-label='Abbrechen' --default-cancel ;;
    zenity:info) zenity --info --no-markup --width=440 --title="$title" --text="$text" ;;
    zenity:error) zenity --error --no-markup --width=440 --title="$title" --text="$text" ;;
    kdialog:question) kdialog --title "$title" --warningcontinuecancel "$text" ;;
    kdialog:info) kdialog --title "$title" --msgbox "$text" ;;
    kdialog:error) kdialog --title "$title" --error "$text" ;;
  esac
}

# A launcher without a terminal and without dialog tools reopens itself in one.
open_terminal() {
  local package="$1" script
  script="$(readlink -f -- "${BASH_SOURCE[0]}")" || return 1
  set -- /bin/bash "$script" --package "$package" --terminal
  if command -v xdg-terminal-exec >/dev/null; then exec xdg-terminal-exec "$@"; fi
  if command -v gnome-terminal >/dev/null; then exec gnome-terminal -- "$@"; fi
  if command -v konsole >/dev/null; then exec konsole -e "$@"; fi
  if command -v x-terminal-emulator >/dev/null; then exec x-terminal-emulator -e "$@"; fi
  return 1
}

# Remove only this user's autostart entry that starts exactly this package's program.
remove_autostart() {
  local binary="$1" directory file
  [[ "$(id -u)" != 0 && -n "${HOME:-}" ]] || return 0
  directory="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
  [[ -d "$directory" ]] || return 0
  for file in "$directory"/*.desktop; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    if grep -Eq "^Exec=\"?${binary}\"?( |\$)" -- "$file"; then
      rm -f -- "$file" && printf 'Autostart-Eintrag entfernt: %s\n' "$file"
    fi
  done
}

main() {
  local package=luczor binary check_only=false status result tool='' output
  while (($#)); do
    case "$1" in
      --package)
        if (($# < 2)); then usage >&2; return 2; fi
        package="$2"
        shift 2
        ;;
      --check) check_only=true; shift ;;
      --desktop) desktop_mode=true; shift ;;
      --terminal) desktop_mode=true; terminal_mode=true; shift ;;
      --help|-h) usage; return 0 ;;
      *) usage >&2; return 2 ;;
    esac
  done
  # Keep the package identity separate from the executable name (tauri-app).
  case "$package" in
    luczor) binary=/usr/bin/tauri-app ;;
    luczor-local-test) binary=/usr/bin/luczor-local-test ;;
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
  if "$desktop_mode" && ! "$terminal_mode" && ! "$check_only"; then
    tool="$(dialog_tool)" || tool=''
    [[ -z "$tool" ]] || used_dialogs=true
    # Without dialogs the menu entry still has to show something.
    if [[ -z "$tool" && ! -t 0 ]]; then
      open_terminal "$package"
      printf '%s\n' 'Weder Dialogprogramm noch Terminal gefunden. Bitte im Terminal ausführen: sudo apt remove '"$package" >&2
      return 1
    fi
  fi
  status="$(package_status "$package")"
  result=$?
  if ((result != 0)); then
    printf 'Die Paketdatenbank für %s konnte nicht gelesen werden.\n' "$package" >&2
    printf '%s\n' 'Für Luczor Local Test: --package luczor-local-test. AppImages und Quellcode-Starts werden hier nicht gelöscht.' >&2
    [[ -z "$tool" ]] || show "$tool" error 'Luczor deinstallieren' "Die Paketdatenbank für $package konnte nicht gelesen werden."
    return "$result"
  fi
  case "$status" in
    not-installed|config-files)
      printf 'Das Programm-Paket %s ist nicht installiert oder bereits entfernt. Persönliche Daten bleiben erhalten.\n' "$package"
      printf '%s\n' 'Die Testversion verwendet --package luczor-local-test. AppImages und Quellcode-Starts werden hier nicht gelöscht.'
      [[ -z "$tool" ]] || show "$tool" info 'Luczor deinstallieren' "Das Paket $package ist nicht installiert oder bereits entfernt."
      return 0
      ;;
    installed|unpacked|half-installed|half-configured|triggers-awaited|triggers-pending) ;;
    *) printf 'Unbekannter Paketstatus für %s; keine Änderung vorgenommen.\n' "$package" >&2; return 1 ;;
  esac
  printf 'Paket: %s\nStatus: %s\n' "$package" "$status"
  printf '%s\n' 'Chats, Erinnerungen, Einstellungen, Zugangsdaten, Modelle und Projekte bleiben erhalten.'
  printf 'Paketverwaltung: sudo apt-get --no-auto-remove remove -- %s\n' "$package"
  if "$check_only"; then return 0; fi

  # No purge, autoremove, lock deletion or process-name based termination.
  if [[ -n "$tool" ]]; then
    # The dialog replaces APT's own question; polkit asks for authorization.
    if ! show "$tool" question 'Luczor deinstallieren' "Das Paket $package wird entfernt.

Chats, Erinnerungen, Einstellungen, Zugangsdaten, Modelle und Projekte bleiben erhalten.

Bitte Luczor zuvor über das Tray-Menü „Beenden“ schließen. Fenster-X blendet die App nur aus."; then
      printf '%s\n' 'Abgebrochen; das Paket ist weiterhin installiert.'
      return 1
    fi
    if [[ "$(id -u)" == 0 ]]; then
      output="$(DEBIAN_FRONTEND=noninteractive apt-get --no-auto-remove remove -y -- "$package" 2>&1)"
    else
      output="$(pkexec env DEBIAN_FRONTEND=noninteractive apt-get --no-auto-remove remove -y -- "$package" 2>&1)"
    fi
    result=$?
    printf '%s\n' "$output"
    if ((result != 0)); then
      # pkexec: 126 = authorization dialog dismissed, 127 = not authorized.
      if ((result == 126 || result == 127)); then
        show "$tool" error 'Luczor deinstallieren' 'Die Anmeldung wurde abgebrochen oder abgelehnt. Das Paket ist weiterhin installiert.'
      else
        show "$tool" error 'Luczor deinstallieren' "Die Paketverwaltung hat die Entfernung nicht abgeschlossen (Code $result).

$(printf '%s\n' "$output" | tail -n 6)

Bei belegter Paketsperre später erneut versuchen."
      fi
      return "$result"
    fi
  else
    printf '\n%s\n' 'Luczor bitte zuvor über das Tray-Menü „Beenden“ schließen. Fenster-X blendet die App nur aus.'
    printf '%s\n' 'Ubuntu zeigt die zu entfernenden Pakete an und fragt vor der Deinstallation nach Bestätigung.'
    # No -y: APT asks in the terminal.
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
  fi

  # APT also returns success when the user declines. Read the actual result.
  status="$(package_status "$package")"
  result=$?
  if ((result != 0)); then
    printf '%s\n' 'Der Abschluss konnte nicht anhand der Paketdatenbank bestätigt werden.' >&2
    [[ -z "$tool" ]] || show "$tool" error 'Luczor deinstallieren' 'Der Abschluss konnte nicht anhand der Paketdatenbank bestätigt werden.'
    return "$result"
  fi
  if [[ "$status" != not-installed && "$status" != config-files ]]; then
    printf '%s\n' 'Das Paket ist weiterhin installiert; die Deinstallation wurde nicht durchgeführt.'
    [[ -z "$tool" ]] || show "$tool" error 'Luczor deinstallieren' 'Das Paket ist weiterhin installiert; die Deinstallation wurde nicht durchgeführt.'
    return 1
  fi
  remove_autostart "$binary"
  printf 'Das Paket %s ist entfernt. Persönliche Daten und andere Luczor-Varianten bleiben erhalten.\n' "$package"
  [[ -z "$tool" ]] || show "$tool" info 'Luczor deinstallieren' "Das Paket $package ist entfernt. Persönliche Daten bleiben erhalten.

Ein noch laufendes Luczor-Fenster bitte über „Beenden“ im Tray-Menü schließen."
  return 0
}

main "$@"
result=$?
if "$desktop_mode" && ! "$used_dialogs" && [[ -t 0 ]]; then
  printf '\n%s' 'Zum Schließen dieses Fensters Enter drücken … '
  read -r _ || true
fi
exit "$result"
