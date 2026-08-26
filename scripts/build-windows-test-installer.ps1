[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'PinnedNode.psm1') -Force
$context = Use-LuczorPinnedNode
$projectRoot = $context.ProjectRoot
$buildStarted = Get-Date

Push-Location $projectRoot
try {
    Write-Output "Using project-pinned Node v$($context.Version)."
    & node.exe scripts/release-readiness.cjs --mode local-test
    if ($LASTEXITCODE -ne 0) {
        throw "Local release-readiness failed with exit code $LASTEXITCODE."
    }

    # The local-test overlay uses a distinct product identity and a current-user
    # NSIS installer. --no-sign is intentional: this path must never consume or
    # invent production signing/updater values.
    & corepack.cmd pnpm tauri build --debug --bundles nsis --config src-tauri/tauri.local-test.conf.json --no-sign --ci
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri test-installer build failed with exit code $LASTEXITCODE."
    }

    $bundleDirectory = Join-Path $projectRoot 'src-tauri\target\debug\bundle\nsis'
    $installer = Get-ChildItem -LiteralPath $bundleDirectory -Filter '*.exe' -File |
        Where-Object { $_.LastWriteTime -ge $buildStarted.AddSeconds(-5) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $installer) {
        throw "No newly built NSIS installer was found in $bundleDirectory."
    }

    & node.exe scripts/check-unsigned-pe.cjs $installer.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "Unsigned installer verification failed with exit code $LASTEXITCODE."
    }

    $hash = Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
    Write-Output "Unsigned local test installer: $($installer.FullName)"
    Write-Output "Size: $($installer.Length) bytes"
    Write-Output "SHA-256: $($hash.Hash)"
}
finally {
    Pop-Location
}
