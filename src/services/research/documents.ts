export type DocumentPage = { page: number; text: string }
export type DocumentRead = {
  pages: DocumentPage[]
  totalPages: number
  nextPage: number | null
  truncated: boolean
  imageOnly: boolean
}
const MAX_BYTES = 50 * 1024 * 1024
const MAX_TEXT = 500_000

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}
export function base64Bytes(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) throw new Error('research_document_too_large')
  const decoded = atob(value)
  return Uint8Array.from(decoded, char => char.charCodeAt(0))
}

/** Extracts only local bytes; PDFs never execute embedded JS or fetch a URL supplied by their content. */
export async function readResearchDocument(
  bytes: Uint8Array,
  options: { name: string; mime: string; firstPage?: number; maxPages?: number; signal?: AbortSignal }
): Promise<DocumentRead> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('research_document_size_invalid')
  options.signal?.throwIfAborted()
  const firstPage = options.firstPage ?? 1
  const maxPages = options.maxPages ?? 20
  if (!Number.isInteger(firstPage) || firstPage < 1 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50)
    throw new Error('research_document_page_range_invalid')
  const isPdf = options.mime.toLowerCase().split(';')[0] === 'application/pdf' || /\.pdf$/iu.test(options.name)
  if (!isPdf) {
    if (
      !/\.(txt|csv|json)$/iu.test(options.name) &&
      !/^(text\/(plain|csv)|application\/json)(;|$)/iu.test(options.mime)
    )
      throw new Error('research_document_type_unsupported')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\u0000')) throw new Error('research_document_binary_content')
    // Logical pages keep text/csv/json bounded and make every range addressable.
    const pageSize = 20_000
    const totalPages = Math.max(1, Math.ceil(text.length / pageSize))
    if (firstPage > totalPages) throw new Error('research_document_page_out_of_range')
    const last = Math.min(totalPages, firstPage + maxPages - 1, firstPage + Math.floor(MAX_TEXT / pageSize) - 1)
    const pages: DocumentPage[] = []
    for (let page = firstPage; page <= last; page++)
      pages.push({ page, text: text.slice((page - 1) * pageSize, page * pageSize) })
    return {
      pages,
      totalPages,
      nextPage: last < totalPages ? last + 1 : null,
      truncated: firstPage > 1 || last < totalPages,
      imageOnly: false,
    }
  }
  const [{ getDocument, GlobalWorkerOptions }, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  GlobalWorkerOptions.workerSrc = worker.default
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    disableAutoFetch: true,
    stopAtErrors: true,
  })
  const cancel = () => {
    void task.destroy()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const document = await task.promise
    if (firstPage > document.numPages) throw new Error('research_document_page_out_of_range')
    const last = Math.min(document.numPages, firstPage + maxPages - 1)
    const pages: DocumentPage[] = []
    let consumed = 0
    let clipped = false
    for (let pageNumber = firstPage; pageNumber <= last; pageNumber++) {
      options.signal?.throwIfAborted()
      const page = await document.getPage(pageNumber)
      try {
        const content = await page.getTextContent()
        const raw = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('')
        const remaining = MAX_TEXT - consumed
        const text = raw.slice(0, remaining)
        pages.push({ page: pageNumber, text })
        consumed += text.length
        if (raw.length > remaining) {
          clipped = true
          break
        }
      } finally {
        page.cleanup()
      }
    }
    options.signal?.throwIfAborted()
    const finalPage = pages.at(-1)?.page ?? firstPage
    return {
      pages,
      totalPages: document.numPages,
      nextPage: clipped ? finalPage : finalPage < document.numPages ? finalPage + 1 : null,
      truncated: clipped || firstPage > 1 || finalPage < document.numPages,
      imageOnly: pages.every(page => !page.text.trim()),
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    await task.destroy()
  }
}
