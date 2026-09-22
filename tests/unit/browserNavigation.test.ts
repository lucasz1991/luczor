import { describe, expect, it } from 'vitest'
import { browserNavigationUrl } from '@/services/browserNavigation'
import { compactToolOutput } from '@/services/inference/contextBudget'

describe('internal navigation', () => {
  it('allows arbitrary domains, loopback and exact Unicode file names', () => {
    expect(browserNavigationUrl('https://other.example:8443/a')).toBe('https://other.example:8443/a')
    expect(browserNavigationUrl('localhost:1420/test')).toBe('http://localhost:1420/test')
    expect(browserNavigationUrl('example.test:8443')).toBe('https://example.test:8443/')
    expect(browserNavigationUrl('E:\\Projekt ä\\A #1%.html')).toBe('file:///E:/Projekt%20%C3%A4/A%20%231%25.html')
    expect(browserNavigationUrl('/home/user/Test ä.html')).toBe('file:///home/user/Test%20%C3%A4.html')
    expect(browserNavigationUrl('\\\\server\\share\\a b.html')).toBe('file://server/share/a%20b.html')
    expect(browserNavigationUrl('file:///home/user/test.html')).toBe('file:///home/user/test.html')
  })
  it('does not turn navigation into code execution or grant host IPC', () => {
    for (const target of [
      'javascript:alert(1)',
      'tauri://localhost',
      'data:text/html,hi',
      'https://name:password@test.test',
    ]) {
      expect(() => browserNavigationUrl(target)).toThrow('url_invalid')
    }
    expect(() => browserNavigationUrl('https://te\nst.test')).toThrow('url_invalid')
  })
})

describe('DOM context projection', () => {
  it('keeps a usable exact ref when one element exceeds the small-model budget', () => {
    const value = {
      version: 1,
      elements: [
        {
          ref: 'ref:actual_long_link',
          role: 'link',
          name: 'A'.repeat(1000),
          href: 'https://example.test/' + 'a'.repeat(3000),
        },
      ],
      offset: 0,
      nextOffset: null,
      total: 1,
    }
    const result = compactToolOutput(value, 360) as typeof value
    expect(result.elements).toEqual([
      { ref: 'ref:actual_long_link', role: 'link', detailsOmitted: true, nameOmitted: true },
    ])
    expect(result.nextOffset).toBeNull()
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(360)
  })
  it('preserves whole targets and points to the first omitted entry rather than skipping the scan page', () => {
    const elements = Array.from({ length: 30 }, (_, i) => ({
      ref: `ref:actual_${i}`,
      role: 'link',
      name: `A full file ${i}.html`,
      href: `file:///C:/my%20project/${i}.html`,
    }))
    const value = {
      ok: true,
      sessionId: 'session',
      url: 'file:///C:/my%20project/index.html',
      data: { version: 1, elements, offset: 20, nextOffset: 50, total: 100, truncated: true },
    }
    const result = compactToolOutput(value, 900) as typeof value
    expect(result.data.elements.length).toBeGreaterThan(0)
    expect(result.data.elements).toEqual(elements.slice(0, result.data.elements.length))
    expect(result.data.nextOffset).toBe(20 + result.data.elements.length)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(900)
  })
})
