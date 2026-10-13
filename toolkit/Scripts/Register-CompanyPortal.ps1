<#
.SYNOPSIS  Re-registers the Company Portal app package for all users. Requires admin.
.NOTES     Fixes Company Portal that will not open, shows a blank window, or is missing from Start.
           If the package is not installed at all, install it via Intune/Microsoft Store instead.
#>
[CmdletBinding(SupportsShouldProcess)]
param()
. "$PSScriptRoot\Common.ps1"
Start-ToolLog 'Register-CompanyPortal'
try {
    Assert-Admin
    $pkgs = Get-AppxPackage -AllUsers -Name 'Microsoft.CompanyPortal'
    if (-not $pkgs) { throw 'Company Portal is not installed on this device. Deploy it from Intune or the Microsoft Store.' }
    Stop-AppProcess -Name 'CompanyPortal' | Out-Null
    foreach ($p in $pkgs) {
        $manifest = Join-Path $p.InstallLocation 'AppxManifest.xml'
        if (-not (Test-Path -LiteralPath $manifest)) { Write-Warn "Manifest missing for $($p.PackageFullName)"; continue }
        if ($PSCmdlet.ShouldProcess($p.PackageFullName, 'Re-register')) {
            Write-Step "Registering $($p.PackageFullName)"
            Add-AppxPackage -DisableDevelopmentMode -Register $manifest
            Write-Ok 'Registered'
        }
    }
} catch { Write-Fail $_.Exception.Message; exit 1 } finally { Stop-ToolLog }
