# Read-only verification of installed runtime files against already hash-pinned ZIPs.
param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$ArchivesBase64
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-NoLink([string]$FilePath) {
    if ((Get-Item -LiteralPath $FilePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Linked runtime files are not accepted.'
    }
}

function Get-StreamHash([IO.Stream]$Stream) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

$runtime = (Resolve-Path -LiteralPath $RuntimeRoot).Path.TrimEnd('\', '/')
Assert-NoLink $runtime
$prefix = $runtime + [IO.Path]::DirectorySeparatorChar
[string[]]$archives = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArchivesBase64)))
if ($archives.Count -lt 1) { throw 'Pinned archives are required.' }
$known = @{}
foreach ($archivePath in $archives) {
    Assert-NoLink $archivePath
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        foreach ($entry in $archive.Entries) {
            if (-not $entry.Name) { continue }
            $relative = $entry.FullName.Replace('/', '\')
            if ([IO.Path]::IsPathRooted($relative)) { throw 'Absolute archive entry rejected.' }
            $candidate = [IO.Path]::GetFullPath((Join-Path $runtime $relative))
            if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive traversal rejected.' }
            $part = $candidate
            while ($part.Length -gt $runtime.Length) {
                Assert-NoLink $part
                $part = [IO.Path]::GetDirectoryName($part)
            }
            if (-not [IO.File]::Exists($candidate) -or (Get-Item -LiteralPath $candidate).Length -ne $entry.Length) {
                throw 'Runtime file missing or size mismatch.'
            }
            $source = $entry.Open()
            $installed = [IO.File]::OpenRead($candidate)
            try {
                $sourceHash = Get-StreamHash $source
                if ((Get-StreamHash $installed) -ne $sourceHash) { throw 'Runtime file hash mismatch.' }
                if ($known.ContainsKey($relative) -and $known[$relative] -ne $sourceHash) { throw 'Conflicting archive entries.' }
                $known[$relative] = $sourceHash
            } finally { $source.Dispose(); $installed.Dispose() }
        }
    } finally { $archive.Dispose() }
}
foreach ($file in Get-ChildItem -LiteralPath $runtime -Recurse -Force) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked runtime entries are not accepted.' }
    if ($file.PSIsContainer) { continue }
    if ($file.Extension -notin @('.exe', '.dll')) { continue }
    $relative = $file.FullName.Substring($prefix.Length)
    if (-not $known.ContainsKey($relative)) { throw 'Unpinned executable runtime dependency.' }
}
@{ status = 'PASS'; verifiedFiles = $known.Count; verifiedArchives = $archives.Count } | ConvertTo-Json -Compress
