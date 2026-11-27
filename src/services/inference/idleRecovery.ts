/** Infrastructure waits are not failed memory edits. Never classify stream/review failures here. */
export const IDLE_WAIT_LABELS: Readonly<Record<string, string>> = {
  idle_model_busy: 'Lokales Modell belegt – automatische Wiederholung nach Freigabe',
  idle_model_cooldown: 'Modell-Abkühlphase – automatische Wiederholung nach Ablauf',
  model_cooldown: 'Modell-Abkühlphase – automatische Wiederholung nach Ablauf',
  resource_background_unavailable: 'Chat hat Vorrang – automatische Wiederholung im Leerlauf',
  resource_system_check_busy: 'Gerät belegt – Katalogprüfung wartet auf Leerlauf',
  idle_catalog_refresh_wait: 'Signierter Modellkatalog noch nicht erneuert – erneute Prüfung in zwei Minuten',
}

export function idleWaitReason(error: unknown): string | undefined {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const reason = typeof code === 'string' ? code : error instanceof Error ? error.message : error
  return typeof reason === 'string' && Object.hasOwn(IDLE_WAIT_LABELS, reason) ? reason : undefined
}

/**
 * Memory on this device is short right now. This says nothing about the job's content, so it must
 * not use up one of the job's three attempts; the optimizer's error back-off still applies.
 * `installed_model_unavailable` is what idle preparation throws when the capacity check admits no
 * installed model. `runtime_start_failed` is deliberately absent: on the idle path it reports a
 * resident bound to another project, which waiting does not clear. Never list output, stream or
 * review failures here: those stay bounded per job.
 */
const IDLE_ENVIRONMENT_FAILURES: ReadonlySet<string> = new Set([
  'installed_model_unavailable',
  'runtime_startup_ram_pressure',
  'available_ram_below_minimum',
  'ram_budget_insufficient',
  'vram_below_minimum',
])

export function idleEnvironmentFailure(reason: unknown): boolean {
  return typeof reason === 'string' && IDLE_ENVIRONMENT_FAILURES.has(reason)
}

// Covers the 125s worker deadline, not the obsolete 60s generation budget.
export const IDLE_READINESS_HEADROOM_MS = 135_000
