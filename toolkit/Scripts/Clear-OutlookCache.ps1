<#
.SYNOPSIS  Clears Outlook caches (classic + new Outlook) for the current user.
.NOTES     Closes Outlook. Clears the autocomplete/roaming cache and Office cache only.
           The OST (mailbox copy) is NOT deleted. Use -ClearAutoComplete:$false to keep
           the autocomplete (nickname) list.
#>
[CmdletBinding(SupportsShouldProcess)]
param([bool]$ClearAutoComplete = $true)
. "$PSScriptRoot\Common.ps1"
Start-ToolLog 'Clear-OutlookCache'
try {
    if ($PSCmdlet.ShouldProcess('Outlook', 'Stop')) {
        Write-Step 'Closing Outlook'
        $stopped = Stop-AppProcess -Name 'OUTLOOK', 'olk'
        if ($stopped) { Write-Ok "Stopped: $($stopped -join ', ')" } else { Write-Ok 'Outlook was not running' }
    }
    $paths = @(
        "$env:LOCALAPPDATA\Packages\Microsoft.OutlookForWindows_8wekyb3d8bbwe\LocalCache",   # new Outlook
        "$env:LOCALAPPDATA\Microsoft\Office\16.0\OfficeFileCache"                              # Office file cache
    )
    if ($ClearAutoComplete) { $paths += "$env:LOCALAPPDATA\Microsoft\Outlook\RoamCache" }
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        if ($PSCmdlet.ShouldProcess($p, 'Clear contents')) {
            Write-Step "Clearing $p"
            Write-Ok "Removed $(Clear-FolderContent $p) item(s)"
        }
    }
    Write-Ok 'Done. Reopen Outlook; it may take a few minutes to resync.'
} catch { Write-Fail $_.Exception.Message; exit 1 } finally { Stop-ToolLog }
