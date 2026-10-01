# The native test needs Common Controls v6 just like the packaged Tauri binary.
# Cargo unit-test executables do not inherit the application's Windows manifest.
[CmdletBinding()]
param(
    [switch]$Isolated,
    [switch]$Visible,
    [ValidateRange(0, 300)][int]$ManualSeconds = 0,
    [string]$RunId,
    [string]$ReportPath,
    [string]$ActionsPath
)
$ErrorActionPreference = 'Stop'
if (($Visible -or $ManualSeconds -gt 0 -or $RunId -or $ReportPath -or $ActionsPath) -and -not $Isolated) {
    throw 'Visible/manual/report/action options require -Isolated.'
}
if ($ManualSeconds -gt 0 -and -not $Visible) { throw 'ManualSeconds requires -Visible.' }
if ($RunId) { $RunId = ([guid]::Parse($RunId)).ToString() }
else { $RunId = [guid]::NewGuid().ToString() }
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($ReportPath) {
    if (-not [IO.Path]::IsPathRooted($ReportPath) -or [IO.Path]::GetPathRoot($ReportPath).Length -lt 3) { throw 'ReportPath must be absolute.' }
    $ReportPath = [IO.Path]::GetFullPath($ReportPath)
    $reportRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $projectRoot) '.lmzdev/artifacts'))
    if (-not $ReportPath.StartsWith($reportRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ReportPath must remain inside the central .lmzdev/artifacts directory.'
    }
    if (Test-Path -LiteralPath $ReportPath) { throw 'ReportPath must be new; evidence is never overwritten.' }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $ReportPath) -PathType Container)) { throw 'ReportPath parent must already exist.' }
}
if ($ActionsPath) {
    $ActionsPath = (Resolve-Path -LiteralPath $ActionsPath).Path
    if ((Get-Item -LiteralPath $ActionsPath).Length -gt 8192) { throw 'ActionsPath exceeds 8 KiB.' }
}
$manifest = Join-Path $projectRoot 'tests/native/browser-probe.manifest'
$mt = Get-ChildItem 'C:/Program Files (x86)/Windows Kits/10/bin' -Filter mt.exe -Recurse |
    Where-Object FullName -Match '[\\/]x64[\\/]mt\.exe$' | Sort-Object FullName | Select-Object -Last 1
if (-not $mt) { throw 'Windows SDK Manifest Tool (x64 mt.exe) is required.' }
$featureArgs = @()
# The isolated browser fixture does not exercise STT; avoid requiring libclang/Whisper.
if ($Isolated) { $featureArgs += '--no-default-features' }
$messages = & cargo test --manifest-path (Join-Path $projectRoot 'src-tauri/Cargo.toml') --lib @featureArgs --features native-browser-smoke --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'Native probe compilation failed.' }
$artifacts = $messages | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } }
$probe = $artifacts | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.profile.test -and $_.executable } | Select-Object -Last 1
if (-not $probe) { throw 'Cargo did not return a test executable.' }
& $mt.FullName -nologo -manifest $manifest "-outputresource:$($probe.executable);#1"
if ($LASTEXITCODE -ne 0) { throw 'Native probe manifest embedding failed.' }
$variables = @{
    LUCZOR_BROWSER_PROBE_VISIBLE = $(if ($Visible) { '1' } else { '0' })
    LUCZOR_BROWSER_PROBE_MANUAL_SECONDS = [string]$ManualSeconds
    LUCZOR_BROWSER_PROBE_RUN_ID = $RunId
    LUCZOR_BROWSER_PROBE_REPORT = $ReportPath
    LUCZOR_BROWSER_PROBE_ACTIONS = $ActionsPath
}
$previous = @{}
try {
    foreach ($entry in $variables.GetEnumerator()) {
        $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
    $test = if ($Isolated) { 'native_browser_isolated_acceptance' } else { 'native_browser_panel_smoke' }
    $result = [Collections.Generic.List[string]]::new()
    # Windows PowerShell 5 turns redirected native stderr (including navigation
    # diagnostics) into NativeCommandError. Its presence is not process failure.
    # Only this native invocation continues; exit status + completion marker remain mandatory.
    $nativePreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $probe.executable $test --ignored --test-threads=1 --nocapture 2>&1 | ForEach-Object {
            $line = [string]$_
            $result.Add($line)
            Write-Output $line
        }
        $nativeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $nativePreference
    }
    if ($nativeExitCode -ne 0 -or -not ($result -match 'NATIVE_BROWSER_PROBE_OK:')) { throw 'Native browser probe did not complete successfully.' }
}
finally {
    foreach ($entry in $previous.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
}
