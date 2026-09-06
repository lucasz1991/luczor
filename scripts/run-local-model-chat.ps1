#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AssetRoot = 'D:\Luczor\local-model-test',
    [ValidateRange(1024, 65535)][int]$Port = 8089,
    [switch]$ValidateOnly,
    [switch]$NoBrowser,
    [switch]$CopyAccessKey,
    [switch]$SmokeOnly
)

# Independent, authenticated llama.cpp WebUI. No Laravel, tools or external provider.
# Start: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-local-model-chat.ps1 -CopyAccessKey
# Paste the copied key into the WebUI API-key field; Enter in this terminal stops the server.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-DirectChat {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-SafePath {
    param([string]$Path)
    $full = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $full -Force
    while ($null -ne $item) {
        Assert-DirectChat (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Reparse path is not accepted: $full"
        $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
    }
    return $full
}

function Set-DirectChatPrivateAcl {
    param([string]$Path, [switch]$Directory)
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $sids = @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))
    foreach ($sid in $sids) {
        $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    $actual = Get-Acl -LiteralPath $Path
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    Assert-DirectChat ($actual.AreAccessRulesProtected -and $rules.Count -eq 2) 'Private test-directory ACL verification failed.'
    foreach ($rule in $rules) {
        Assert-DirectChat ((@($sids.Value) -contains $rule.IdentityReference.Value) -and -not $rule.IsInherited -and $rule.AccessControlType -eq 'Allow' -and $rule.FileSystemRights -eq 'FullControl') 'Unexpected private-directory ACL.'
    }
}

function Open-PinnedFile {
    param([string]$Path, [long]$ExpectedSize, [string]$ExpectedHash)
    $safe = Get-SafePath $Path
    $stream = [IO.File]::Open($safe, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        if ($ExpectedSize -ge 0) { Assert-DirectChat ($stream.Length -eq $ExpectedSize) "Pinned size mismatch: $safe" }
        $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        Assert-DirectChat ($hash -eq $ExpectedHash.ToLowerInvariant()) "Pinned SHA-256 mismatch: $safe"
        $stream.Position = 0
        return $stream
    } catch { $stream.Dispose(); throw } finally { $hasher.Dispose() }
}

function Assert-NoOtherRuntime {
    $existing = @(Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" -ErrorAction Stop)
    Assert-DirectChat ($existing.Count -eq 0) 'A llama-server is already running. Stop its owning Luczor/direct-chat test first; no foreign process was stopped.'
}

function Assert-OwnedListener {
    param([Diagnostics.Process]$Process)
    Assert-DirectChat (-not $Process.HasExited) 'The local model runtime exited. See the private run log.'
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    Assert-DirectChat ($listeners.Count -gt 0) 'The local listener is unavailable.'
    foreach ($listener in $listeners) {
        Assert-DirectChat ($listener.LocalAddress -eq '127.0.0.1' -and $listener.OwningProcess -eq $Process.Id) 'The loopback listener does not belong to this model process.'
    }
}

Assert-DirectChat ($env:OS -eq 'Windows_NT') 'This pinned CUDA test profile requires Windows.'
$assetDirectory = Get-SafePath $AssetRoot
$profile = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'local-model-test.profile.json') -Raw | ConvertFrom-Json
$modelPath = Get-SafePath (Join-Path $assetDirectory $profile.assets.model.relativePath)
$runtimePath = Get-SafePath (Join-Path $assetDirectory $profile.assets.runtime.relativePath)
$runtimeDirectory = Split-Path -Parent $runtimePath
$handles = [Collections.Generic.List[IDisposable]]::new()
$ownerLock = $null
$runtimeProcess = $null
$keyPath = $null
$accessKey = $null
$savedClipboard = $null
$clipboardSet = $false
$savedLlamaEnvironment = @{}

try {
    if (-not $ValidateOnly) {
        $lockPath = Join-Path $assetDirectory 'runtime-owner.lock'
        if (Test-Path -LiteralPath $lockPath) { [void](Get-SafePath $lockPath) }
        try { $ownerLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'Another Luczor/direct-chat launcher owns the GPU test slot. Stop that test first.' }
        Assert-NoOtherRuntime
    }

    Write-Host 'Checking the pinned 27B model, runtime and CUDA DLLs. This reads the complete model once.'
    $handles.Add((Open-PinnedFile $modelPath ([long]$profile.assets.model.sizeBytes) $profile.assets.model.sha256))
    $handles.Add((Open-PinnedFile $runtimePath -1 $profile.assets.runtime.sha256))
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $expectedFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($archivePin in $profile.assets.archives) {
        $archivePath = Get-SafePath (Join-Path $assetDirectory $archivePin.relativePath)
        $archiveHandle = Open-PinnedFile $archivePath ([long]$archivePin.sizeBytes) $archivePin.sha256
        $handles.Add($archiveHandle)
        $archive = [IO.Compression.ZipArchive]::new($archiveHandle, [IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            foreach ($entry in $archive.Entries) {
                if (-not $entry.Name) { continue }
                Assert-DirectChat ($entry.FullName -eq $entry.Name) 'Unexpected nested entry in the pinned runtime archive.'
                [void]$expectedFiles.Add($entry.Name)
                $zipStream = $entry.Open()
                $zipHasher = [Security.Cryptography.SHA256]::Create()
                try { $zipHash = ([BitConverter]::ToString($zipHasher.ComputeHash($zipStream))).Replace('-', '').ToLowerInvariant() }
                finally { $zipStream.Dispose(); $zipHasher.Dispose() }
                $handles.Add((Open-PinnedFile (Join-Path $runtimeDirectory $entry.Name) $entry.Length $zipHash))
            }
        } finally { $archive.Dispose() }
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $runtimeDirectory -Force)) {
        Assert-DirectChat (-not $entry.PSIsContainer -and $expectedFiles.Contains($entry.Name)) 'Unexpected file in the pinned runtime directory.'
    }
    if ($ValidateOnly) { Write-Host 'Direct-chat pinned assets validated; no runtime started.'; return }

    $os = Get-CimInstance Win32_OperatingSystem
    Assert-DirectChat (([long]$os.TotalVisibleMemorySize * 1024) -ge [long]$profile.catalog.minTotalRamBytes) 'This profile requires 32 GB total RAM.'
    Assert-DirectChat (([long]$os.FreePhysicalMemory * 1024) -ge [long]$profile.catalog.minAvailableRamBytes) 'Not enough free host RAM. Close unused applications and retry.'
    $smi = (Get-Command nvidia-smi.exe -ErrorAction Stop).Source
    $freeVram = @(& $smi --query-gpu=memory.free --format=csv,noheader,nounits)
    Assert-DirectChat ($LASTEXITCODE -eq 0 -and $freeVram.Count -gt 0) 'NVIDIA VRAM could not be measured.'
    Assert-DirectChat (([long]$freeVram[0].Trim() * 1MB) -ge [long]$profile.catalog.minVramBytes) 'Not enough free GPU VRAM. Stop the other model or GPU application first.'
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($modelPath))
    Assert-DirectChat ($drive.DriveType -eq [IO.DriveType]::Fixed -and $drive.AvailableFreeSpace -ge [long]$profile.catalog.minStorageFreeBytes) 'Model storage must be a fixed disk with sufficient free space.'
    Assert-NoOtherRuntime
    $reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try { $reservation.Start() } catch { throw "Port $Port is already occupied; no process was stopped." } finally { $reservation.Stop() }

    $runRoot = Join-Path $assetDirectory ('direct-chat-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    [void](New-Item -ItemType Directory -Path $runRoot)
    [void](Get-SafePath $runRoot)
    Set-DirectChatPrivateAcl $runRoot -Directory
    $keyPath = Join-Path $runRoot 'api-key.secret'
    $random = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $accessKey = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
    [IO.File]::WriteAllText($keyPath, $accessKey + "`n", [Text.UTF8Encoding]::new($false))
    Set-DirectChatPrivateAcl $keyPath
    $baseUrl = "http://127.0.0.1:$Port"
    $arguments = '--model "{0}" --alias "OrcaRouter-Qwen3.8-27B-local" --host 127.0.0.1 --port {1} --ctx-size 8192 --parallel 1 --gpu-layers all --jinja --perf --api-key-file "{2}" --cors-origins "{3}" --no-agent --no-ui-mcp-proxy --no-slots --no-context-shift' -f $modelPath, $Port, $keyPath, $baseUrl
    # Do not inherit an agent/tool/proxy/remote-model setting from another shell.
    foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'LLAMA_*' -or $_.Name -like 'GGML_RPC*' })) {
        $savedLlamaEnvironment[$entry.Name] = $entry.Value
        [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
    }
    $runtimeProcess = Start-Process -FilePath $runtimePath -ArgumentList $arguments -WorkingDirectory $runtimeDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'server.stdout.log') -RedirectStandardError (Join-Path $runRoot 'server.stderr.log') -PassThru
    foreach ($name in @($savedLlamaEnvironment.Keys)) { [Environment]::SetEnvironmentVariable($name, $savedLlamaEnvironment[$name], 'Process') }
    $savedLlamaEnvironment.Clear()
    Write-Host 'Loading the local 27B model on the RTX GPU...'
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    $ready = $false
    do {
        Assert-DirectChat (-not $runtimeProcess.HasExited) "Model startup failed. Private diagnostics: $runRoot"
        try { Assert-OwnedListener $runtimeProcess; $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 3 -MaximumRedirection 0; $ready = $health.status -eq 'ok' } catch { }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
    Assert-DirectChat $ready "Model startup exceeded five minutes. Private diagnostics: $runRoot"
    Assert-OwnedListener $runtimeProcess
    $unauthenticated = $false
    try { [void](Invoke-RestMethod -Uri "$baseUrl/v1/models" -TimeoutSec 5 -MaximumRedirection 0) }
    catch { if ($null -ne $_.Exception.Response) { $unauthenticated = [int]$_.Exception.Response.StatusCode -eq 401 } }
    Assert-DirectChat $unauthenticated 'The API did not reject an unauthenticated request.'
    Assert-OwnedListener $runtimeProcess
    $request = @{ messages=@(@{ role='user'; content='Reply with exactly: LUCZOR_DIRECT_CHAT_OK' }); max_tokens=32; temperature=0; stream=$false; chat_template_kwargs=@{ enable_thinking=$false } } | ConvertTo-Json -Depth 6 -Compress
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-RestMethod -Uri "$baseUrl/v1/chat/completions" -Method Post -Headers @{ Authorization="Bearer $accessKey" } -ContentType 'application/json' -Body $request -TimeoutSec 90 -MaximumRedirection 0
    $watch.Stop()
    Assert-DirectChat ($result.choices[0].message.content.Trim() -eq 'LUCZOR_DIRECT_CHAT_OK') 'The real local model smoke response did not match.'
    $report = @{ passed=$true; marker='LUCZOR_DIRECT_CHAT_OK'; url=$baseUrl; model=$profile.assets.model.id; runtime=$profile.assets.runtime.version; contextTokens=8192; elapsedMs=$watch.ElapsedMilliseconds; authRejectedWithoutKey=$true; createdAt=[DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Join-Path $runRoot 'smoke-report.json'), ($report | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Write-Host "Direct local model chat READY: $baseUrl (real reply: $($watch.ElapsedMilliseconds) ms)"
    Write-Host "Private access-key file: $keyPath"
    if ($CopyAccessKey -and -not $SmokeOnly) {
        $savedClipboard = Get-Clipboard -Raw
        Set-Clipboard -Value $accessKey
        $clipboardSet = $true
        Write-Host 'Access key copied. Paste it into the browser API-key field. It is never printed or added to the URL.'
    } else {
        Write-Host 'Use -CopyAccessKey on startup to copy the private access key for the browser API-key field.'
    }
    if (-not $SmokeOnly) {
        if (-not $NoBrowser) { Start-Process $baseUrl }
        [void](Read-Host 'Press Enter here to stop this model server; closing a browser tab alone does not stop it')
    }
} finally {
    foreach ($name in @($savedLlamaEnvironment.Keys)) { [Environment]::SetEnvironmentVariable($name, $savedLlamaEnvironment[$name], 'Process') }
    if ($null -ne $runtimeProcess) {
        if (-not $runtimeProcess.HasExited) { $runtimeProcess.Kill(); [void]$runtimeProcess.WaitForExit(15000) }
        $runtimeProcess.Dispose()
    }
    if ($clipboardSet) {
        try { if ((Get-Clipboard -Raw) -eq $accessKey) { Set-Clipboard -Value ([string]$savedClipboard) } } catch { }
    }
    if ($null -ne $keyPath -and (Test-Path -LiteralPath $keyPath)) { Remove-Item -LiteralPath $keyPath -Force }
    foreach ($handle in $handles) { $handle.Dispose() }
    if ($null -ne $ownerLock) { $ownerLock.Dispose() }
    $accessKey = $null
    if ($null -ne $runtimeProcess -or $null -ne $keyPath) { Write-Host 'Direct-chat runtime stopped and its temporary API-key file removed.' }
}
