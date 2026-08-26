Set-StrictMode -Version Latest

function Get-LuczorPinnedNode {
    [CmdletBinding()]
    param()

    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $versionFile = Join-Path $projectRoot '.nvmrc'
    if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
        throw "Missing project Node pin: $versionFile"
    }

    $version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    if ($version -notmatch '^22\.\d+\.\d+$') {
        throw "The .nvmrc value must be a complete Node 22 version, got '$version'."
    }

    $candidateDirectories = [System.Collections.Generic.List[string]]::new()
    if ($env:NVM_HOME) {
        $candidateDirectories.Add((Join-Path $env:NVM_HOME "v$version"))
    }

    $nvmCommand = Get-Command nvm.exe -ErrorAction SilentlyContinue
    if ($nvmCommand) {
        $candidateDirectories.Add((Join-Path (Split-Path -Parent $nvmCommand.Source) "v$version"))
    }

    $activeNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($activeNode) {
        $activeVersion = (& $activeNode.Source --version).Trim().TrimStart('v')
        if ($activeVersion -eq $version) {
            $candidateDirectories.Add((Split-Path -Parent $activeNode.Source))
        }
    }

    foreach ($directory in $candidateDirectories | Select-Object -Unique) {
        $nodeExecutable = Join-Path $directory 'node.exe'
        if (-not (Test-Path -LiteralPath $nodeExecutable -PathType Leaf)) {
            continue
        }

        $actualVersion = (& $nodeExecutable --version).Trim().TrimStart('v')
        if ($actualVersion -eq $version) {
            return [pscustomobject]@{
                ProjectRoot = $projectRoot
                Version = $version
                NodeDirectory = (Resolve-Path -LiteralPath $directory).Path
                NodeExecutable = (Resolve-Path -LiteralPath $nodeExecutable).Path
            }
        }
    }

    throw "Node $version is not installed. Run 'nvm install $version 64'. Do not run 'nvm use' when other shells must keep their active Node version."
}

function Use-LuczorPinnedNode {
    [CmdletBinding()]
    param()

    $context = Get-LuczorPinnedNode
    $env:Path = "$($context.NodeDirectory);$env:Path"
    $resolvedVersion = (& node.exe --version).Trim()
    if ($resolvedVersion -ne "v$($context.Version)") {
        throw "Pinned Node activation failed: expected v$($context.Version), got $resolvedVersion."
    }
    return $context
}

Export-ModuleMember -Function Get-LuczorPinnedNode, Use-LuczorPinnedNode
