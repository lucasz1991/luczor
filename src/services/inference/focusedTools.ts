import type { ToolDef } from '@/services/tools/types'
import type { WireMessage } from './types'
import { isRuntimeStatusEcho, explicitlyQuotesRuntimeStatus } from './localResponseGuard'
import { allowsTextToolExample, isTextToolOutput, holdProtocolPrefix } from './textToolGuard'

type Definition = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Selection only: the caller supplies its already authorized tool pool. */
export function focusedTools(objective: string) {
  let requested: string[] = []
  let pool: Definition[] = []
  const selector: ToolDef = {
    name: 'tools_select',
    category: 'app',
    mutating: false,
    requiresApproval: false,
    description:
      'Weitere Werkzeuge für die nächste Runde auswählen. Ohne Namen: verfügbaren Katalog lesen. Maximal sechs Namen pro Auswahl; keine Aktion wird ausgeführt.',
    parameters: {
      type: 'object',
      properties: { names: { type: 'array', maxItems: 6, items: { type: 'string' } } },
      additionalProperties: false,
    },
    async execute(args) {
      const names = args.names ?? []
      if (
        !Array.isArray(names) ||
        names.length > 6 ||
        names.some(name => typeof name !== 'string' || !pool.some(tool => tool.function.name === name))
      )
        throw new Error('Nur verfügbare Werkzeugnamen auswählen (maximal sechs).')
      if (names.length) requested = [...new Set(names as string[])]
      return {
        selected: requested,
        available: pool.map(tool => ({
          name: tool.function.name,
          description: tool.function.description?.slice(0, 110),
        })),
      }
    },
  }
  return {
    selector,
    select(available: Definition[]): Definition[] {
      pool = available
      if (!pool.length) return []
      const pinned = pool.filter(tool =>
        ['goal_report', 'goal_read_result', 'agent_assist_status'].includes(tool.function.name)
      )
      const text = objective.toLowerCase()
      const preferred = ['project_get_state', 'workspace_get', 'agent_assist']
      if (/datei|repo|code|file|ordner|software/.test(text))
        preferred.push('fs_list', 'fs_read', 'fs_search', 'project_terminal_run')
      if (/browser|web|url|internet|seite/.test(text))
        preferred.push('browser_status', 'browser_open', 'browser_dom_read', 'browser_click', 'browser_fill')
      if (/gerät|system|linux|windows|leistung|hardware/.test(text))
        preferred.push('os_environment', 'os_system_diagnostics', 'local_model_status')
      if (/erinner|memory/.test(text)) preferred.push('memory_recall', 'memory_remember')
      if (/workflow/.test(text)) preferred.push('workflow_list', 'workflow_get', 'workflow_run_start')
      const exact = pool.filter(tool => text.includes(tool.function.name)).map(tool => tool.function.name)
      const order = [...new Set([...pinned.map(tool => tool.function.name), ...requested, ...exact, ...preferred])]
      const selected = order
        .map(name => pool.find(tool => tool.function.name === name))
        .filter((tool): tool is Definition => !!tool)
        .slice(0, 9)
      return [
        ...selected,
        {
          type: 'function',
          function: { name: selector.name, description: selector.description, parameters: selector.parameters },
        },
      ]
    },
  }
}

/** Only remove known UI-only failures, never tool receipts or arbitrary quoted text. */
export function cleanLocalHistory(messages: WireMessage[]): WireMessage[] {
  let precedingUser = ''
  const continuation =
    'Prüfe zuerst ausschließlich lesend den aktuellen Zustand des unterbrochenen Auftrags. Wiederhole keine Schreibaktionen. Berichte, was bereits nachweisbar erledigt ist und was noch fehlt.\n\nUrsprünglicher Auftrag:\n'
  return messages
    .filter(message => {
      if (message.role === 'user') precedingUser = message.content
      if (message.role !== 'assistant' || message.tool_calls?.length) return true
      if (isRuntimeStatusEcho(message.content) && !explicitlyQuotesRuntimeStatus(precedingUser)) return false
      return !(
        holdProtocolPrefix(message.content) &&
        isTextToolOutput(message.content) &&
        !allowsTextToolExample(precedingUser)
      )
    })
    .map(message => {
      if (message.role !== 'user' || !message.content.startsWith(continuation)) return message
      let content = message.content.slice(continuation.length)
      while (content.includes(continuation)) content = content.replace(continuation, '')
      return { ...message, content: continuation + content }
    })
}
