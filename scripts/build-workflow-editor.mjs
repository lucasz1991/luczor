import { build } from 'vite'
import { copyFile, mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
const app = fileURLToPath(new URL('../', import.meta.url))
await build({ root: app, configFile: fileURLToPath(new URL('../vite.workflow-editor.config.ts', import.meta.url)) })
const source = fileURLToPath(new URL('../../.lmzdev/artifacts/runtime/workflow-editor', import.meta.url))
const destination = fileURLToPath(new URL('../../admin_api_app/public/workflow-editor', import.meta.url))
await mkdir(destination, { recursive: true })
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isFile() && entry.name !== 'manifest.json') await copyFile(join(source, entry.name), join(destination, entry.name))
}
await copyFile(join(source, 'manifest.json'), join(destination, 'manifest.next.json'))
await rename(join(destination, 'manifest.next.json'), join(destination, 'manifest.json'))
console.log('Shared workflow editor built and copied to local Laravel public assets; no deployment.')
