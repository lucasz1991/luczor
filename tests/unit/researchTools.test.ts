import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  close: vi.fn(),
  write: vi.fn(),
  readArtifact: vi.fn(),
  exportArtifact: vi.fn(),
}))
vi.mock('@/services/tools/toolSessionCoordinator', () => ({
  getToolSession: mocks.get,
  acquireBrowserToolSession: mocks.get,
  closeToolSession: mocks.close,
}))
vi.mock('@/services/browserPanel', () => ({ revealBrowserPanel: vi.fn() }))
vi.mock('@/services/executionGate', () => ({ executionGate: { assert: vi.fn() } }))
vi.mock('@/services/research/native', () => ({
  researchWrite: mocks.write,
  researchReadArtifact: mocks.readArtifact,
  researchExportArtifact: mocks.exportArtifact,
}))
import { createResearchTools, isResearchGrantedTool, publicResearchUrl } from '@/services/research/tools'
import { ResearchBrowserQueue } from '@/services/research/browserQueue'
import { base64Bytes, readResearchDocument, sha256Bytes } from '@/services/research/documents'
import type { ToolContext } from '@/services/tools/types'
import type { ResearchBinding } from '@/services/research/native'
import type { ResearchArtifact, ResearchSource } from '@/services/research/types'

const binding: ResearchBinding = {
  principalId: 'account:1',
  projectId: 'chat-space',
  chatId: 'chat',
  runId: 'research',
  rootPath: 'C:/Research/test',
  revision: 1,
  workflowScope: {
    principalId: 'account:1',
    projectId: 'chat-space',
    expectedRootPath: 'C:/Research/test',
    expectedWorkspaceUpdatedAt: 1,
    runId: 'research',
    researchId: 'research',
  },
}
function context(): ToolContext {
  return {
    projectId: binding.projectId,
    researchScope: binding.workflowScope,
    execution: {
      sessionId: 'session',
      generation: 1,
      signal: new AbortController().signal,
      scope: { projectId: binding.projectId, conversationId: binding.chatId, runId: binding.runId },
    },
  }
}
function harness(existing: readonly ResearchSource[] = [], savedArtifacts: readonly ResearchArtifact[] = []) {
  const captureSource = vi.fn(async (source: ResearchSource) => source)
  const recordArtifact = vi.fn(async () => undefined)
  const browser = {
    open: vi.fn(async (url: string) => ({ ok: true, url, data: {} })),
    scan: vi.fn(async ({ expectedUrl }: { expectedUrl: string }) => ({
      url: expectedUrl,
      data: { elements: [{ href: 'https://example.com/report', name: 'Observed report' }] },
    })),
    read: vi.fn(async (_: unknown, options: { expectedUrl: string; offset: number; maxChars: number }) => ({
      url: options.expectedUrl,
      title: 'Actual report',
      text: options.maxChars === 1 ? 'V' : 'Verified source text.',
      offset: options.offset,
      snapshotId: 'snapshot-one',
      truncated: false,
      totalChars: 21,
      nextOffset: null as number | null,
    })),
    download: vi.fn(),
  }
  mocks.get.mockResolvedValue({ meta: { id: 'browser-session' }, browser })
  const tools = createResearchTools({
    binding,
    captureSource,
    recordArtifact,
    sources: () => existing,
    artifacts: () => savedArtifacts,
  })
  const execute = (name: string, args: Record<string, unknown>, ctx = context()) =>
    tools.find(tool => tool.name === name)!.execute(args, ctx)
  return { captureSource, recordArtifact, browser, tools, execute }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.close.mockResolvedValue(true)
})

describe('bounded research tools', () => {
  it('grants only four validated adapters within an actual research scope', () => {
    expect(isResearchGrantedTool('research_search', { query: 'current sources' }, binding.workflowScope)).toBe(true)
    expect(
      isResearchGrantedTool('research_search', { query: 'query', code: 'write files' }, binding.workflowScope)
    ).toBe(false)
    for (const name of ['browser_click', 'project_terminal_run', 'fs_delete', 'research_fake'])
      expect(isResearchGrantedTool(name, {}, binding.workflowScope)).toBe(false)
    expect(
      isResearchGrantedTool('research_search', { query: 'query' }, { ...binding.workflowScope, researchId: undefined })
    ).toBe(false)
  })
  it('does not admit local, executable or credential-bearing URLs', () => {
    for (const value of [
      'file:///C:/secrets',
      'javascript:alert(1)',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://10.0.0.1/',
      'http://server.local/',
      'https://user:secret@example.com/',
      'http://[::1]/',
    ])
      expect(publicResearchUrl(value)).toBeNull()
    expect(publicResearchUrl('/report#section', 'https://example.com')).toBe('https://example.com/report')
  })
  it('keeps search discoveries separate from read evidence, persists actual text and releases browser ownership', async () => {
    const { execute, captureSource } = harness()
    const discovery = (await execute('research_search', { query: 'sources' })) as {
      results: { observation_id: string }[]
    }
    expect(captureSource).not.toHaveBeenCalled()
    const result = (await execute('research_read', { observation_id: discovery.results[0]!.observation_id })) as {
      source: { title: string; contentHash: string }
    }
    expect(result.source.title).toBe('Actual report')
    expect(result.source.contentHash).toBe(await sha256Bytes(new TextEncoder().encode('Verified source text.')))
    expect(captureSource).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'web',
        coverage: 'complete',
        segments: [expect.objectContaining({ text: 'Verified source text.' })],
      })
    )
    expect(mocks.close).toHaveBeenCalledTimes(2)
  })
  it('rejects invented URLs, stale page snapshots and another chat before saving evidence', async () => {
    const { execute, browser, captureSource } = harness()
    await expect(execute('research_read', { observation_id: 'invented' })).rejects.toThrow('not_observed')
    const discovery = (await execute('research_search', { query: 'sources' })) as {
      results: { observation_id: string }[]
    }
    browser.read.mockResolvedValueOnce({
      url: 'https://example.com/report',
      title: 'Report',
      text: 'First chunk',
      offset: 0,
      snapshotId: 'before',
      truncated: true,
      totalChars: 100,
      nextOffset: 11,
    })
    browser.read.mockResolvedValueOnce({
      url: 'https://example.com/report',
      title: 'Report',
      text: 'Changed chunk',
      offset: 11,
      snapshotId: 'after',
      truncated: false,
      totalChars: 100,
      nextOffset: null,
    })
    await expect(execute('research_read', { observation_id: discovery.results[0]!.observation_id })).rejects.toThrow(
      'unverifiable'
    )
    expect(captureSource).not.toHaveBeenCalled()
    const other = context()
    await expect(execute('research_search', { query: 'sources' }, { ...other, projectId: 'other' })).rejects.toThrow(
      'scope_mismatch'
    )
  })
  it('reads later page sections with a pinned snapshot and global citation locations', async () => {
    const { execute, browser, captureSource } = harness()
    const page = 'A'.repeat(48000) + 'Later evidence. '.repeat(300)
    let snapshot = 'snapshot-one'
    browser.read.mockImplementation(async (_, options) => {
      const end = Math.min(page.length, options.offset + options.maxChars)
      return {
        url: options.expectedUrl,
        title: 'Long report',
        text: page.slice(options.offset, end),
        offset: options.offset,
        snapshotId: snapshot,
        truncated: end < page.length,
        totalChars: page.length,
        nextOffset: end < page.length ? end : null,
      }
    })
    const discovery = (await execute('research_search', { query: 'sources' })) as {
      results: { observation_id: string }[]
    }
    const args = { observation_id: discovery.results[0]!.observation_id }
    type ReadResult = { source: ResearchSource; next_offset: number | null; snapshot_id: string; truncated: boolean }
    const first = (await execute('research_read', args)) as ReadResult
    expect(first).toMatchObject({ next_offset: 48000, snapshot_id: snapshot, truncated: true })
    expect(first.source.coverage).toBe('partial')
    expect(first.source.segments[0]?.id).toBe('text-1')
    const laterArgs = { ...args, offset: first.next_offset, snapshot_id: first.snapshot_id, max_chars: 4000 }
    const later = (await execute('research_read', laterArgs)) as ReadResult
    expect(later).toMatchObject({ next_offset: 52000, snapshot_id: snapshot, truncated: true })
    expect(later.source.coverage).toBe('partial')
    expect(later.source.segments).toEqual([
      { id: 'text-13', locator: 'Zeichen 48001–52000', text: page.slice(48000, 52000) },
    ])
    expect(later.source.contentHash).toBe(await sha256Bytes(new TextEncoder().encode(page.slice(48000, 52000))))
    const repeated = (await execute('research_read', laterArgs)) as ReadResult
    expect(repeated.source.id).toBe(later.source.id)
    expect(repeated.source.segments).toEqual(later.source.segments)
    const tail = (await execute('research_read', { ...laterArgs, offset: later.next_offset })) as ReadResult
    expect(tail).toMatchObject({ next_offset: null, truncated: false, source: { coverage: 'partial' } })
    expect(tail.source.segments[0]).toEqual({
      id: 'text-14',
      locator: `Zeichen 52001–${page.length}`,
      text: page.slice(52000),
    })
    const opensBeforeRejection = browser.open.mock.calls.length
    expect(isResearchGrantedTool('research_read', { ...args, offset: 48000 }, binding.workflowScope)).toBe(false)
    await expect(execute('research_read', { ...args, offset: 48000 })).rejects.toThrow('snapshot_required')
    expect(browser.open).toHaveBeenCalledTimes(opensBeforeRejection)
    const capturesBeforeChange = captureSource.mock.calls.length
    snapshot = 'snapshot-changed'
    await expect(execute('research_read', laterArgs)).rejects.toThrow('changed_or_unverifiable')
    expect(captureSource).toHaveBeenCalledTimes(capturesBeforeChange)
  })
  it('rejects unread/unowned document artifacts and preserves local-only evidence policy', async () => {
    const { execute, tools } = harness()
    await expect(execute('research_read_document', { artifact_id: 'not-this-run' })).rejects.toThrow('not_in_run')
    expect(mocks.readArtifact).not.toHaveBeenCalled()
    expect(tools.every(tool => tool.retentionPolicy === 'local_only')).toBe(true)
  })
  it('promotes verified downloads but creates citeable evidence only after parsing their verified bytes', async () => {
    const { execute, browser, captureSource, recordArtifact } = harness()
    const bytes = new TextEncoder().encode('Document facts from the downloaded file.')
    const hash = await sha256Bytes(bytes)
    const artifact = {
      artifactId: 'download-one',
      name: 'facts.txt',
      mime: 'text/plain',
      bytes: bytes.length,
      sha256: hash,
    }
    browser.download.mockResolvedValue({ data: { ...artifact, sourceUrl: 'https://example.com/final.txt' } })
    mocks.exportArtifact.mockResolvedValue({
      path: 'downloads/download-one-facts.txt',
      bytes: bytes.length,
      sha256: hash,
      mime: 'text/plain',
    })
    mocks.readArtifact.mockResolvedValue({ artifact, base64: btoa(new TextDecoder().decode(bytes)) })
    mocks.write.mockImplementation(async (_runId, path, content) => ({
      path,
      bytes: content.length,
      sha256: await sha256Bytes(new TextEncoder().encode(content)),
    }))
    const discovery = (await execute('research_search', { query: 'facts' })) as {
      results: { observation_id: string }[]
    }
    await execute('research_download', { observation_id: discovery.results[0]!.observation_id })
    expect(captureSource).not.toHaveBeenCalled()
    expect(recordArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: 'https://example.com/final.txt', contentHash: hash })
    )
    const read = (await execute('research_read_document', { artifact_id: 'download-one' })) as {
      source: { url: string; contentHash: string }
    }
    expect(read.source).toMatchObject({
      url: 'https://example.com/final.txt',
      contentHash: hash,
      kind: 'file',
      coverage: 'complete',
    })
    expect(captureSource).toHaveBeenCalledOnce()
    expect(mocks.write).toHaveBeenCalledWith(
      'research',
      expect.stringMatching(/^belege\/extract-source-/u),
      expect.stringContaining('Document facts'),
      expect.anything(),
      undefined
    )
    mocks.readArtifact.mockResolvedValue({ artifact, base64: btoa('changed bytes') })
    await expect(execute('research_read_document', { artifact_id: 'download-one' })).rejects.toThrow('hash_mismatch')
    expect(captureSource).toHaveBeenCalledOnce()
  })
  it('keeps canonical source identity for identical URL/content within a run and after resume', async () => {
    const first = harness()
    first.captureSource.mockImplementation(async source => ({ ...source, id: 'canonical-source' }))
    const discovery = (await first.execute('research_search', { query: 'sources' })) as {
      results: { observation_id: string }[]
    }
    const args = { observation_id: discovery.results[0]!.observation_id }
    const read = (await first.execute('research_read', args)) as { source: ResearchSource }
    const repeated = (await first.execute('research_read', args)) as { source: ResearchSource }
    expect(read.source.id).toBe('canonical-source')
    expect(repeated.source.id).toBe(read.source.id)
    const resumed = harness([read.source])
    const rediscovered = (await resumed.execute('research_search', { query: 'sources' })) as {
      results: { observation_id: string }[]
    }
    const reread = (await resumed.execute('research_read', {
      observation_id: rediscovered.results[0]!.observation_id,
    })) as { source: ResearchSource }
    expect(reread.source.id).toBe(read.source.id)
  })
  it('verifies and reuses a persisted download after resume instead of downloading it again', async () => {
    const contentHash = await sha256Bytes(new TextEncoder().encode('persisted bytes'))
    const artifact: ResearchArtifact = {
      id: 'saved-download',
      path: 'downloads/saved.txt',
      kind: 'download',
      contentHash,
      sourceUrl: 'https://example.com/report',
    }
    const { execute, browser } = harness([], [artifact])
    mocks.readArtifact.mockResolvedValue({
      base64: btoa('persisted bytes'),
      artifact: { artifactId: artifact.id, sha256: contentHash, name: 'saved.txt', mime: 'text/plain' },
    })
    const search = (await execute('research_search', { query: 'sources' })) as { results: { observation_id: string }[] }
    const result = await execute('research_download', { observation_id: search.results[0]!.observation_id })
    expect(result).toMatchObject({ reused: true, artifact })
    expect(browser.download).not.toHaveBeenCalled()
    expect(mocks.exportArtifact).not.toHaveBeenCalled()
  })
})

describe('research browser FIFO', () => {
  it('releases ownership on failure and removes aborted waiters without overtaking surviving work', async () => {
    const queue = new ResearchBrowserQueue()
    let release!: () => void
    const order: string[] = []
    const first = queue.run(async () => {
      order.push('first')
      await new Promise<void>(resolve => {
        release = resolve
      })
      throw new Error('failed')
    })
    await Promise.resolve()
    const cancelled = new AbortController()
    const second = queue.run(async () => {
      order.push('cancelled')
    }, cancelled.signal)
    const third = queue.run(async () => {
      order.push('third')
      return 3
    })
    cancelled.abort()
    await expect(second).rejects.toBeDefined()
    release()
    await expect(first).rejects.toThrow('failed')
    expect(await third).toBe(3)
    expect(order).toEqual(['first', 'third'])
  })
})

describe('document byte/text bounds', () => {
  it('addresses text/csv/json in bounded logical pages and reports partial coverage', async () => {
    const bytes = new TextEncoder().encode('a'.repeat(40001))
    const result = await readResearchDocument(bytes, {
      name: 'report.txt',
      mime: 'text/plain',
      firstPage: 2,
      maxPages: 1,
    })
    expect(result).toMatchObject({ totalPages: 3, nextPage: 3, truncated: true, imageOnly: false })
    expect(result.pages).toEqual([{ page: 2, text: 'a'.repeat(20000) }])
  })
  it('rejects binary, malformed UTF-8 and unsupported formats before creating evidence', async () => {
    await expect(
      readResearchDocument(new Uint8Array([255]), { name: 'report.txt', mime: 'text/plain' })
    ).rejects.toThrow()
    await expect(
      readResearchDocument(new Uint8Array([0, 2]), { name: 'report.csv', mime: 'text/csv' })
    ).rejects.toThrow('binary')
    await expect(
      readResearchDocument(new Uint8Array([1]), { name: 'program.exe', mime: 'application/octet-stream' })
    ).rejects.toThrow('unsupported')
    expect(base64Bytes('YQ==')).toEqual(new Uint8Array([97]))
  })
})
