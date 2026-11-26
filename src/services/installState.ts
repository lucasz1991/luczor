import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * Whether the package manager touched the program file of this running process.
 * `replaced`: a newer package was installed over it; `removed`: it was uninstalled.
 */
export type InstallState = 'unchanged' | 'replaced' | 'removed'

export function parseInstallState(value: unknown): InstallState {
  return value === 'replaced' || value === 'removed' ? value : 'unchanged'
}

type Native = {
  read: () => Promise<unknown>
  subscribe: (handler: (payload: unknown) => void) => Promise<UnlistenFn>
}

const native: Native = {
  read: () => invoke('app_install_state'),
  subscribe: handler => listen('luczor://install-state', event => handler(event.payload)),
}

/** Reports the current state once and every later change. Never rejects. */
export async function watchInstallState(
  onChange: (state: InstallState) => void,
  source: Native | undefined = isTauri() ? native : undefined
): Promise<UnlistenFn> {
  if (!source) return () => {}
  let stop: UnlistenFn = () => {}
  try {
    stop = await source.subscribe(payload => onChange(parseInstallState(payload)))
    onChange(parseInstallState(await source.read()))
  } catch {
    // An older native build has no such command; the notice then stays hidden.
  }
  return stop
}

/** Quits through the ordinary graceful path and starts the installed version. */
export function restartAfterUpdate(): Promise<void> {
  return invoke('app_restart_after_update')
}
