/**
 * Resolve the managed Claude bundle for the native build host.
 *
 * The platform packages are optional dependencies of the Claude SDK. A
 * runtime is only selected when the build host and (when supplied) the target
 * triple describe the same supported platform and architecture. This keeps a
 * Windows executable out of Linux/macOS bundles and also prevents an
 * accidental cross-target copy of the host's Node executable.
 */
const profiles = {
  win32: {
    x64: {
      packageName: '@anthropic-ai/claude-agent-sdk-win32-x64',
      cliExecutable: 'claude.exe',
      nodeExecutable: 'node.exe',
    },
  },
  linux: {
    x64: {
      packageName: '@anthropic-ai/claude-agent-sdk-linux-x64',
      cliExecutable: 'claude',
      nodeExecutable: 'node',
    },
    arm64: {
      packageName: '@anthropic-ai/claude-agent-sdk-linux-arm64',
      cliExecutable: 'claude',
      nodeExecutable: 'node',
    },
  },
  darwin: {
    x64: {
      packageName: '@anthropic-ai/claude-agent-sdk-darwin-x64',
      cliExecutable: 'claude',
      nodeExecutable: 'node',
    },
    arm64: {
      packageName: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      cliExecutable: 'claude',
      nodeExecutable: 'node',
    },
  },
}

function targetPlatform(target) {
  if (target.includes('windows')) return 'win32'
  if (target.includes('linux')) return 'linux'
  if (target.includes('darwin') || target.includes('apple-darwin')) return 'darwin'
  return undefined
}

function targetArch(target) {
  if (/^(x86_64|amd64)[-_]/u.test(target)) return 'x64'
  if (/^(aarch64|arm64)[-_]/u.test(target)) return 'arm64'
  return undefined
}

/**
 * Return the app-owned runtime profile or null when this build cannot produce
 * a native bundle without copying an incompatible binary.
 */
export function managedClaudeRuntimeProfile(platform, arch, targetTriple = '') {
  const normalizedPlatform = String(platform).trim().toLowerCase()
  const normalizedArch = String(arch).trim().toLowerCase()
  const target = String(targetTriple).trim().toLowerCase()
  const targetOs = target ? targetPlatform(target) : normalizedPlatform
  const targetCpu = target ? targetArch(target) : normalizedArch
  if (!targetOs || !targetCpu || targetOs !== normalizedPlatform || targetCpu !== normalizedArch) return null
  const profile = profiles[targetOs]?.[targetCpu]
  if (!profile) return null

  // Linux distributions using musl have a separate vendor package. Prefer an
  // explicit build override, then the target triple, and default to glibc.
  const requestedLibc = process.env.LUCZOR_CLAUDE_LIBC?.trim().toLowerCase()
  const libc = targetOs === 'linux' && (requestedLibc === 'musl' || target.includes('musl')) ? 'musl' : 'glibc'
  if (targetOs === 'linux' && libc === 'musl') {
    return { ...profile, platform: targetOs, arch: targetCpu, packageName: `${profile.packageName}-musl`, libc: 'musl' }
  }
  return { ...profile, platform: targetOs, arch: targetCpu, libc: targetOs === 'linux' ? libc : undefined }
}

export function supportsManagedClaudeRuntime(platform, arch, targetTriple = '') {
  return managedClaudeRuntimeProfile(platform, arch, targetTriple) !== null
}
