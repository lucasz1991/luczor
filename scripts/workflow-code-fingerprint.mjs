import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'

/** Exact compiled-client source identity; no absolute paths or source contents leave the build. */
export function workflowCodeFingerprint(root) {
  const files = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.(?:ts|vue|js|json)$/.test(entry.name)) files.push(path)
    }
  }
  visit(resolve(root, 'src'))
  files.push(resolve(root, 'package.json'), resolve(root, 'pnpm-lock.yaml'))
  const hash = createHash('sha256')
  for (const file of files.sort()) hash.update(relative(root, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0')
  return hash.digest('hex')
}
