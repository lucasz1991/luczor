# The native test needs Common Controls v6 just like the packaged Tauri binary.
# Cargo unit-test executables do not inherit the application's Windows manifest.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $projectRoot 'tests/native/browser-probe.manifest'
$mt = Get-ChildItem 'C:/Program Files (x86)/Windows Kits/10/bin' -Filter mt.exe -Recurse |
    Where-Object FullName -Match '[\\/]x64[\\/]mt\.exe$' | Sort-Object FullName | Select-Object -Last 1
if (-not $mt) { throw 'Windows SDK Manifest Tool (x64 mt.exe) is required.' }
$messages = & cargo test --manifest-path (Join-Path $projectRoot 'src-tauri/Cargo.toml') --lib --features native-browser-smoke --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Native probe compilation failed.' }
$artifacts = $messages | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } }
$probe = $artifacts | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } | Select-Object -Last 1
if (-not $probe) { throw 'Cargo did not return a test executable.' }
& $mt.FullName -nologo -manifest $manifest "-outputresource:$($probe.executable);#1"
if ($LASTEXITCODE -ne 0) { throw 'Native probe manifest embedding failed.' }
$result = & $probe.executable native_browser_panel_smoke --ignored --test-threads=1 --nocapture 2>&1
$result | Write-Output
if ($LASTEXITCODE -ne 0 -or -not ($result -match 'NATIVE_BROWSER_PROBE_OK:')) { throw 'Native browser probe did not complete successfully.' }
