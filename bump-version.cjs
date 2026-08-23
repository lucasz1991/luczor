#!/usr/bin/env node

const fs = require('fs').promises
const path = require('path')
const packageJson = require('./package.json')
const OLD_VERSION = packageJson.version
const PROJECT_ROOT = __dirname
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

const VERSION_FILES = [
  {
    filename: 'package.json',
    pattern: oldVersion => new RegExp(`"version"\\s*:\\s*"${escapeRegExp(oldVersion)}"`, 'g'),
    replacement: newVersion => `"version": "${newVersion}"`,
  },
  {
    filename: 'src-tauri/tauri.conf.json',
    pattern: oldVersion => new RegExp(`"version"\\s*:\\s*"${escapeRegExp(oldVersion)}"`, 'g'),
    replacement: newVersion => `"version": "${newVersion}"`,
  },
  {
    filename: 'src-tauri/Cargo.toml',
    pattern: oldVersion => new RegExp(`^version\\s*=\\s*"${escapeRegExp(oldVersion)}"\\s*$`, 'gm'),
    replacement: newVersion => `version = "${newVersion}"`,
  },
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countMatches(content, pattern) {
  return Array.from(content.matchAll(pattern)).length
}

async function updateVersion() {
  const newVersion = process.argv[2]
  if (!newVersion || !SEMVER_PATTERN.test(newVersion)) {
    throw new Error('Usage: pnpm bump <valid-semver>')
  }
  if (newVersion === OLD_VERSION) {
    throw new Error(`Version is already ${OLD_VERSION}`)
  }

  const preparedFiles = await Promise.all(
    VERSION_FILES.map(async ({ filename, pattern, replacement }) => {
      const filePath = path.join(PROJECT_ROOT, filename)
      const originalContent = await fs.readFile(filePath, 'utf8')
      const searchPattern = pattern(OLD_VERSION)
      const matchCount = countMatches(originalContent, searchPattern)
      if (matchCount !== 1) {
        throw new Error(`${filename} must contain version ${OLD_VERSION} exactly once; found ${matchCount}`)
      }

      return {
        filename,
        filePath,
        originalContent,
        updatedContent: originalContent.replace(searchPattern, replacement(newVersion)),
      }
    })
  )

  const writtenFiles = []
  try {
    for (const file of preparedFiles) {
      await fs.writeFile(file.filePath, file.updatedContent, 'utf8')
      writtenFiles.push(file)
    }
  } catch (error) {
    await Promise.all(writtenFiles.map(file => fs.writeFile(file.filePath, file.originalContent, 'utf8')))
    throw error
  }

  preparedFiles.forEach(file => console.log(`Updated ${file.filename} to ${newVersion}`))
}

updateVersion().catch(error => {
  console.error(`Version bump failed: ${error.message}`)
  process.exitCode = 1
})
