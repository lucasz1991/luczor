$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Fixed, read-only collector. Never interpolate model/user input into this file.
function Unavailable-Source {
    return @{ status = 'unavailable'; reason = 'not_available_or_not_authorized'; data = $null }
}

$defender = Unavailable-Source
try {
    $status = Get-MpComputerStatus
    $defender = @{ status = 'ready'; data = @{
        antivirus_enabled = $status.AntivirusEnabled
        realtime_protection_enabled = $status.RealTimeProtectionEnabled
        antispyware_enabled = $status.AntispywareEnabled
        tamper_protected = $status.IsTamperProtected
        signature_age_days = $status.AntivirusSignatureAge
    } }
} catch { }

$firewall = Unavailable-Source
try {
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {
        $enabled = $null
        if ([string]$_.Enabled -eq 'True') { $enabled = $true }
        elseif ([string]$_.Enabled -eq 'False') { $enabled = $false }
        @{ profile = [string]$_.Name; enabled = $enabled }
    })
    if ($profiles.Count -gt 0) { $firewall = @{ status = 'ready'; data = $profiles } }
} catch { }

$updates = Unavailable-Source
try {
    $latest = Get-HotFix | Where-Object { $null -ne $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
    if ($null -ne $latest) {
        $updates = @{ status = 'ready'; data = @{
            latest_hotfix_id = [string]$latest.HotFixID
            installed_at = $latest.InstalledOn.ToUniversalTime().ToString('o')
            pending_updates_checked = $false
        } }
    }
} catch { }

@{ defender = $defender; firewall = $firewall; updates = $updates } | ConvertTo-Json -Depth 5 -Compress
