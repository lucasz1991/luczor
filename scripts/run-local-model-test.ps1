#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AssetRoot = 'D:\Luczor\local-model-test',
    [string]$AdminApiRoot = '',
    [ValidateRange(1024, 65535)][int]$LaravelPort = 8765,
    [ValidateRange(1024, 65535)][int]$CdpPort = 9229,
    [ValidateRange(1, 60)][int]$TimeoutMinutes = 30,
    [switch]$ValidateOnly,
    [switch]$Interactive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-CanonicalPath {
    param([string]$Path, [string]$Kind = 'Any')
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    if ($Kind -eq 'Leaf') { Assert-Condition (Test-Path -LiteralPath $resolved.Path -PathType Leaf) "Expected a file: $Path" }
    if ($Kind -eq 'Container') { Assert-Condition (Test-Path -LiteralPath $resolved.Path -PathType Container) "Expected a directory: $Path" }
    return $resolved.Path
}

function Assert-NoReparsePoint {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    Assert-Condition (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Reparse points are not accepted: $Path"
}

function Assert-SafeDirectChildDirectory {
    param([string]$ParentPath, [string]$Path)
    Assert-NoReparsePoint $ParentPath
    Assert-NoReparsePoint $Path
    $canonicalParent = Get-CanonicalPath $ParentPath 'Container'
    $canonicalPath = Get-CanonicalPath $Path 'Container'
    $expectedPath = [IO.Path]::GetFullPath((Join-Path $canonicalParent (Split-Path -Leaf $Path)))
    Assert-Condition ([string]::Equals($canonicalPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) "Directory escaped its expected parent: $Path"
    return $canonicalPath
}

function Assert-PinnedFile {
    param([string]$Path, [Int64]$SizeBytes, [string]$Sha256)
    $canonical = Get-CanonicalPath $Path 'Leaf'
    Assert-NoReparsePoint $canonical
    $file = Get-Item -LiteralPath $canonical
    Assert-Condition ($file.Length -eq $SizeBytes) "Pinned size mismatch: $Path"
    $actual = (Get-FileHash -LiteralPath $canonical -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Condition ($actual -eq $Sha256.ToLowerInvariant()) "Pinned SHA-256 mismatch: $Path"
    return $canonical
}

function Assert-ArchiveExtraction {
    param([string]$ArchivePath, [string]$DestinationPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destination = (Get-CanonicalPath $DestinationPath 'Container').TrimEnd('\') + '\'
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            if (-not $entry.Name) { continue }
            $relative = $entry.FullName.Replace('/', '\')
            Assert-Condition (-not [IO.Path]::IsPathRooted($relative)) "Archive contains an absolute path: $relative"
            $candidate = [IO.Path]::GetFullPath((Join-Path $destination $relative))
            Assert-Condition ($candidate.StartsWith($destination, [StringComparison]::OrdinalIgnoreCase)) "Archive entry escapes its destination: $relative"
            $file = Get-CanonicalPath $candidate 'Leaf'
            Assert-NoReparsePoint $file
            Assert-Condition ((Get-Item -LiteralPath $file).Length -eq $entry.Length) "Extracted runtime size mismatch: $relative"
            $zipStream = $entry.Open()
            $fileStream = [IO.File]::OpenRead($file)
            $zipHasher = [Security.Cryptography.SHA256]::Create()
            $fileHasher = [Security.Cryptography.SHA256]::Create()
            try {
                $zipHash = ([BitConverter]::ToString($zipHasher.ComputeHash($zipStream))).Replace('-', '')
                $fileHash = ([BitConverter]::ToString($fileHasher.ComputeHash($fileStream))).Replace('-', '')
                Assert-Condition ($zipHash -eq $fileHash) "Extracted runtime hash mismatch: $relative"
            } finally {
                $zipHasher.Dispose(); $fileHasher.Dispose(); $zipStream.Dispose(); $fileStream.Dispose()
            }
            $relative.ToLowerInvariant()
        }
    } finally {
        $archive.Dispose()
    }
}

function Assert-PortFree {
    param([int]$Port)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() } catch { throw "Loopback port $Port is unavailable." } finally { $listener.Stop() }
}

function Assert-PortEventuallyFree {
    param([int]$Port, [int]$TimeoutSeconds = 10)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            Assert-PortFree $Port
            return
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 200
        }
    } while ($true)
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Set-PrivateWindowsAcl {
    param([string]$Path, [switch]$Directory)
    Assert-Condition ($env:OS -eq 'Windows_NT') 'The local-model smoke launcher currently supports Windows only.'
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    $suffix = if ($Directory) { ':(OI)(CI)F' } else { ':F' }
    $currentRule = '*' + $current.Value + $suffix
    $systemRule = '*' + $system.Value + $suffix
    & $icacls $Path '/inheritance:r' '/grant:r' $currentRule $systemRule '/Q' | Out-Null
    Assert-Condition ($LASTEXITCODE -eq 0) "ACL restriction failed: $Path"
    $actual = Get-Acl -LiteralPath $Path
    Assert-Condition $actual.AreAccessRulesProtected "ACL inheritance remains enabled: $Path"
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $allowed = @($current.Value, $system.Value)
    Assert-Condition ($rules.Count -eq 2) "Unexpected ACL rule count: $Path"
    foreach ($rule in $rules) {
        $fullControl = ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl
        Assert-Condition (-not $rule.IsInherited -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -contains $rule.IdentityReference.Value -and $fullControl) "Unexpected ACL rule: $Path"
    }
}

function New-RandomBase64 {
    param([int]$Bytes = 32)
    $buffer = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buffer)
}

function Invoke-CapturedProcess {
    param([string]$FilePath, [string]$Arguments)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        Assert-Condition $process.Start() "Process could not start: $FilePath"
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        Assert-Condition ($process.ExitCode -eq 0) "Process failed with exit code $($process.ExitCode): $FilePath"
        return "$stdout`n$stderr"
    } finally {
        $process.Dispose()
    }
}

function Assert-PinnedRuntimeVersion {
    param([string]$RuntimePath, [string]$ExpectedBuild, [string]$ExpectedCommit)
    $runtimeVersion = Invoke-CapturedProcess $RuntimePath '--version'
    Assert-Condition ($runtimeVersion -match "(?im)\bbuild\s+$([regex]::Escape($ExpectedBuild))\b") 'llama.cpp build mismatch.'
    Assert-Condition ($runtimeVersion -match [regex]::Escape($ExpectedCommit)) 'llama.cpp commit mismatch.'
}

function Get-OwnedProcessInstance {
    param([int]$Id, [Int64]$StartTicks)
    $candidate = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if ($null -eq $candidate) { return $null }
    try {
        if ($candidate.StartTime.ToUniversalTime().Ticks -eq $StartTicks) { return $candidate }
    } catch {
        return $null
    }
    return $null
}

function Stop-OwnedProcessTree {
    param([object]$Process, [Int64]$StartTicks)
    if ($null -eq $Process) { return }
    $processId = [int]$Process.Id
    $current = Get-OwnedProcessInstance $processId $StartTicks
    if ($null -eq $current) { return }

    $taskkillExitCode = -1
    $taskkillError = $null
    try {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $processId /T /F 2>&1 | Out-Null
        $taskkillExitCode = $LASTEXITCODE
    } catch {
        $taskkillExitCode = -1
        $taskkillError = $_.Exception.Message
    }

    $current = Get-OwnedProcessInstance $processId $StartTicks
    $fallbackError = $null
    if ($taskkillExitCode -ne 0 -or $null -ne $current) {
        if ($null -ne $current) {
            try { Stop-Process -Id $processId -Force -ErrorAction Stop } catch { $fallbackError = $_.Exception.Message }
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $current = Get-OwnedProcessInstance $processId $StartTicks
        if ($null -eq $current) { return }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds 100
    } while ($true)

    $details = @("taskkill exit code $taskkillExitCode")
    if ($taskkillError) { $details += "taskkill error: $taskkillError" }
    if ($fallbackError) { $details += "fallback error: $fallbackError" }
    throw "Owned process PID $processId with the recorded start time survived cleanup ($($details -join '; '))."
}

function Assert-NoLlamaServerProcess {
    $matchingPids = @(
        Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" -ErrorAction Stop |
            ForEach-Object { [int]$_.ProcessId }
    )
    Assert-Condition ($matchingPids.Count -eq 0) "A llama-server process is already active; no process was stopped (PID: $($matchingPids -join ', '))."
}

function Enter-RuntimeOwnerLock {
    param(
        [string]$LockPath,
        [string]$Owner,
        [string]$CommandLineMarker,
        [string]$RuntimeSha256,
        [string]$ModelSha256
    )
    $parentPath = Split-Path -Parent $LockPath
    Assert-NoReparsePoint $parentPath
    if (Test-Path -LiteralPath $LockPath) {
        Assert-Condition (Test-Path -LiteralPath $LockPath -PathType Leaf) "Runtime-owner lock is not a file: $LockPath"
        Assert-NoReparsePoint $LockPath
    }

    $stream = $null
    try {
        $stream = [IO.FileStream]::new(
            $LockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    } catch {
        throw "Another local-model starter holds the runtime-owner lock: $LockPath"
    }

    try {
        Assert-NoReparsePoint $LockPath
        $self = Get-Process -Id $PID -ErrorAction Stop
        $record = [ordered]@{
            schemaVersion = 1
            owner = $Owner
            pid = $PID
            processStartUtcTicks = $self.StartTime.ToUniversalTime().Ticks
            commandLineMarker = $CommandLineMarker
            runtimeSha256 = $RuntimeSha256.ToLowerInvariant()
            modelSha256 = $ModelSha256.ToLowerInvariant()
        }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress))
        $stream.SetLength(0)
        $stream.Position = 0
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        return $stream
    } catch {
        if ($null -ne $stream) { $stream.Dispose() }
        throw
    }
}

function Invoke-CleanupStep {
    param(
        [string]$Name,
        [scriptblock]$Action,
        [System.Collections.Generic.List[string]]$Errors
    )
    try {
        & $Action
    } catch {
        [void]$Errors.Add("${Name}: $($_.Exception.Message)")
    }
}

function Wait-LoopbackHealth {
    param([string]$Url, [object]$Process)
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) { throw 'The isolated Laravel server exited before becoming healthy.' }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    throw 'The isolated Laravel server did not become healthy on loopback.'
}

$appRoot = Get-CanonicalPath (Join-Path $PSScriptRoot '..') 'Container'
if (-not $AdminApiRoot) { $AdminApiRoot = Join-Path (Split-Path -Parent $appRoot) 'admin_api_app' }
$adminRoot = Get-CanonicalPath $AdminApiRoot 'Container'
$assetRootCanonical = Get-CanonicalPath $AssetRoot 'Container'
Assert-NoReparsePoint $assetRootCanonical
Assert-Condition ((Split-Path -Qualifier $assetRootCanonical) -ne (Split-Path -Qualifier $appRoot)) 'Assets must be outside the app checkout volume.'
Assert-Condition ((Split-Path -Qualifier $assetRootCanonical) -ne (Split-Path -Qualifier $adminRoot)) 'Assets must be outside the Laravel checkout volume.'

$profilePath = Get-CanonicalPath (Join-Path $PSScriptRoot 'local-model-test.profile.json') 'Leaf'
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
Assert-Condition ($profile.schemaVersion -eq 1) 'Unsupported local-model test profile.'
Assert-Condition ($profile.profileId -eq 'orcarouter-qwen3.8-27b-windows-cuda-smoke') 'Unexpected local-model test profile.'
Assert-Condition ($LaravelPort -ne $CdpPort -and $LaravelPort -ne 1420 -and $CdpPort -ne 1420) 'Laravel, CDP and Vite ports must be distinct.'

$node = Assert-PinnedFile $profile.node.executable ([Int64]$profile.node.sizeBytes) $profile.node.sha256
$pnpmCli = Assert-PinnedFile $profile.node.pnpmCli ([Int64]$profile.node.pnpmSizeBytes) $profile.node.pnpmSha256
Assert-Condition ((& $node --version).Trim() -eq $profile.node.version) 'Pinned Node version mismatch.'
Assert-Condition ((& $node $pnpmCli --version).Trim() -eq $profile.node.pnpmVersion) 'Pinned pnpm version mismatch.'

$modelPath = Assert-PinnedFile (Join-Path $assetRootCanonical $profile.assets.model.relativePath) ([Int64]$profile.assets.model.sizeBytes) $profile.assets.model.sha256
$runtimePath = Assert-PinnedFile (Join-Path $assetRootCanonical $profile.assets.runtime.relativePath) 9216 $profile.assets.runtime.sha256
$runtimeRoot = Split-Path -Parent $runtimePath
$expectedRuntimeFiles = @()
foreach ($archive in $profile.assets.archives) {
    $archivePath = Assert-PinnedFile (Join-Path $assetRootCanonical $archive.relativePath) ([Int64]$archive.sizeBytes) $archive.sha256
    $expectedRuntimeFiles += @(Assert-ArchiveExtraction $archivePath $runtimeRoot)
}
$actualRuntimeFiles = @(Get-ChildItem -LiteralPath $runtimeRoot -File | ForEach-Object { $_.Name.ToLowerInvariant() })
$runtimeDifference = @(Compare-Object ($expectedRuntimeFiles | Sort-Object -Unique) ($actualRuntimeFiles | Sort-Object -Unique))
Assert-Condition ($runtimeDifference.Count -eq 0) 'The runtime directory differs from the pinned official archives.'
$reportPath = Assert-PinnedFile (Join-Path $appRoot $profile.assets.evaluationReport.relativePath) (Get-Item -LiteralPath (Join-Path $appRoot $profile.assets.evaluationReport.relativePath)).Length $profile.assets.evaluationReport.sha256
$runtimeBuild = ([string]$profile.assets.runtime.version).TrimStart('b')
$runtimeOwnerLockPath = Join-Path $assetRootCanonical 'runtime-owner.lock'

$privateKey = Get-CanonicalPath (Join-Path $assetRootCanonical $profile.signing.privateKeyRelativePath) 'Leaf'
$publicKey = Get-CanonicalPath (Join-Path $assetRootCanonical $profile.signing.publicKeyRelativePath) 'Leaf'
Assert-NoReparsePoint $privateKey
Assert-NoReparsePoint $publicKey
$phpCommand = Get-Command php.exe -ErrorAction Stop
$php = Get-CanonicalPath $phpCommand.Source 'Leaf'
$phpModules = (& $php -m | Out-String)
Assert-Condition ($phpModules -match '(?im)^openssl\s*$') 'PHP openssl is required.'
Assert-Condition ($phpModules -match '(?im)^pdo_sqlite\s*$') 'PHP pdo_sqlite is required.'
$keyInspectionCode = '$k=openssl_pkey_get_private(file_get_contents($argv[1]));if(!$k){exit(2);}$d=openssl_pkey_get_details($k);if(!is_array($d)||$d[''type'']!==OPENSSL_KEYTYPE_RSA||$d[''bits'']<2048){exit(3);}echo $d[''key''];'
$derivedPublic = (& $php -r $keyInspectionCode $privateKey | Out-String)
Assert-Condition ($LASTEXITCODE -eq 0 -and $derivedPublic.Trim()) 'The external RSA private key is invalid or unsafe.'
$configuredPublic = Get-Content -LiteralPath $publicKey -Raw
$canonicalDerivedPublic = $derivedPublic.Replace("`r`n", "`n").Replace("`r", "`n").Trim() + "`n"
$canonicalConfiguredPublic = $configuredPublic.Replace("`r`n", "`n").Replace("`r", "`n").Trim() + "`n"
Assert-Condition ($canonicalDerivedPublic -eq $canonicalConfiguredPublic) 'The external RSA public/private key pair does not match.'
# PHP/OpenSSL fingerprints the canonical LF PEM returned by
# openssl_pkey_get_details(). PowerShell otherwise reintroduces CRLF while
# capturing stdout and would pin a different byte sequence on Windows.
$publicBytes = [Text.Encoding]::UTF8.GetBytes($canonicalDerivedPublic)
$publicB64 = [Convert]::ToBase64String($publicBytes)
$sha = [Security.Cryptography.SHA256]::Create()
try { $publicFingerprint = ([BitConverter]::ToString($sha.ComputeHash($publicBytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }

if ($ValidateOnly) {
    $validationRuntimeLock = $null
    $validationFailure = $null
    $validationIsolationEntered = $false
    $validationCleanupFailures = [System.Collections.Generic.List[string]]::new()
    try {
        $validationRuntimeLock = Enter-RuntimeOwnerLock $runtimeOwnerLockPath 'luczor-e2e' 'run-local-model-test.ps1' $profile.assets.runtime.sha256 $profile.assets.model.sha256
        Assert-NoLlamaServerProcess
        $validationIsolationEntered = $true
        Assert-PinnedRuntimeVersion $runtimePath $runtimeBuild $profile.assets.runtime.commit
    } catch {
        $validationFailure = $_
    } finally {
        if ($validationIsolationEntered) {
            Invoke-CleanupStep 'verify no llama-server process remains after validation' { Assert-NoLlamaServerProcess } $validationCleanupFailures
        }
        Invoke-CleanupStep 'release runtime-owner lock after validation' {
            if ($null -ne $validationRuntimeLock) { $validationRuntimeLock.Dispose() }
        } $validationCleanupFailures
    }
    if ($null -ne $validationFailure) {
        if ($validationCleanupFailures.Count -gt 0) {
            $message = "Validation failure: $($validationFailure.Exception.Message)`nCleanup failure(s):`n- $($validationCleanupFailures -join "`n- ")"
            throw [InvalidOperationException]::new($message, $validationFailure.Exception)
        }
        throw $validationFailure
    }
    if ($validationCleanupFailures.Count -gt 0) {
        throw "Validation cleanup failure(s):`n- $($validationCleanupFailures -join "`n- ")"
    }
    Write-Host 'Local-model assets, pinned toolchain, runtime and test signing key validated.'
    exit 0
}

Assert-PortFree $LaravelPort
Assert-PortFree $CdpPort
Assert-PortFree 1420

$runsRoot = Join-Path $assetRootCanonical 'runs'
$reportsRoot = Join-Path $assetRootCanonical 'reports'
[void](New-Item -ItemType Directory -Path $runsRoot -Force)
[void](New-Item -ItemType Directory -Path $reportsRoot -Force)
Assert-NoReparsePoint $runsRoot
Assert-NoReparsePoint $reportsRoot
Set-PrivateWindowsAcl $runsRoot -Directory
Set-PrivateWindowsAcl $reportsRoot -Directory
$runsRoot = Assert-SafeDirectChildDirectory $assetRootCanonical $runsRoot
$reportsRoot = Assert-SafeDirectChildDirectory $assetRootCanonical $reportsRoot
$runId = '{0}-{1}' -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
$runsRoot = Assert-SafeDirectChildDirectory $assetRootCanonical $runsRoot
$runRoot = Join-Path $runsRoot $runId
[void](New-Item -ItemType Directory -Path $runRoot)
Assert-NoReparsePoint $runRoot
Set-PrivateWindowsAcl $runRoot -Directory
$runRoot = Assert-SafeDirectChildDirectory $runsRoot $runRoot
$testRoot = Join-Path $runRoot 'control-plane'
[void](New-Item -ItemType Directory -Path $testRoot)
$testRoot = Assert-SafeDirectChildDirectory $runRoot $testRoot
$storageRoot = Join-Path $runRoot 'laravel-storage'
foreach ($relative in @('app', 'framework\cache\data', 'framework\sessions', 'framework\views', 'logs', 'bootstrap-cache')) {
    [void](New-Item -ItemType Directory -Path (Join-Path $storageRoot $relative) -Force)
}
$storageRoot = Assert-SafeDirectChildDirectory $runRoot $storageRoot
$databasePath = Join-Path $testRoot 'control-plane.sqlite'
$tokenPath = Join-Path $testRoot 'device-token.secret'
$laravelEnvironmentName = 'local'
$laravelEnvPath = Join-Path $adminRoot ".env.$laravelEnvironmentName"
$reportsRoot = Assert-SafeDirectChildDirectory $assetRootCanonical $reportsRoot
$resultPath = Join-Path $reportsRoot ("local-model-e2e-$runId.json")
$configCachePath = Join-Path $runRoot 'laravel-config.php'
$servicesCachePath = Join-Path $storageRoot 'bootstrap-cache\services.php'
$packagesCachePath = Join-Path $storageRoot 'bootstrap-cache\packages.php'
$eventsCachePath = Join-Path $storageRoot 'bootstrap-cache\events.php'
$routesCachePath = Join-Path $storageRoot 'bootstrap-cache\routes.php'
Assert-Condition (-not (Test-Path -LiteralPath $laravelEnvPath)) 'Refusing to replace an existing Laravel .env.local file.'
Assert-Condition (-not (Test-Path -LiteralPath $databasePath)) 'Refusing to replace an existing isolated database file.'
Assert-Condition (-not (Test-Path -LiteralPath $resultPath)) 'Refusing to replace an existing smoke report.'
foreach ($cachePath in @($configCachePath, $servicesCachePath, $packagesCachePath, $eventsCachePath, $routesCachePath)) {
    Assert-Condition (-not (Test-Path -LiteralPath $cachePath)) "Refusing to reuse a Laravel cache path: $cachePath"
}
[IO.File]::WriteAllBytes($databasePath, [byte[]]@())
Assert-NoReparsePoint $databasePath

# Manifest versions cross the JSON/JavaScript boundary and must stay within
# Number.MAX_SAFE_INTEGER. Unix milliseconds are monotonic enough for an
# isolated run and remain exactly representable in the desktop client.
$version = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$disabledCapacity = [ordered]@{ min_total_ram_bytes=$null; min_available_ram_bytes=$null; min_vram_bytes=$null; min_storage_free_bytes=$null; max_startup_seconds=$null; benchmark_thresholds=$null }
$catalog = [ordered]@{
    models = @(
        [ordered]@{ id='qwen3.8-flash-next'; display_name='Qwen3.8 Flash-Next'; execution_target='local_llama_cpp'; release_channel='experimental'; routing_role='preferred'; promoted=$false; enabled=$false; capabilities=@('chat','reasoning','planning','execution_preparation'); context_limit=$null; artifact=$null; runtime=$null; capacity_policy=$disabledCapacity; health_policy=[ordered]@{ cooldown_ms=300000; max_consecutive_failures=2 }; chat_template_hash=$null; evaluation_report_hash=$null; license=$null },
        [ordered]@{ id=$profile.assets.model.id; display_name='OrcaRouter Qwen3.8-27B Uncensored Q4_K_M'; execution_target='local_llama_cpp'; release_channel='stable'; routing_role='fallback'; promoted=$true; enabled=$true; capabilities=@('chat','reasoning','planning','execution_preparation'); context_limit=[int]$profile.catalog.contextTokens; artifact=[ordered]@{ url=$profile.assets.model.sourceUrl; sha256=$profile.assets.model.sha256; size_bytes=[Int64]$profile.assets.model.sizeBytes; format='gguf'; quantization='Q4_K_M'; storage_class='fixed_storage' }; runtime=[ordered]@{ id='llama.cpp'; version=$profile.assets.runtime.version; sha256=$profile.assets.runtime.sha256; min_context_tokens=1024; max_context_tokens=262144 }; capacity_policy=[ordered]@{ min_total_ram_bytes=[Int64]$profile.catalog.minTotalRamBytes; min_available_ram_bytes=[Int64]$profile.catalog.minAvailableRamBytes; min_vram_bytes=[Int64]$profile.catalog.minVramBytes; min_storage_free_bytes=[Int64]$profile.catalog.minStorageFreeBytes; max_startup_seconds=[int]$profile.catalog.maxStartupSeconds; benchmark_thresholds=[ordered]@{ min_prefill_tokens_per_second=[int]$profile.catalog.minPrefillTokensPerSecond; min_decode_tokens_per_second=[int]$profile.catalog.minDecodeTokensPerSecond; max_first_token_ms=[int]$profile.catalog.maxFirstTokenMs } }; health_policy=[ordered]@{ cooldown_ms=[int]$profile.catalog.cooldownMs; max_consecutive_failures=[int]$profile.catalog.maxConsecutiveFailures }; chat_template_hash=$profile.assets.model.chatTemplateSha256; evaluation_report_hash=$profile.assets.evaluationReport.sha256; license='Apache-2.0' }
    )
    routing = [ordered]@{ strategy='local_first'; local_first=$true; preferred_model_id='qwen3.8-flash-next'; default_model_id=$profile.assets.model.id; fallback_model_ids=@($profile.assets.model.id); experimental_model_ids=@('qwen3.8-flash-next'); experimental_opt_in_required=$true; external_execution_target='laravel_proxy'; external_allowed=$false; external_requires_explicit_approval=$true; no_silent_external_fallback=$true; required_local_state=@('model_enabled','artifact_verified','runtime_verified','capacity_qualified','health_eligible'); decision_reasons=@('local_preferred','local_fallback_capacity','local_fallback_health','local_unavailable','external_approval_required','external_policy_rejected'); egress_policy_version='local-model-smoke-1' }
}
$catalogJson = $catalog | ConvertTo-Json -Depth 20 -Compress
Assert-Condition (-not $catalogJson.Contains("'")) 'Catalog JSON cannot be represented safely in the isolated dotenv file.'

$slashDatabase = $databasePath.Replace('\','/')
$slashStorage = $storageRoot.Replace('\','/')
$slashPrivate = $privateKey.Replace('\','/')
$slashConfigCache = $configCachePath.Replace('\','/')
$slashServicesCache = $servicesCachePath.Replace('\','/')
$slashPackagesCache = $packagesCachePath.Replace('\','/')
$slashEventsCache = $eventsCachePath.Replace('\','/')
$slashRoutesCache = $routesCachePath.Replace('\','/')
$appKey = "base64:$(New-RandomBase64 32)"
$memoryNamespaceKey = New-RandomBase64 32
$memoryLedgerKey = New-RandomBase64 32

# Every value that could redirect an isolated Laravel process to repository,
# production, network or inherited process state is either pinned here or
# explicitly removed. The same collection drives save, apply and restore.
$laravelIsolationEnv = [ordered]@{
    APP_NAME = 'Luczor Local Model Test Control Plane'
    APP_ENV = 'local'
    APP_DEBUG = 'false'
    APP_URL = "http://127.0.0.1:$LaravelPort"
    APP_KEY = $appKey
    APP_BASE_PATH = $null
    APP_CONFIG_CACHE = $slashConfigCache
    APP_SERVICES_CACHE = $slashServicesCache
    APP_PACKAGES_CACHE = $slashPackagesCache
    APP_EVENTS_CACHE = $slashEventsCache
    APP_ROUTES_CACHE = $slashRoutesCache
    LARAVEL_STORAGE_PATH = $slashStorage
    VIEW_COMPILED_PATH = "$slashStorage/framework/views"
    LOG_CHANNEL = 'single'
    LOG_LEVEL = 'warning'
    LOG_DEPRECATIONS_CHANNEL = 'null'
    LOG_SLACK_WEBHOOK_URL = $null
    PAPERTRAIL_URL = $null
    PAPERTRAIL_PORT = $null
    DATABASE_URL = $null
    DB_URL = $null
    DB_CONNECTION = 'sqlite'
    DB_DATABASE = $slashDatabase
    DB_FOREIGN_KEYS = 'true'
    DB_HOST = $null
    DB_PORT = $null
    DB_USERNAME = $null
    DB_PASSWORD = $null
    DB_SOCKET = $null
    MYSQL_ATTR_SSL_CA = $null
    LEGACY_MYSQL_HOST = $null
    LEGACY_MYSQL_PORT = $null
    LEGACY_MYSQL_DATABASE = $null
    LEGACY_MYSQL_USERNAME = $null
    LEGACY_MYSQL_PASSWORD = $null
    LEGACY_MYSQL_ATTR_SSL_CA = $null
    CACHE_DRIVER = 'array'
    CACHE_PREFIX = "luczor_local_model_$runId"
    MEMCACHED_PERSISTENT_ID = $null
    MEMCACHED_USERNAME = $null
    MEMCACHED_PASSWORD = $null
    MEMCACHED_HOST = $null
    DYNAMODB_CACHE_TABLE = $null
    DYNAMODB_ENDPOINT = $null
    SESSION_DRIVER = 'array'
    SESSION_CONNECTION = $null
    SESSION_STORE = $null
    SESSION_DOMAIN = $null
    SESSION_SECURE_COOKIE = 'false'
    QUEUE_CONNECTION = 'sync'
    QUEUE_FAILED_DRIVER = 'null'
    BROADCAST_DRIVER = 'null'
    REVERB_APP_KEY = $null
    REVERB_APP_SECRET = $null
    REVERB_APP_ID = $null
    REVERB_HOST = $null
    PUSHER_APP_KEY = $null
    PUSHER_APP_SECRET = $null
    PUSHER_APP_ID = $null
    PUSHER_APP_CLUSTER = $null
    ABLY_KEY = $null
    MAIL_MAILER = 'array'
    MAIL_URL = $null
    MAIL_HOST = $null
    MAIL_PORT = $null
    MAIL_USERNAME = $null
    MAIL_PASSWORD = $null
    MAILGUN_DOMAIN = $null
    MAILGUN_SECRET = $null
    POSTMARK_TOKEN = $null
    FILESYSTEM_DISK = 'local'
    AWS_ACCESS_KEY_ID = $null
    AWS_SECRET_ACCESS_KEY = $null
    AWS_DEFAULT_REGION = $null
    AWS_BUCKET = $null
    AWS_URL = $null
    AWS_ENDPOINT = $null
    SQS_PREFIX = $null
    SQS_QUEUE = $null
    SQS_SUFFIX = $null
    GITHUB_CLIENT_ID = $null
    GITHUB_CLIENT_SECRET = $null
    GITHUB_REDIRECT_URI = $null
    GITHUB_WEBHOOK_SECRET = $null
    REDIS_URL = $null
    REDIS_HOST = $null
    REDIS_USERNAME = $null
    REDIS_PASSWORD = $null
    REDIS_PASSWORD_FILE = $null
    REDIS_PORT = $null
    PHP_CLI_SERVER_WORKERS = $null
    CORS_ALLOWED_ORIGINS = "http://127.0.0.1:1420,http://localhost:1420"
    CORS_ALLOWED_ORIGIN_PATTERNS = $null
    SANCTUM_STATEFUL_DOMAINS = '127.0.0.1:1420,localhost:1420'
    LUCZOR_MEMORY_NAMESPACE_KEY = $memoryNamespaceKey
    LUCZOR_MEMORY_LEDGER_KEY = $memoryLedgerKey
    LUCZOR_MEMORY_PREVIOUS_NAMESPACE_KEYS = $null
    LUCZOR_ALLOW_REGISTRATION = 'false'
    LUCZOR_JOB_PRIVATE_KEY = $null
    LUCZOR_JOB_PRIVATE_KEY_FILE = $null
    LUCZOR_VOICE_MANIFEST_JSON = '{}'
    LUCZOR_VOICE_MANIFEST_FILE = $null
    COGNEE_ENABLED = 'false'
    COGNEE_BASE_URL = $null
    COGNEE_API_KEY = $null
    COGNEE_API_KEY_FILE = $null
    COGNEE_IMPROVE_ENABLED = 'false'
    LUCZOR_LOCAL_MODEL_SIGNING_KEY_ID = [string]$profile.signing.keyId
    LUCZOR_LOCAL_MODEL_SIGNING_PRIVATE_KEY_FILE = $slashPrivate
    LUCZOR_LOCAL_MODEL_EXPECTED_PUBLIC_KEY_SHA256 = $publicFingerprint
    LUCZOR_LOCAL_MODEL_CATALOG_VERSION = [string]$version
    LUCZOR_LOCAL_MODEL_POLICY_VERSION = [string]$version
    LUCZOR_LOCAL_MODEL_MANIFEST_TTL_SECONDS = '28800'
    LUCZOR_LOCAL_MODEL_CATALOG_JSON = $catalogJson
}
$laravelEnvLines = @(
    foreach ($entry in $laravelIsolationEnv.GetEnumerator()) {
        $dotenvValue = $entry.Value
        if ($null -eq $dotenvValue) {
            "$($entry.Key)="
            continue
        }
        $dotenvText = [string]$dotenvValue
        Assert-Condition (-not ($dotenvText.Contains("'") -or $dotenvText.Contains("`r") -or $dotenvText.Contains("`n"))) "Unsafe isolated dotenv value: $($entry.Key)"
        "$($entry.Key)='$dotenvText'"
    }
)
$laravelEnv = $laravelEnvLines -join "`n"
# The test trust anchor is passed only in the Tauri process environment below.
# build.rs prefers these explicit values over .env.local-model, so the normal
# desktop's production defaults are neither read, rejected nor overwritten here.
$desktopEnvNames = @('LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64','LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID','LUCZOR_LLAMA_CPP_BIN','LUCZOR_LOCAL_MODEL_DIR','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','PATH')
$envNames = @(@($laravelIsolationEnv.Keys) + $desktopEnvNames | Select-Object -Unique)
$savedEnv = @{}
foreach ($name in $envNames) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$laravelConfigurationInspection = @'
function fail_isolation(string $message): void
{
    fwrite(STDERR, $message.PHP_EOL);
    exit(70);
}

function canonical_path(string $path): string
{
    $resolved = realpath($path);
    if ($resolved === false) {
        $parent = realpath(dirname($path));
        if ($parent === false) {
            fail_isolation('An isolated path cannot be canonicalized.');
        }
        $resolved = $parent.DIRECTORY_SEPARATOR.basename($path);
    }

    $normalized = str_replace('\\', '/', $resolved);
    if (str_starts_with(strtolower($normalized), '//?/unc/')) {
        $normalized = '//'.substr($normalized, 8);
    } elseif (str_starts_with($normalized, '//?/')) {
        $normalized = substr($normalized, 4);
    }

    return strtolower(rtrim($normalized, '/'));
}

$root = $argv[1];
if (! chdir($root)) {
    fail_isolation('The Laravel root is unavailable.');
}
require $root.'/vendor/autoload.php';
$app = require $root.'/bootstrap/app.php';
$app->loadEnvironmentFrom('.env.local');
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();
$config = $app->make('config');

$expected = [
    'app.env' => 'local',
    'app.debug' => false,
    'app.url' => $argv[9],
    'database.default' => 'sqlite',
    'database.connections.sqlite.driver' => 'sqlite',
    'database.connections.sqlite.foreign_key_constraints' => true,
    'cache.default' => 'array',
    'session.driver' => 'array',
    'queue.default' => 'sync',
    'mail.default' => 'array',
    'filesystems.default' => 'local',
    'logging.default' => 'single',
    'luczor.allow_registration' => false,
    'luczor.cognee.base_url' => '',
    'luczor.cognee.api_key' => '',
    'luczor.cognee.api_key_file' => '',
    'luczor.cognee.improve_enabled' => false,
];
foreach ($expected as $key => $value) {
    if ($config->get($key) !== $value) {
        fail_isolation('Unexpected isolated config value: '.$key);
    }
}
$broadcastDriver = $config->get('broadcasting.default');
if ($broadcastDriver !== null && $broadcastDriver !== 'null') {
    fail_isolation('Broadcasting escaped the null driver.');
}

$databaseUrl = $config->get('database.connections.sqlite.url');
if ($databaseUrl !== null && trim((string) $databaseUrl) !== '') {
    fail_isolation('The SQLite URL must be empty.');
}
foreach (['DATABASE_URL', 'DB_URL'] as $name) {
    $value = getenv($name);
    if ($value !== false && trim((string) $value) !== '') {
        fail_isolation($name.' must be absent or empty.');
    }
}

$paths = [
    [$app->basePath(), $argv[1], 'Laravel base path'],
    [$config->get('database.connections.sqlite.database'), $argv[2], 'SQLite database'],
    [$app->storagePath(), $argv[3], 'Laravel storage'],
    [$config->get('view.compiled'), $argv[3].'/framework/views', 'compiled views'],
    [$app->getCachedConfigPath(), $argv[4], 'config cache'],
    [$app->getCachedServicesPath(), $argv[5], 'services cache'],
    [$app->getCachedPackagesPath(), $argv[6], 'packages cache'],
    [$app->getCachedEventsPath(), $argv[7], 'events cache'],
    [$app->getCachedRoutesPath(), $argv[8], 'routes cache'],
];
foreach ($paths as [$actual, $wanted, $label]) {
    if (! is_string($actual) || canonical_path($actual) !== canonical_path($wanted)) {
        fail_isolation($label.' escaped the isolated run root.');
    }
}

echo 'LUCZOR_ISOLATED_CONFIG_OK';
'@
$laravelProcess = $null; $tauriProcess = $null; $runtimeOwnerLock = $null; $laravelTicks = 0; $tauriTicks = 0
$primaryFailure = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$smokePassed = $false
$runIsolationEntered = $false
try {
    $runtimeOwnerLock = Enter-RuntimeOwnerLock $runtimeOwnerLockPath 'luczor-e2e' 'run-local-model-test.ps1' $profile.assets.runtime.sha256 $profile.assets.model.sha256
    Assert-NoLlamaServerProcess
    $runIsolationEntered = $true
    Assert-PinnedRuntimeVersion $runtimePath $runtimeBuild $profile.assets.runtime.commit
    Write-Utf8NoBom $laravelEnvPath ($laravelEnv + "`n")
    Set-PrivateWindowsAcl $laravelEnvPath
    foreach ($entry in $laravelIsolationEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, 'Process')
    }
    Push-Location $adminRoot
    try {
        $inspectionOutput = (& $php -r $laravelConfigurationInspection $adminRoot $databasePath $storageRoot $configCachePath $servicesCachePath $packagesCachePath $eventsCachePath $routesCachePath "http://127.0.0.1:$LaravelPort" | Out-String).Trim()
        Assert-Condition ($LASTEXITCODE -eq 0 -and $inspectionOutput -eq 'LUCZOR_ISOLATED_CONFIG_OK') 'Effective Laravel configuration failed the isolation gate.'
        & $php artisan migrate --force --no-interaction --env=$laravelEnvironmentName
        Assert-Condition ($LASTEXITCODE -eq 0) 'Isolated SQLite migration failed.'
        & $php artisan luczor:local-model-test:bootstrap --test-root=$testRoot --database-file=$databasePath --token-file=$tokenPath --env=$laravelEnvironmentName
        Assert-Condition ($LASTEXITCODE -eq 0) 'Isolated device-key bootstrap failed.'
    } finally { Pop-Location }

    $laravelProcess = Start-Process -FilePath $php -ArgumentList @('artisan','serve',"--host=127.0.0.1","--port=$LaravelPort",'--no-reload',"--env=$laravelEnvironmentName") -WorkingDirectory $adminRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'laravel.stdout.log') -RedirectStandardError (Join-Path $runRoot 'laravel.stderr.log') -PassThru
    $laravelTicks = $laravelProcess.StartTime.ToUniversalTime().Ticks
    Wait-LoopbackHealth "http://127.0.0.1:$LaravelPort/api/v1/health" $laravelProcess

    # The already-started Laravel process retains its isolated environment.
    # Do not pass its signing key, APP_KEY or database settings into Tauri/Vite.
    foreach ($name in $laravelIsolationEnv.Keys) {
        [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    $env:LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64=$publicB64; $env:LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID=$profile.signing.keyId; $env:LUCZOR_LLAMA_CPP_BIN=$runtimePath; $env:LUCZOR_LOCAL_MODEL_DIR=Split-Path -Parent $modelPath; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$CdpPort"; $env:PATH="$(Split-Path -Parent $node);$env:PATH"
    $tauriArgs = '"{0}" exec tauri dev --config src-tauri/tauri.local-test.conf.json' -f $pnpmCli
    $tauriProcess = Start-Process -FilePath $node -ArgumentList $tauriArgs -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'tauri.stdout.log') -RedirectStandardError (Join-Path $runRoot 'tauri.stderr.log') -PassThru
    $tauriTicks = $tauriProcess.StartTime.ToUniversalTime().Ticks

    $reportsRoot = Assert-SafeDirectChildDirectory $assetRootCanonical $reportsRoot
    Assert-Condition ([string]::Equals((Split-Path -Parent $resultPath), $reportsRoot, [StringComparison]::OrdinalIgnoreCase)) 'The smoke report path escaped the verified reports directory.'
    Assert-Condition (-not (Test-Path -LiteralPath $resultPath)) 'Refusing to replace an existing smoke report.'
    $smokeArguments = @(
        (Join-Path $appRoot 'scripts\local-model-e2e-smoke.mjs'),
        '--port', [string]$CdpPort,
        '--base-url', "http://127.0.0.1:$LaravelPort",
        '--device-key-file', $tokenPath,
        '--output', $resultPath,
        '--timeout-ms', [string]($TimeoutMinutes * 60000)
    )
    if ($Interactive) { $smokeArguments += '--interactive' }
    & $node @smokeArguments
    Assert-Condition ($LASTEXITCODE -eq 0) 'Local-model end-to-end smoke failed.'
    $smokePassed = $true
} catch {
    $primaryFailure = $_
} finally {
    Invoke-CleanupStep 'stop Tauri process tree' { Stop-OwnedProcessTree $tauriProcess $tauriTicks } $cleanupFailures
    Invoke-CleanupStep 'stop Laravel process tree' { Stop-OwnedProcessTree $laravelProcess $laravelTicks } $cleanupFailures

    foreach ($secretPath in @($tokenPath, $laravelEnvPath, $configCachePath)) {
        $cleanupPath = $secretPath
        Invoke-CleanupStep "remove secret file $cleanupPath" {
            if (Test-Path -LiteralPath $cleanupPath) { Remove-Item -LiteralPath $cleanupPath -Force }
            Assert-Condition (-not (Test-Path -LiteralPath $cleanupPath)) "Secret file remains after cleanup: $cleanupPath"
        } $cleanupFailures
    }

    foreach ($name in $envNames) {
        $restoreName = [string]$name
        $restoreValue = $savedEnv[$restoreName]
        Invoke-CleanupStep "restore process environment $restoreName" {
            [Environment]::SetEnvironmentVariable($restoreName, $restoreValue, 'Process')
            $restoredValue = [Environment]::GetEnvironmentVariable($restoreName, 'Process')
            if ($null -eq $restoreValue) {
                Assert-Condition ($null -eq $restoredValue) "Process environment remains set: $restoreName"
            } else {
                Assert-Condition ([string]::Equals($restoredValue, [string]$restoreValue, [StringComparison]::Ordinal)) "Process environment was not restored exactly: $restoreName"
            }
        } $cleanupFailures
    }

    if ($runIsolationEntered) {
        Invoke-CleanupStep "release loopback port $LaravelPort" { Assert-PortEventuallyFree $LaravelPort } $cleanupFailures
        Invoke-CleanupStep "release loopback port $CdpPort" { Assert-PortEventuallyFree $CdpPort } $cleanupFailures
        Invoke-CleanupStep 'release loopback port 1420' { Assert-PortEventuallyFree 1420 } $cleanupFailures
    }
    if ($runIsolationEntered) {
        Invoke-CleanupStep 'verify no llama-server process remains' { Assert-NoLlamaServerProcess } $cleanupFailures
    }
    Invoke-CleanupStep 'release runtime-owner lock' {
        if ($null -ne $runtimeOwnerLock) {
            $runtimeOwnerLock.Dispose()
            $runtimeOwnerLock = $null
        }
    } $cleanupFailures
}

if ($null -ne $primaryFailure) {
    if ($cleanupFailures.Count -gt 0) {
        $message = "Primary failure: $($primaryFailure.Exception.Message)`nCleanup failure(s):`n- $($cleanupFailures -join "`n- ")"
        throw [InvalidOperationException]::new($message, $primaryFailure.Exception)
    }
    throw $primaryFailure
}
if ($cleanupFailures.Count -gt 0) {
    throw "Cleanup failure(s):`n- $($cleanupFailures -join "`n- ")"
}
if ($smokePassed) {
    Write-Host "Local-model end-to-end smoke passed. Report: $resultPath"
}
