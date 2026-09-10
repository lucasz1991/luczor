const { spawnSync } = require('node:child_process')

function checkLinuxMedia(platform = process.platform, run = spawnSync) {
  if (platform !== 'linux') return []
  const missing = []
  for (const element of ['fakevideosink', 'webvttenc']) {
    const result = run('gst-inspect-1.0', [element], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    })
    if (result.error?.code === 'ENOENT') return ['gst-inspect-1.0 (GStreamer tools)']
    if (result.error || result.status !== 0) missing.push(element)
  }
  return missing
}

function reportLinuxMedia(platform = process.platform, run = spawnSync, warn = console.warn) {
  const missing = checkLinuxMedia(platform, run)
  if (missing.length) {
    warn(
      `Luczor: Linux multimedia components unavailable: ${missing.join(', ')}. Run: bash scripts/setup-desktop.sh --install-media. This check concerns WebKit multimedia, not model RAM/VRAM or CUDA readiness.`
    )
  }
  return missing
}

module.exports = { checkLinuxMedia, reportLinuxMedia }
if (require.main === module) process.exitCode = reportLinuxMedia().length ? 1 : 0
