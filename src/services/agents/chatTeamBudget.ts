/** Bound slow local tool loops without cutting every multi-round worker off at 15 minutes. */
export function chatTeamBudget(rounds: number, externalNodes: number, parallel: number) {
  const minute = 60_000
  const safeRounds = Number.isFinite(rounds) ? Math.max(1, Math.floor(rounds)) : 1
  const workerTimeoutMs = Math.min(60, Math.max(15, safeRounds * 3)) * minute
  const waves = Math.ceil(Math.max(0, externalNodes) / Math.max(1, parallel))
  return {
    workerTimeoutMs,
    deadlineMs: Math.min(240 * minute, workerTimeoutMs + (30 + 15 * waves) * minute),
  }
}
