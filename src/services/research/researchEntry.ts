export type ResearchEntry = { topic: string; depth: 'deep' }

/** Exact leading command only. Mentions, code, paths and prefixes stay normal chat text. */
export function parseResearchEntry(input: string): ResearchEntry | null {
  const value = input.trim()
  const command = '/research'
  if (!value.startsWith(command)) return null
  const rest = value.slice(command.length)
  if (rest && !/[ \t\r\n]/u.test(rest[0]!)) return null
  let topic = rest.trim()
  if (topic === 'deep') topic = ''
  else if (topic.startsWith('deep') && /[ \t\r\n]/u.test(topic[4] ?? '')) topic = topic.slice(4).trim()
  return { topic, depth: 'deep' }
}
