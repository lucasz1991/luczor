import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const fakeServer = `
let buffer = Buffer.alloc(0);
const send = message => { const body = JSON.stringify({jsonrpc:'2.0',...message}); process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body); };
process.stdin.on('data', chunk => {
 buffer = Buffer.concat([buffer, chunk]);
 while (true) {
  const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
  const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,end).toString())[1]);
  if (buffer.length < end+4+length) return;
  const message = JSON.parse(buffer.subarray(end+4,end+4+length)); buffer = buffer.subarray(end+4+length);
  if (message.method === 'initialize') send({id:message.id,result:{capabilities:{referencesProvider:true,documentSymbolProvider:true}}});
  else if (message.method === 'textDocument/documentSymbol') {
    if (message.params.textDocument.uri.endsWith('/bad.ts')) {
      if (process.env.LSP_FIXTURE_EXIT) process.exit(1);
      send({id:message.id,error:{code:-32603,message:'PRIVATE_PATH SECRET'}});
    } else send({id:message.id,result:[]});
  } else if (message.method === 'shutdown') send({id:message.id,result:null});
  else if (message.method === 'exit') process.exit(0);
 }
});
`

async function fixture(run, real = false) {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'luczor-lsp-contract-'))
  try {
    const snapshot = join(root, 'snapshot')
    await mkdir(snapshot)
    let worker
    if (real) worker = resolve(scripts, '../../.lmzdev/artifacts/runtime/repository-lsp/worker.mjs')
    else {
      worker = join(root, 'worker.mjs')
      await copyFile(join(scripts, 'repository-lsp-worker.mjs'), worker)
      const cli = join(root, 'typescript-language-server/lib')
      await mkdir(cli, { recursive: true })
      await writeFile(join(cli, 'cli.mjs'), fakeServer)
    }
    return await run(worker, snapshot)
  } finally {
    // Only remove the fresh, explicitly verified fixture, never a repo/runtime.
    assert.equal(dirname(root), parent)
    assert.ok(root.startsWith(join(parent, 'luczor-lsp-contract-')))
    await rm(root, { recursive: true, force: true })
  }
}

function execute(worker, snapshot, input, env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [worker, snapshot], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', ...env },
    })
    const output = []
    const errors = []
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => errors.push(chunk))
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) return reject(new Error('Fixture worker failed: ' + Buffer.concat(errors)))
      try {
        resolveResult(JSON.parse(Buffer.concat(output)))
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}
const files = ['bad.ts', 'good.ts'].map(path => ({ path, content: 'export const value = 1;', hash: 'fixture' }))

test('one rejected file preserves progress, reports partial and never returns private server errors', async () => {
  const result = await fixture((worker, snapshot) => execute(worker, snapshot, { files }))
  assert.equal(result.status, 'partial')
  assert.equal(result.reason, 'lsp_request_rejected')
  assert.equal(result.failed_files, 1)
  assert.equal(result.scanned, 1)
  assert.equal(result.next_file, 2)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH|SECRET/)
})

test('server death rejects pending requests promptly and retains the retry cursor', async () => {
  const started = Date.now()
  const result = await fixture((worker, snapshot) => execute(worker, snapshot, { files }, { LSP_FIXTURE_EXIT: '1' }))
  assert.equal(result.status, 'error')
  assert.equal(result.reason, 'lsp_server_exited')
  assert.equal(result.next_file, 0)
  assert.ok(Date.now() - started < 8000)
})

test('a resumed pass retains earlier file failures rather than claiming ready', async () => {
  const result = await fixture((worker, snapshot) =>
    execute(worker, snapshot, { files, next_file: 1, scanned: 0, failed_files: 1 })
  )
  assert.equal(result.status, 'partial')
  assert.equal(result.failed_files, 1)
  assert.equal(result.scanned, 1)
})

test(
  'managed TS/JS runtime scans 714 synthetic files across bounded resumable passes',
  { skip: !process.env.LUCZOR_TEST_MANAGED_LSP },
  async () => {
    const sources = Array.from({ length: 714 }, (_, index) => ({
      path: `file${String(index).padStart(4, '0')}.ts`,
      content: `export const value${index} = ${index};`,
      hash: `fixture-${index}`,
    }))
    let progress = { next_file: 0, next_symbol: 0, scanned: 0, failed_files: 0 }
    for (let pass = 0; pass < 5; pass++) {
      const result = await fixture(
        (worker, snapshot) => execute(worker, snapshot, { files: sources, ...progress }),
        true
      )
      assert.notEqual(result.status, 'error', JSON.stringify(result))
      assert.equal(result.failed_files, 0, JSON.stringify(result))
      assert.ok(result.next_file > progress.next_file || result.next_symbol > progress.next_symbol)
      progress = result
      if (result.status === 'ready') break
    }
    assert.equal(progress.status, 'ready')
    assert.equal(progress.scanned, 714)
  }
)
