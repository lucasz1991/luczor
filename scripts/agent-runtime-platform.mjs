/**
 * The managed Claude bundle currently contains Windows x64 executables.
 * Keep this decision in a small, side-effect-free module so build and release
 * checks can exercise it without creating or starting a runtime.
 */
export function supportsManagedClaudeRuntime(platform, arch, targetTriple = '') {
  const target = targetTriple.trim().toLowerCase()
  if (target && !target.includes('windows')) return false
  if (target && !/^(x86_64|amd64)[-_]/u.test(target)) return false
  return platform === 'win32' && arch === 'x64'
}
