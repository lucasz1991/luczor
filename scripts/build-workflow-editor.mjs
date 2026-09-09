import { build } from 'vite'
import { cp, mkdir } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
const app = fileURLToPath(new URL('../', import.meta.url))
await build({ root: app, configFile: fileURLToPath(new URL('../vite.workflow-editor.config.ts', import.meta.url)) })
const source = fileURLToPath(new URL('../../.lmzdev/artifacts/runtime/workflow-editor', import.meta.url))
const destination = fileURLToPath(new URL('../../admin_api_app/public/workflow-editor', import.meta.url))
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
console.log('Shared workflow editor built and copied to local Laravel public assets; no deployment.')
