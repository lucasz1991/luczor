import type { WireMessage } from '@/services/inference/types'
import { validateToolArguments } from '@/services/tools/validateArguments'

/** These tools can only inspect the already exported packet; no desktop/file access. */
export const SPECIALIST_CONTEXT_TOOLS = ['context_search', 'context_read'] as const
export function specialistContextTools(messages: readonly WireMessage[], selected: readonly string[]) {
  const packet = messages.map(message => message.content)
  const definitions = [
    {
      name: 'context_search',
      description: 'Search the provided context. Returns message indices and bounded excerpts.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['query'],
      },
    },
    {
      name: 'context_read',
      description: 'Read one provided context message by index, optionally from a character offset.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { index: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 } },
        required: ['index'],
      },
    },
  ].filter(tool => selected.includes(tool.name))
  return {
    tools: definitions.map(definition => ({ type: 'function', function: definition })),
    execute(name: string, args: Record<string, unknown>) {
      const tool = definitions.find(tool => tool.name === name)
      if (!tool) throw new Error('Dieses Werkzeug wurde dem externen Auftrag nicht zugeteilt.')
      validateToolArguments(tool.parameters, args)
      if (name === 'context_search') {
        const query = String(args.query).toLocaleLowerCase()
        return packet
          .flatMap((text, index) => {
            const offset = text.toLocaleLowerCase().indexOf(query)
            return offset < 0 ? [] : [{ index, offset, excerpt: text.slice(Math.max(0, offset - 120), offset + 600) }]
          })
          .slice(0, 8)
      }
      const text = packet[Number(args.index)]
      if (text === undefined) throw new Error('Kontextnachricht nicht vorhanden.')
      const offset = Number(args.offset ?? 0)
      return {
        index: args.index,
        offset,
        text: text.slice(offset, offset + 6000),
        hasMore: text.length > offset + 6000,
      }
    },
  }
}
