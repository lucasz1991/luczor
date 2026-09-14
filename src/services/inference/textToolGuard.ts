/** Detect protocol-shaped text only; never turn its contents into executable calls. */
export function textToolNames(content: string, available: readonly string[]): string[] {
  if (!isTextToolOutput(content)) return []
  const named = [...content.matchAll(/["']name["']\s*:\s*["']([a-z][a-z0-9_]*)["']/gi)].map(match => match[1]!)
  named.push(...[...content.matchAll(/<name>\s*([a-z][a-z0-9_]*)\s*<\/name>/gi)].map(match => match[1]!))
  return [...new Set(named.filter(name => available.includes(name)))]
}

export function isTextToolOutput(content: string): boolean {
  return (
    /<(?:tools?|tool_call|function-call|function_call)(?:\s[^>]*|)>/i.test(content) ||
    /["']name["']\s*:\s*["'][a-z][a-z0-9_]*["'][\s\S]*?["']arguments["']\s*:/i.test(content)
  )
}

export function allowsTextToolExample(objective: string): boolean {
  return /```|<\/?(?:tools?|tool_call|function-call|name)>|\b(?:erklär\w*|beispiel\w*|warum|bedeutet|explain|example|zitiere|wörtlich|syntax)\b/i.test(
    objective
  )
}

export function mayRepairTextTool(objective: string, actionRequested: boolean): boolean {
  // A question about code/examples is not an instruction to execute that code.
  if (allowsTextToolExample(objective)) return false
  if (/\b(?:nicht|keine)\s+(?:ausführ\w*|tool\w*|werkzeug\w*)/i.test(objective)) return false
  return actionRequested || /\b(?:tools?|werkzeuge?)\s+(?:testen|prüfen)\b|\bteste\b/i.test(objective)
}

export function holdProtocolPrefix(content: string): boolean {
  return /^\s*(?:`|\{|\[|<)/.test(content)
}
