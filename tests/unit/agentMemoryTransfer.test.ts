import { describe, expect, it, vi } from 'vitest'
import {
  importAgentMemory,
  MAX_AGENT_MEMORY_CHARACTERS,
  parseAgentMemorySource,
  type ImportAgentMemoryInput,
} from '@/services/agents/memoryTransfer'
import type { MemoryRecord, RememberInput } from '@/services/memory/luczorMemory'

function node(parent: string | null, role: string, text: string, extra: Record<string, unknown> = {}) {
  return { parent, message: { author: { role }, content: { content_type: 'text', parts: [text] }, ...extra } }
}

function fixtureExport() {
  return {
    id: 'verified-conversation-id',
    title: 'Project decisions',
    current_node: 'answer',
    mapping: {
      system: node(null, 'system', 'Hidden system instructions'),
      user: node('system', 'user', 'Use German labels.'),
      alternate: node('user', 'assistant', 'Old discarded branch'),
      reasoning: node('user', 'assistant', 'Hidden reasoning', { channel: 'analysis' }),
      tool: node('reasoning', 'tool', 'Raw tool result with private content'),
      hidden: node('tool', 'assistant', 'Hidden internal state', {
        metadata: { is_visually_hidden_from_conversation: true },
      }),
      answer: node('hidden', 'assistant', 'German labels confirmed.', { channel: 'final', recipient: 'all' }),
    },
  }
}

function importHarness(account: { principalId: string } | null = { principalId: 'account-1' }) {
  const getAccount = vi.fn().mockResolvedValue(account)
  const remember = vi.fn(
    async (request: RememberInput) =>
      ({
        ...request,
        id: 'memory-1',
        principalId: account?.principalId ?? 'device-local',
        status: 'active',
      }) as MemoryRecord
  )
  const input: ImportAgentMemoryInput = {
    projectId: 'project-1',
    principalId: account?.principalId ?? 'device-local',
    content: 'German labels are the confirmed project convention.',
    source: 'chatgpt',
    sourceRef: 'conversation-1',
  }
  return { input, dependencies: { getAccount, remember }, remember, getAccount }
}

describe('selected agent memory transfer', () => {
  it('extracts only visible user/assistant text from the active ChatGPT ancestry', () => {
    const previews = parseAgentMemorySource({
      text: JSON.stringify([fixtureExport()]),
      format: 'chatgpt-json',
      source: 'chatgpt',
    })
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({
      title: 'Project decisions',
      source: 'chatgpt',
      sourceRef: 'verified-conversation-id',
      messageCount: 2,
      truncated: false,
      content: 'Nutzer:\nUse German labels.\n\nAssistent:\nGerman labels confirmed.',
    })
    expect(Object.isFrozen(previews)).toBe(true)
    expect(Object.isFrozen(previews[0])).toBe(true)
    for (const excluded of ['Hidden', 'Raw tool', 'Old discarded']) expect(previews[0]!.content).not.toContain(excluded)
  })

  it('ignores tool recipients, user system messages and nested attachment/reasoning objects', () => {
    const conversation = {
      current_node: 'mixed',
      mapping: {
        userSystem: node(null, 'user', 'Custom system instructions', { metadata: { is_user_system_message: true } }),
        toolCall: node('userSystem', 'assistant', 'execute this code', { recipient: 'python' }),
        mixed: {
          parent: 'toolCall',
          message: {
            author: { role: 'assistant' },
            content: {
              content_type: 'multimodal_text',
              parts: [{ text: 'nested hidden text' }, 'Visible final answer.'],
            },
          },
        },
      },
    }
    const [preview] = parseAgentMemorySource({
      text: JSON.stringify(conversation),
      format: 'chatgpt-json',
      source: 'chatgpt',
    })
    expect(preview!.content).toBe('Assistent:\nVisible final answer.')
    expect(preview!.messageCount).toBe(1)
  })

  it('rejects invalid or missing active branches and does not flatten arbitrary JSON logs', () => {
    for (const text of ['not json', JSON.stringify([{ messages: [{ text: 'not a supported export' }] }])]) {
      expect(() => parseAgentMemorySource({ text, format: 'chatgpt-json', source: 'chatgpt' })).toThrow()
    }
    const cycle = {
      current_node: 'node-a',
      mapping: { 'node-a': node('node-b', 'user', 'a'), 'node-b': node('node-a', 'assistant', 'b') },
    }
    expect(() =>
      parseAgentMemorySource({ text: JSON.stringify(cycle), format: 'chatgpt-json', source: 'chatgpt' })
    ).toThrow('ungültigen Gesprächsverlauf')
    const missing = { current_node: 'missing', mapping: {} }
    expect(() =>
      parseAgentMemorySource({ text: JSON.stringify(missing), format: 'chatgpt-json', source: 'chatgpt' })
    ).toThrow('unvollständig')
  })

  it('accepts edited plain text and managed agent output without importing metadata', () => {
    for (const source of ['codex', 'agent', 'chatgpt'] as const) {
      const [preview] = parseAgentMemorySource({
        text: '  A selected decision.\r\nSecond line.\u0000 ',
        format: 'markdown',
        source,
        sourceRef: 'actual-job-id',
      })
      expect(preview).toMatchObject({
        content: 'A selected decision.\nSecond line.',
        source,
        sourceRef: 'actual-job-id',
        messageCount: 1,
      })
    }
  })

  it('bounds preview sizes, preserves the latest branch messages and signals truncation', () => {
    const mapping = new Map<string, ReturnType<typeof node>>()
    for (let index = 0; index < 205; index++)
      mapping.set(`node-${index}`, node(index ? `node-${index - 1}` : null, 'user', `Message ${index}`))
    const [preview] = parseAgentMemorySource({
      text: JSON.stringify({ current_node: 'node-204', mapping: Object.fromEntries(mapping) }),
      format: 'chatgpt-json',
      source: 'chatgpt',
    })
    expect(preview!.messageCount).toBe(200)
    expect(preview!.truncated).toBe(true)
    expect(preview!.content).toContain('Message 204')
    expect(preview!.content).not.toContain('Message 0\n')
    const [large] = parseAgentMemorySource({
      text: 'x'.repeat(MAX_AGENT_MEMORY_CHARACTERS + 1),
      format: 'markdown',
      source: 'codex',
    })
    expect(large!.content).toHaveLength(MAX_AGENT_MEMORY_CHARACTERS)
    expect(large!.truncated).toBe(true)
  })

  it('imports only after the explicit import call, privately and durably in the selected project', async () => {
    const { input, dependencies, remember } = importHarness()
    parseAgentMemorySource({ text: input.content, format: 'markdown', source: 'chatgpt' })
    expect(remember).not.toHaveBeenCalled()
    const result = await importAgentMemory(input, dependencies)
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({
        content: input.content,
        scope: 'project',
        projectId: 'project-1',
        expectedPrincipalId: 'account-1',
        source: 'chatgpt_import',
        sourceRef: 'conversation-1',
        writeIntent: 'confirmed',
        retention: 'durable',
        visibility: 'private',
        provenance: { import_version: 1, user_reviewed: true, import_source: 'chatgpt' },
      })
    )
    expect(result.visibility).toBe('private')
  })

  it('makes source plus normalized content deduplication deterministic and keeps source identities separate', async () => {
    const { input, dependencies, remember } = importHarness()
    await importAgentMemory(input, dependencies)
    await importAgentMemory({ ...input, content: input.content.replace(/ /gu, '\n') }, dependencies)
    await importAgentMemory({ ...input, sourceRef: 'different-conversation' }, dependencies)
    await importAgentMemory({ ...input, content: 'A different selected decision.' }, dependencies)
    const keys = remember.mock.calls.map(([request]) => request.featureKey)
    expect(keys[0]).toMatch(/^agent-import:[a-f0-9]{64}$/u)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).not.toBe(keys[2])
    expect(keys[0]).not.toBe(keys[3])
  })

  it('requires an explicit syncable selection and accurately attributes local agents', async () => {
    const { input, dependencies, remember } = importHarness()
    await importAgentMemory({ ...input, source: 'agent', visibility: 'syncable' }, dependencies)
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_import', visibility: 'syncable', retention: 'durable' })
    )
  })

  it('rejects account changes and maps a device workspace identity only to offline local memory', async () => {
    const online = importHarness()
    await expect(importAgentMemory({ ...online.input, principalId: 'account-2' }, online.dependencies)).rejects.toThrow(
      'Konto hat sich geändert'
    )
    expect(online.remember).not.toHaveBeenCalled()
    const device = importHarness(null)
    await importAgentMemory({ ...device.input, principalId: `device:v1:${'a'.repeat(64)}` }, device.dependencies)
    expect(device.remember).toHaveBeenCalledWith(expect.objectContaining({ expectedPrincipalId: 'device-local' }))
    await expect(importAgentMemory({ ...device.input, principalId: 'account-1' }, device.dependencies)).rejects.toThrow(
      'Konto hat sich geändert'
    )
  })

  it('freezes the user selection across asynchronous account verification', async () => {
    const { input, dependencies, remember } = importHarness()
    let resolve!: (account: { principalId: string }) => void
    dependencies.getAccount.mockImplementation(
      () =>
        new Promise(result => {
          resolve = result
        })
    )
    const mutable = { ...input }
    const importing = importAgentMemory(mutable, dependencies)
    mutable.projectId = 'different-project'
    mutable.content = 'Unexpected replacement'
    mutable.visibility = 'syncable'
    resolve({ principalId: 'account-1' })
    await importing
    expect(remember).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', content: input.content, visibility: 'private' })
    )
  })

  it('rejects secrets and oversized selections before a durable memory write', async () => {
    const { input, dependencies, remember } = importHarness()
    await expect(
      importAgentMemory({ ...input, content: 'ghp_abcdefghijklmnopqrstuvwxyz123456' }, dependencies)
    ).rejects.toThrow('Zugangsdaten')
    await expect(
      importAgentMemory({ ...input, content: 'x'.repeat(MAX_AGENT_MEMORY_CHARACTERS + 1) }, dependencies)
    ).rejects.toThrow('Zeichen')
    await expect(importAgentMemory({ ...input, sourceRef: 'bad\nreference' }, dependencies)).rejects.toThrow(
      'Quellenreferenz'
    )
    expect(remember).not.toHaveBeenCalled()
  })

  it.each(['E:\\private\\repo', '\\\\server\\share', '/home/private/repo', 'file:///private/repo', 'source E:/private/repo'])('does not persist a local filesystem source reference: %s', async sourceRef => {
    const { input, dependencies, remember } = importHarness()
    await expect(importAgentMemory({ ...input, visibility: 'syncable', sourceRef }, dependencies)).rejects.toThrow('keinen lokalen Dateipfad')
    expect(remember).not.toHaveBeenCalled()
  })

  it('keeps ordinary ChatGPT source links valid', async () => {
    const { input, dependencies, remember } = importHarness()
    const sourceRef = 'https://chatgpt.com/c/verified-conversation-id'
    await importAgentMemory({ ...input, sourceRef }, dependencies)
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ sourceRef }))
  })
})
