<#
.SYNOPSIS  Flushes the DNS resolver cache and re-registers this machine's DNS record. Admin recommended.
#>
[CmdletBinding(SupportsShouldProcess)]
param()
. "$PSScriptRoot\Common.ps1"
Start-ToolLog 'Clear-DnsCache'
try {
    if ($PSCmdlet.ShouldProcess('DNS client cache', 'Flush')) {
        Write-Step 'Flushing DNS cache'
        Clear-DnsClientCache
        Write-Ok 'DNS cache flushed'
    }
    if (Test-IsAdmin) {
        if ($PSCmdlet.ShouldProcess('DNS record', 'Re-register')) {
            Write-Step 'Re-registering DNS'
            ipconfig /registerdns | Out-Null
            Write-Ok 'Re-registration requested (can take up to 15 min to appear)'
        }
    } else { Write-Warn 'Not elevated: skipped DNS re-registration' }
} catch { Write-Fail $_.Exception.Message; exit 1 } finally { Stop-ToolLog }
