# Isolated real WebView2 research proof; no provider call, desktop input or installation.
[CmdletBinding()]
param([switch]$LivePublic)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $projectRoot 'tests/native/browser-probe.manifest'
$mt = Get-ChildItem 'C:/Program Files (x86)/Windows Kits/10/bin' -Filter mt.exe -Recurse |
    Where-Object FullName -Match '[\\/]x64[\\/]mt\.exe$' | Sort-Object FullName | Select-Object -Last 1
if (-not $mt) { throw 'Windows SDK Manifest Tool (x64 mt.exe) is required.' }
$messages = & cargo test --manifest-path (Join-Path $projectRoot 'src-tauri/Cargo.toml') --lib --features native-browser-smoke --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Native research proof compilation failed.' }
$artifacts = $messages | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } }
$probe = $artifacts | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } | Select-Object -Last 1
if (-not $probe) { throw 'Cargo did not return a research test executable.' }
& $mt.FullName -nologo -manifest $manifest "-outputresource:$($probe.executable);#1"
if ($LASTEXITCODE -ne 0) { throw 'Native research proof manifest embedding failed.' }
# Windows PowerShell 5 wraps harmless native stderr as ErrorRecord; the process exit
# and explicit success markers are authoritative, rather than stream selection.
$ErrorActionPreference = 'Continue'
$testName = if ($LivePublic) { 'native_research_live_smoke' } else { 'native_research_smoke' }
$result = & $probe.executable $testName --ignored --test-threads=1 --nocapture 2>&1
$nativeExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$result | ForEach-Object { $_.ToString() }
if ($nativeExit -ne 0 -or -not ($result -match 'NATIVE_RESEARCH_PROBE_OK:') -or -not ($result -match 'NATIVE_RESEARCH_SESSION_OK:')) {
    throw 'Native research proof did not complete successfully.'
}
if ($LivePublic -and -not ($result -match 'NATIVE_RESEARCH_LIVE_WEB_OK:')) {
    throw 'Live public native research proof did not verify its source download.'
}
