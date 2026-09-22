import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareVoiceRuntime, verifyVoiceModel } from './prepare-voice-runtime.mjs'

const bytes = Buffer.from('fixture voice model')
const model = {
  file: 'model.bin',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  url: 'https://example.test/model',
}

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), 'luczor-voice-package-'))
  try {
    await run(root)
  } finally {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}luczor-voice-package-`))
    await rm(root, { recursive: true, force: true })
  }
}

test('bundles a verified model and licenses; repeated preparation works offline', () =>
  temporary(async root => {
    let calls = 0
    await prepareVoiceRuntime(root, model, async () => {
      calls++
      return new Response(bytes)
    })
    assert.equal(calls, 1)
    assert.equal(await verifyVoiceModel(join(root, model.file), model), true)
    assert.match(await readFile(join(root, 'LICENSES.txt'), 'utf8'), /OpenAI/)
    await prepareVoiceRuntime(root, model, () => {
      throw new Error('network must not be used')
    })
    assert.deepEqual(JSON.parse(await readFile(join(root, 'model.json'), 'utf8')), model)
  }))

test('repairs a corrupt cached model and rejects tampered downloads', () =>
  temporary(async root => {
    const target = join(root, model.file)
    await writeFile(target, Buffer.alloc(bytes.length))
    assert.equal(await verifyVoiceModel(target, model), false)
    await assert.rejects(
      prepareVoiceRuntime(root, model, async () => new Response(Buffer.alloc(bytes.length))),
      /checksum/
    )
    assert.deepEqual(await readFile(target), Buffer.alloc(bytes.length))
    await prepareVoiceRuntime(root, model, async () => new Response(bytes))
    assert.equal(await verifyVoiceModel(target, model), true)
  }))

test('refuses a truncated download or HTTP failure instead of shipping a broken installer', () =>
  temporary(async root => {
    await assert.rejects(
      prepareVoiceRuntime(root, model, async () => new Response(bytes.subarray(0, 3))),
      /checksum/
    )
    await assert.rejects(
      prepareVoiceRuntime(root, model, async () => new Response('error', { status: 503 })),
      /HTTP 503/
    )
    assert.equal(await verifyVoiceModel(join(root, model.file), model), false)
  }))
