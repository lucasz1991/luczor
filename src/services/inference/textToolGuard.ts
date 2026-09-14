/** Detect protocol-shaped text only; never turn its contents into executable calls. */
export function textToolNames(content: string, available: readonly string[]): string[] {
  if (!/(?:<tools?>|<tool_call>|["']name["']\s*:)/i.test(content)) return []
  const named = [...content.matchAll(/["']name["']\s*:\s*["']([a-z][a-z0-9_]*)["']/gi)].map(match => match[1]!)
  return [...new Set(named.filter(name => available.includes(name)))]
}

export function mayRepairTextTool(objective: string, actionRequested: boolean): boolean {
  // A question about code/examples is not an instruction to execute that code.
  if (/```|<tools?>|<tool_call>|\b(?:erklär\w*|beispiel\w*|warum|bedeutet|explain|example)\b/i.test(objective))
    return false
  if (/\b(?:nicht|keine)\s+(?:ausführ\w*|tool\w*|werkzeug\w*)/i.test(objective)) return false
  return actionRequested || /\b(?:tools?|werkzeuge?)\s+(?:testen|prüfen)\b|\bteste\b/i.test(objective)
}

export function holdProtocolPrefix(content: string): boolean {
  return /^\s*(?:`|\{|\[|<)/.test(content)
}
