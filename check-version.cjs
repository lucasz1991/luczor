#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const projectRoot = __dirname
const packageVersion = require('./package.json').version
const tauriVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8')).version
const cargoManifest = fs.readFileSync(path.join(projectRoot, 'src-tauri/Cargo.toml'), 'utf8')
const cargoVersionMatch = cargoManifest.match(/^version\s*=\s*"([^"]+)"\s*$/m)

if (!cargoVersionMatch) {
  console.error('Version check failed: package version missing from src-tauri/Cargo.toml')
  process.exit(1)
}

const versions = {
  'package.json': packageVersion,
  'src-tauri/tauri.conf.json': tauriVersion,
  'src-tauri/Cargo.toml': cargoVersionMatch[1],
}
const uniqueVersions = new Set(Object.values(versions))

if (uniqueVersions.size !== 1) {
  console.error('Version check failed: release metadata differs')
  Object.entries(versions).forEach(([filename, version]) => {
    console.error(`- ${filename}: ${version}`)
  })
  process.exit(1)
}

console.log(`Release version ${packageVersion} is consistent across all manifests.`)
