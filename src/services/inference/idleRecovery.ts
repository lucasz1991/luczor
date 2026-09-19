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

// Covers the 125s worker deadline, not the obsolete 60s generation budget.
export const IDLE_READINESS_HEADROOM_MS = 135_000
