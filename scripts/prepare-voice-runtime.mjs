import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const voiceRoot = resolve(app, '../.lmzdev/artifacts/runtime/voice')
export const voiceModel = JSON.parse(await readFile(join(app, 'src-tauri/voice-model.json'), 'utf8'))

export async function verifyVoiceModel(file, model = voiceModel) {
  try {
    if ((await stat(file)).size !== model.bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === model.sha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Build-time download only. Installed clients never need an account or a download for STT.
export async function prepareVoiceRuntime(root = voiceRoot, model = voiceModel, request = fetch) {
  await mkdir(root, { recursive: true })
  const target = join(root, model.file)
  if (!(await verifyVoiceModel(target, model))) {
    console.log('Preparing bundled multilingual Whisper model (60 MB) …')
    const partial = `${target}.${process.pid}.part`
    try {
      const response = await request(model.url, { signal: AbortSignal.timeout(300_000) })
      if (!response.ok || !response.body) throw new Error(`Whisper model download failed: HTTP ${response.status}`)
      const output = await open(partial, 'w')
      let bytes = 0
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > model.bytes) throw new Error('Whisper model exceeds its pinned size.')
          await output.writeFile(chunk)
        }
      } finally {
        await output.close()
      }
      if (!(await verifyVoiceModel(partial, model))) throw new Error('Whisper model checksum/size mismatch.')
      await rename(partial, target)
    } finally {
      await rm(partial, { force: true })
    }
  }
  await copyFile(join(app, 'src-tauri/voice-licenses.txt'), join(root, 'LICENSES.txt'))
  await writeFile(join(root, 'model.json'), `${JSON.stringify(model, null, 2)}\n`)
  console.log('Bundled Whisper model verified; recognition engine is linked into the app.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareVoiceRuntime()
}
