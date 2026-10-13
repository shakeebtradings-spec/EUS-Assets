<#
.SYNOPSIS  Forces a Group Policy refresh and an Intune (MDM) sync. Requires admin.
.NOTES     Sync is only requested; policies/apps can take several minutes to apply.
#>
[CmdletBinding(SupportsShouldProcess)]
param()
. "$PSScriptRoot\Common.ps1"
Start-ToolLog 'Sync-PolicyAndIntune'
try {
    Assert-Admin
    if ($PSCmdlet.ShouldProcess('Group Policy', 'gpupdate /force')) {
        Write-Step 'Refreshing Group Policy (can take a minute)'
        gpupdate /force /wait:60 | Out-Host
        Write-Ok 'gpupdate finished'
    }
    if ($PSCmdlet.ShouldProcess('Intune', 'Request sync')) {
        Write-Step 'Requesting Intune MDM sync'
        $tasks = Get-ScheduledTask -TaskPath '\Microsoft\Windows\EnterpriseMgmt\*' -ErrorAction SilentlyContinue |
                 Where-Object TaskName -eq 'PushLaunch'
        if ($tasks) { $tasks | ForEach-Object { Start-ScheduledTask -InputObject $_ }; Write-Ok 'MDM sync task started' }
        else { Write-Warn 'No MDM enrollment task found. Device may not be Intune-enrolled.' }
        try { Start-Process 'intunemanagementextension://syncapp'; Write-Ok 'Intune Management Extension sync requested' } catch {}
    }
    Write-Step 'Join/enrollment state'
    dsregcmd /status | Select-String 'AzureAdJoined|DomainJoined|MdmUrl|TenantName' | ForEach-Object { '    ' + $_.Line.Trim() }
} catch { Write-Fail $_.Exception.Message; exit 1 } finally { Stop-ToolLog }
