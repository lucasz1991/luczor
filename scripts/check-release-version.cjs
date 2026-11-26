#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS release script. */
// A package manager only replaces an installed package when the version rises.
// Delivered builds are tagged vX.Y.Z; a package built from any later commit
// must therefore carry a version above the highest delivered tag.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

function parse(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(value).trim())
  return match ? match.slice(1).map(Number) : null
}

function compare([leftMajor, leftMinor, leftPatch], [rightMajor, rightMinor, rightPatch]) {
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch
}

function checkReleaseVersion({ version, tags, head, commitOf }) {
  const current = parse(version)
  if (!current) throw new Error(`Package version ${version} is not a plain MAJOR.MINOR.PATCH release version.`)
  const delivered = tags
    .map(tag => ({ tag, parsed: parse(tag) }))
    .filter(item => item.parsed && /^v/u.test(item.tag))
    .sort((left, right) => compare(right.parsed, left.parsed))
  if (delivered.length === 0) return { version, latestTag: null, rebuild: false }
  const latest = delivered[0]
  const order = compare(current, latest.parsed)
  if (order > 0) return { version, latestTag: latest.tag, rebuild: false }
  if (order === 0 && commitOf(latest.tag) === head) return { version, latestTag: latest.tag, rebuild: true }
  throw new Error(
    `Package version ${version} is not above the delivered ${latest.tag}. ` +
      'Run `pnpm bump <next-version>` before building an installable package; ' +
      'otherwise the package manager keeps the installed build.'
  )
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 }).trim()
}

module.exports = { checkReleaseVersion }
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..')
    const tags = git(['tag', '--list', 'v*'], root).split('\n').filter(Boolean)
    const result = checkReleaseVersion({
      version: require('../package.json').version,
      tags,
      head: git(['rev-parse', 'HEAD'], root),
      commitOf: tag => git(['rev-list', '-n', '1', tag], root),
    })
    if (!result.latestTag) console.warn('WARNING: no delivered v* tag found; version order was not checked.')
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
