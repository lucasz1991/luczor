function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}
function parts(date: number, format: Intl.DateTimeFormat): Record<string, string> {
  return Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]))
}
export function workflowZonedTime(iso: string, timezone: string): string {
  const value = parts(new Date(iso).getTime(), formatter(timezone))
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`
}
/** A repeated wall minute selects its first occurrence; a missing minute cannot be scheduled. */
export function workflowTimeToUtc(wall: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(wall)) throw new Error('Einen gültigen Termin mit Uhrzeit eingeben.')
  const naive = Date.parse(`${wall}:00Z`)
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== wall)
    throw new Error('Ungültiger Termin.')
  const format = formatter(timezone)
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = naive + hours * 3_600_000
    const localParts = parts(instant, format)
    offsets.add(
      Date.parse(
        `${localParts.year}-${localParts.month}-${localParts.day}T${localParts.hour}:${localParts.minute}:00Z`
      ) - instant
    )
  }
  const matches = [...offsets]
    .map(offset => naive - offset)
    .filter(instant => workflowZonedTime(new Date(instant).toISOString(), timezone) === wall)
    .sort((earlier, later) => earlier - later)
  if (!matches.length)
    throw new Error('Diese Uhrzeit existiert in der gewählten Zeitzone wegen der Zeitumstellung nicht.')
  return new Date(matches[0]!).toISOString()
}
