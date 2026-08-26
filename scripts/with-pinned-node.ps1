[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Executable = 'node.exe',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]] $Arguments = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'PinnedNode.psm1') -Force
$context = Use-LuczorPinnedNode
Write-Output "Using project-pinned Node v$($context.Version) from $($context.NodeDirectory)"

& $Executable @Arguments
if ($null -ne $LASTEXITCODE) {
    exit $LASTEXITCODE
}
