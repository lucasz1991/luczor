// Native Windows regression: fixture only, no model/account/runtime inference.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { childEnvironment } from './isolated-model-smoke.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test(
  'native fixture survives harmless stderr through Windows PowerShell 5 with sanitized environment',
  {
    skip: process.platform !== 'win32' || process.env.LUCZOR_RUN_NATIVE_BROWSER_REGRESSION !== '1',
    timeout: 15 * 60_000,
  },
  async () => {
    const output = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', resolve(root, 'scripts/test-browser-panel-native.ps1'), '-Isolated'],
      { cwd: root, windowsHide: true, env: childEnvironment(), timeout: 15 * 60_000, maxBuffer: 1024 * 1024 }
    )
    assert.match(output.stdout, /NATIVE_BROWSER_PROBE_OK:/)
    const path = /^NATIVE_BROWSER_EVIDENCE=(.+)$/m.exec(output.stdout)?.[1]?.trim()
    assert.ok(path, 'native evidence path missing')
    const report = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(report.status, 'passed')
    assert.equal(report.events.length, 10)
    assert.ok(report.events.every(event => event.status === 'passed'))
  }
)
