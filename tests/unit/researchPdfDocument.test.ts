import { describe, expect, it, vi } from 'vitest'
// Node uses PDF.js' supported legacy entrypoint; the production browser uses the bundled modern worker.
vi.mock('pdfjs-dist', async () => import('pdfjs-dist/legacy/build/pdf.mjs'))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href,
}))
import { readResearchDocument } from '@/services/research/documents'

function pdfFixture(first = 'First real PDF page.', second = 'Second independently read PDF page.'): Uint8Array {
  const stream = (text: string) => `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const firstStream = stream(first)
  const secondStream = stream(second)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${firstStream.length} >>\nstream\n${firstStream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${secondStream.length} >>\nstream\n${secondStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length)
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(text)
}

describe('actual bundled PDF.js text extraction', () => {
  it('extracts real PDF bytes into page-specific evidence without rendering or external services', async () => {
    const result = await readResearchDocument(pdfFixture(), { name: 'report.pdf', mime: 'application/pdf' })
    expect(result).toMatchObject({ totalPages: 2, nextPage: null, truncated: false, imageOnly: false })
    expect(result.pages.map(page => page.text.trim())).toEqual([
      'First real PDF page.',
      'Second independently read PDF page.',
    ])
    expect(result.pages.map(page => page.page)).toEqual([1, 2])
  })
  it('preserves partial page range coverage and identifies documents without extractable text', async () => {
    const partial = await readResearchDocument(pdfFixture(), {
      name: 'report.pdf',
      mime: 'application/pdf',
      firstPage: 2,
      maxPages: 1,
    })
    expect(partial).toMatchObject({ totalPages: 2, truncated: true, pages: [{ page: 2 }] })
    const empty = await readResearchDocument(pdfFixture('', ''), { name: 'scan.pdf', mime: 'application/pdf' })
    expect(empty.imageOnly).toBe(true)
  })
})
