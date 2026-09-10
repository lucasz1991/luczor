import { readFile, writeFile, mkdir, copyFile, rm, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { managedClaudeRuntimeProfile } from './agent-runtime-platform.mjs'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(app, '../.lmzdev/artifacts/runtime/claude-agent')

async function main() {
  const profile = managedClaudeRuntimeProfile(process.platform, process.arch, process.env.TAURI_ENV_TARGET_TRIPLE)
  if (!profile) {
    console.warn(
      `Managed Claude runtime skipped for ${process.platform}/${process.arch}; ` +
        'the app will build without a compatible Claude bundle.'
    )
    return
  }

  const require = createRequire(import.meta.url)
  const sdk = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const sdkRequire = createRequire(join(sdk, 'sdk.mjs'))
  let cli
  try {
    cli = sdkRequire.resolve(`${profile.packageName}/${profile.cliExecutable}`)
  } catch {
    console.warn(
      `Managed Claude runtime skipped for ${profile.platform}/${profile.arch}: ` +
        `optional package ${profile.packageName} is not installed.`
    )
    return
  }
  const version = execFileSync(cli, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  }).trim()
  if (!/^2\.1\.266\s/u.test(version)) throw new Error('Unexpected app-owned Claude CLI version.')
  await rm(destination, { recursive: true, force: true })
  const packageDirectory = join(destination, 'node_modules/@anthropic-ai/claude-agent-sdk')
  await mkdir(packageDirectory, { recursive: true })
  for (const file of ['sdk.mjs', 'package.json', 'manifest.json', 'manifest.zst.json']) {
    await copyFile(join(sdk, file), join(packageDirectory, file))
  }
  const nodePath = join(destination, profile.nodeExecutable)
  const cliPath = join(destination, profile.cliExecutable)
  await copyFile(process.execPath, nodePath)
  await copyFile(cli, cliPath)
  if (process.platform !== 'win32') {
    await chmod(nodePath, 0o755)
    await chmod(cliPath, 0o755)
  }
  const source = await readFile(join(app, 'scripts/claude-worker.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  await writeFile(join(destination, 'worker.mjs'), compiled)
  const files = [
    profile.nodeExecutable,
    profile.cliExecutable,
    'worker.mjs',
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  ]
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async file => [
        file,
        createHash('sha256')
          .update(await readFile(join(destination, file)))
          .digest('hex'),
      ])
    )
  )
  await writeFile(
    join(destination, 'runtime.json'),
    JSON.stringify(
      {
        sdkVersion: '0.3.266',
        cliVersion: '2.1.266',
        nodeVersion: process.versions.node,
        platform: profile.platform,
        arch: profile.arch,
        libc: profile.libc,
        nodeExecutable: profile.nodeExecutable,
        cliExecutable: profile.cliExecutable,
        hashes,
      },
      null,
      2
    )
  )
  console.log(
    `Managed Claude runtime prepared for ${profile.platform}/${profile.arch}: SDK 0.3.266, ` +
      `CLI ${version}; no inference started.`
  )
}

main().catch(error => {
  console.error(`Managed Claude runtime preparation failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
