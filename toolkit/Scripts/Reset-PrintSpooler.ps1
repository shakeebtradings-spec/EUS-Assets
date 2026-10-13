<#
.SYNOPSIS  Stops the print spooler, clears stuck jobs, and starts it again. Requires admin.
.NOTES     All queued print jobs on this machine are discarded.
#>
[CmdletBinding(SupportsShouldProcess)]
param()
. "$PSScriptRoot\Common.ps1"
Start-ToolLog 'Reset-PrintSpooler'
try {
    Assert-Admin
    $queue = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'
    if ($PSCmdlet.ShouldProcess('Spooler service', 'Stop, clear queue, start')) {
        Write-Step 'Stopping Spooler'
        Stop-Service -Name Spooler -Force
        Write-Step "Clearing $queue"
        Write-Ok "Removed $(Clear-FolderContent $queue) stuck file(s)"
        Write-Step 'Starting Spooler'
        Start-Service -Name Spooler
        $s = Get-Service Spooler
        if ($s.Status -eq 'Running') { Write-Ok 'Spooler is running' } else { throw "Spooler is $($s.Status)" }
    }
} catch { Write-Fail $_.Exception.Message; exit 1 } finally { Stop-ToolLog }
