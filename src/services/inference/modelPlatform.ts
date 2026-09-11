export function modelPlatformTarget(hardware: { platform: string; arch: string }): string {
  const target = `${hardware.platform}-${hardware.arch}`
  if (!['windows-x86_64', 'linux-x86_64', 'linux-aarch64', 'macos-aarch64', 'macos-x86_64'].includes(target))
    throw new Error('Für diese Betriebssystem-/Prozessor-Kombination ist keine lokale Modellplattform eingerichtet.')
  return target
}
