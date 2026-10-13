<#
.SYNOPSIS  Menu launcher for the EUS remediation toolkit.
.EXAMPLE   .\Start-SupportToolkit.ps1
#>
[CmdletBinding()]
param()
$scripts = Join-Path $PSScriptRoot 'Scripts'
. "$scripts\Common.ps1"

$menu = @(
    [pscustomobject]@{ Key='1'; Title='Machine health check';            File='..\Get-MachineHealth.ps1';   Admin=$false; Confirm=$false; Warn='' }
    [pscustomobject]@{ Key='2'; Title='Clear Teams cache';               File='Clear-TeamsCache.ps1';       Admin=$false; Confirm=$true;  Warn='Teams will be closed.' }
    [pscustomobject]@{ Key='3'; Title='Clear Outlook cache';             File='Clear-OutlookCache.ps1';     Admin=$false; Confirm=$true;  Warn='Outlook will be closed; autocomplete list is reset.' }
    [pscustomobject]@{ Key='4'; Title='Reset print spooler';             File='Reset-PrintSpooler.ps1';     Admin=$true;  Confirm=$true;  Warn='All queued print jobs on this PC are discarded.' }
    [pscustomobject]@{ Key='5'; Title='Flush DNS';                       File='Clear-DnsCache.ps1';         Admin=$false; Confirm=$true;  Warn='' }
    [pscustomobject]@{ Key='6'; Title='Re-register Company Portal';      File='Register-CompanyPortal.ps1'; Admin=$true;  Confirm=$true;  Warn='Company Portal will be closed.' }
    [pscustomobject]@{ Key='7'; Title='Force GPO + Intune sync';         File='Sync-PolicyAndIntune.ps1';   Admin=$true;  Confirm=$true;  Warn='' }
)

function Show-Menu {
    Clear-Host
    $who = "$env:USERDOMAIN\$env:USERNAME"
    $adm = if (Test-IsAdmin) { 'Admin' } else { 'Standard user' }
    Write-Host "=== EUS Support Toolkit ===  $env:COMPUTERNAME | $who | $adm" -ForegroundColor Cyan
    Write-Host ''
    foreach ($m in $menu) {
        $tag = if ($m.Admin) { ' [admin]' } else { '' }
        Write-Host ("  {0}. {1}{2}" -f $m.Key, $m.Title, $tag)
    }
    Write-Host '  W. Preview mode (WhatIf): ' -NoNewline
    Write-Host $(if ($script:Preview) { 'ON  - nothing will be changed' } else { 'off' }) -ForegroundColor Yellow
    Write-Host '  Q. Quit'
    Write-Host ''
}

$script:Preview = $false
while ($true) {
    Show-Menu
    $choice = (Read-Host 'Select').Trim().ToUpper()
    if ($choice -eq 'Q') { break }
    if ($choice -eq 'W') { $script:Preview = -not $script:Preview; continue }
    $item = $menu | Where-Object Key -eq $choice
    if (-not $item) { continue }

    Write-Host ''
    if ($item.Admin -and -not (Test-IsAdmin)) {
        Write-Fail "'$($item.Title)' needs an elevated PowerShell. Relaunch as Administrator."
    }
    else {
        $go = $true
        if ($item.Confirm -and -not $script:Preview) {
            if ($item.Warn) { Write-Warn $item.Warn }
            $go = (Read-Host "Run '$($item.Title)'? (y/N)") -match '^(y|yes)$'
        }
        if ($go) {
            $args = @{}
            if ($script:Preview -and $item.Confirm) { $args.WhatIf = $true }
            & (Join-Path $scripts $item.File) @args
        } else { Write-Host 'Cancelled.' }
    }
    Write-Host ''
    Read-Host 'Press Enter to return to the menu' | Out-Null
}
