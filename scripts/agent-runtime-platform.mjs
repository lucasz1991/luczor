/**
 * The managed Claude bundle currently contains Windows x64 executables.
 * Keep this decision in a small, side-effect-free module so build and release
 * checks can exercise it without creating or starting a runtime.
 */
export function supportsManagedClaudeRuntime(platform, arch) {
  return platform === 'win32' && arch === 'x64'
}
