// Read-only LSP enrichment. stdin contains ONLY approved files from the native
// index. Never open the original repository or load its tsconfig/plugins.
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtime = dirname(fileURLToPath(import.meta.url))
const snapshot = resolve(process.argv[2]) // Created and owned by the native caller.
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const allowed = new Map()
const uriKey = uri => {
  try {
    const path = resolve(fileURLToPath(uri))
    return process.platform === 'win32' ? path.toLowerCase() : path
  } catch {
    return ''
  }
}
const byPath = new Map()
for (const file of input.files) {
  const path = resolve(snapshot, file.path)
  const rel = relative(snapshot, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.(?:[cm]?[jt]sx?)$/u.test(rel))
    throw new Error('Invalid snapshot file')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, file.content, { flag: 'wx' })
  allowed.set(pathToFileURL(path).href, file)
  byPath.set(uriKey(pathToFileURL(path).href), file)
}
await writeFile(
  join(snapshot, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'preserve',
      noResolve: false,
      skipLibCheck: true,
      types: [],
    },
    include: ['**/*'],
  }),
  { flag: 'wx' }
)
const server = spawn(
  process.execPath,
  ['--max-old-space-size=384', join(runtime, 'typescript-language-server/lib/cli.mjs'), '--stdio'],
  {
    cwd: snapshot,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  }
)
let sequence = 0
let buffer = Buffer.alloc(0)
const pending = new Map()
function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
function request(method, params, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('LSP request timeout'))
    }, timeout)
    pending.set(id, { resolve, reject, timer })
    send({ id, method, params })
  })
}
server.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  if (buffer.length > 8 * 1024 * 1024) {
    server.kill()
    return
  }
  while (true) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const match = /Content-Length: (\d+)/iu.exec(buffer.subarray(0, end).toString())
    if (!match) {
      server.kill()
      return
    }
    const length = Number(match[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    if (message.method && message.id !== undefined) {
      // No edits, execution, configuration plugins, or server-initiated reads.
      send({
        id: message.id,
        result: message.method === 'workspace/configuration' ? (message.params.items || []).map(() => null) : null,
      })
    } else if (pending.has(message.id)) {
      const item = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error('LSP request rejected'))
      else item.resolve(message.result)
    }
  }
})
const result = {
  status: 'ready',
  scanned: input.next_file || 0,
  next_file: input.next_file || 0,
  next_symbol: input.next_symbol || 0,
  edges: [],
  provider: 'typescript-language-server@5.3.0',
}
try {
  const initialized = await request(
    'initialize',
    {
      processId: process.pid,
      rootUri: pathToFileURL(snapshot).href,
      capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      initializationOptions: {
        disableAutomaticTypingAcquisition: true,
        maxTsServerMemory: 512,
        plugins: [],
        tsserver: { path: join(runtime, 'typescript/lib/tsserver.js'), useSyntaxServer: 'never' },
        preferences: { includePackageJsonAutoImports: 'off' },
      },
    },
    15000
  )
  if (!initialized.capabilities?.referencesProvider || !initialized.capabilities?.documentSymbolProvider)
    throw new Error('LSP reference capability missing')
  send({ method: 'initialized', params: {} })
  const deadline = Date.now() + 45000
  let symbolsSeen = 0
  const unique = new Set()
  const entries = [...allowed]
  outer: for (let fileIndex = result.next_file; fileIndex < entries.length; fileIndex++) {
    const [uri, file] = entries[fileIndex]
    if (Date.now() > deadline || symbolsSeen >= 500) {
      result.status = 'partial'
      break
    }
    send({
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: /\.tsx?$/u.test(file.path) ? 'typescript' : 'javascript',
          version: 1,
          text: file.content,
        },
      },
    })
    const symbols = (await request('textDocument/documentSymbol', { textDocument: { uri } })) || []
    const flat = []
    function collect(items) {
      for (const item of items) {
        if ([5, 6, 9, 12, 13, 14].includes(item.kind)) flat.push(item)
        if (item.children) collect(item.children)
      }
    }
    collect(symbols)
    for (let symbolIndex = result.next_symbol; symbolIndex < flat.length; symbolIndex++) {
      const symbol = flat[symbolIndex]
      if (Date.now() > deadline || symbolsSeen++ >= 500) {
        result.status = 'partial'
        break outer
      }
      const position = symbol.selectionRange?.start || symbol.location?.range?.start
      if (!position) {
        result.next_symbol = symbolIndex + 1
        continue
      }
      const references =
        (await request('textDocument/references', {
          textDocument: { uri },
          position,
          context: { includeDeclaration: false },
        })) || []
      for (const ref of references) {
        const source = byPath.get(uriKey(ref.uri))
        if (!source || source.path === file.path) continue
        const edge = {
          source: source.path,
          target: file.path,
          symbol: symbol.name,
          source_line: ref.range.start.line + 1,
          target_line: position.line + 1,
        }
        const key = JSON.stringify(edge)
        if (!unique.has(key)) {
          unique.add(key)
          result.edges.push(edge)
        }
        if (result.edges.length >= 10000) {
          result.next_symbol = symbolIndex + 1
          result.status = 'partial'
          break outer
        }
      }
      result.next_symbol = symbolIndex + 1
    }
    result.scanned++
    result.next_file = fileIndex + 1
    result.next_symbol = 0
  }
} catch {
  result.status = 'error'
} finally {
  try {
    await request('shutdown', null, 1000)
  } catch {
    /* Native owner kills the full tree. */
  }
  send({ method: 'exit' })
  server.kill()
  for (const item of pending.values()) clearTimeout(item.timer)
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}
