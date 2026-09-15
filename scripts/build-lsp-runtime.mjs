import { cp, copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(app, '../.lmzdev/artifacts/runtime/repository-lsp')
const require = createRequire(import.meta.url)
const target = process.env.TAURI_ENV_TARGET_TRIPLE || ''
const targetOs = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform]
if (target && (!targetOs || !target.includes(targetOs)))
  throw new Error('Build the repository LSP runtime on the target OS.')
if (
  process.env.TAURI_ENV_TARGET_TRIPLE &&
  !process.env.TAURI_ENV_TARGET_TRIPLE.includes(
    process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  )
) {
  throw new Error('Build the repository LSP runtime on the target architecture.')
}
await mkdir(root, { recursive: true })
const node = process.platform === 'win32' ? 'node.exe' : 'node'
await copyFile(process.execPath, join(root, node))
try {
  await copyFile(join(dirname(process.execPath), 'LICENSE'), join(root, 'NODE-LICENSE'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  // Distro Node installations do not put LICENSE next to /usr/bin/node.
  // This build-time request contains only the version, never repository data.
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!license.ok) throw new Error('The bundled Node license could not be retrieved.')
  await writeFile(join(root, 'NODE-LICENSE'), await license.text())
}
await copyFile(join(app, 'scripts/repository-lsp-worker.mjs'), join(root, 'worker.mjs'))
const files = [node, 'worker.mjs', 'NODE-LICENSE']
for (const [name, entry] of [
  ['typescript', 'typescript/lib/tsserver.js'],
  ['typescript-language-server', 'typescript-language-server/lib/cli.mjs'],
]) {
  const packageRoot = resolve(dirname(require.resolve(entry)), '..')
  // Both distributions are self-contained; no workspace packages or scripts are copied.
  await cp(join(packageRoot, 'lib'), join(root, name, 'lib'), { recursive: true })
  await copyFile(join(packageRoot, 'package.json'), join(root, name, 'package.json'))
  for (const file of await readdir(packageRoot)) {
    if (/license|notice|copying/iu.test(file)) await copyFile(join(packageRoot, file), join(root, name, file))
  }
  async function list(dir) {
    for (const item of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${item.name}`
      if (item.isDirectory()) await list(path)
      else if (item.isFile()) files.push(path)
    }
  }
  await list(name)
}
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async file => [
      file,
      createHash('sha256')
        .update(await readFile(join(root, file)))
        .digest('hex'),
    ])
  )
)
await writeFile(
  join(root, 'runtime.json'),
  JSON.stringify(
    {
      version: 1,
      provider: 'typescript-language-server@5.3.0',
      platform: process.platform,
      arch: process.arch,
      node,
      hashes,
    },
    null,
    2
  )
)
console.log(`Repository LSP runtime prepared: ${process.platform}/${process.arch}; no repository scanned.`)
