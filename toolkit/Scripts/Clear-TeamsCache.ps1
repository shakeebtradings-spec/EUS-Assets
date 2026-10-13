<#
.SYNOPSIS  Clears the Microsoft Teams cache (new Teams and classic Teams) for the current user.
.NOTES     Closes Teams. User signs back in automatically; no files or chats are lost.
#>
[CmdletBinding(SupportsShouldProcess)]
param()
. "$PSScriptRoot\Common.ps1"
Start-ToolLog 'Clear-TeamsCache'
try {
    $paths = @(
        "$env:LOCALAPPDATA\Packages\MSTeams_8wekyb3d8bbwe\LocalCache",   # new Teams
        "$env:LOCALAPPDATA\Packages\MSTeams_8wekyb3d8bbwe\TempState",
        "$env:APPDATA\Microsoft\Teams"                                    # classic Teams
    )
    if ($PSCmdlet.ShouldProcess('Teams processes', 'Stop')) {
        Write-Step 'Closing Teams'
        $stopped = Stop-AppProcess -Name 'ms-teams', 'Teams', 'msedgewebview2'
        if ($stopped) { Write-Ok "Stopped: $($stopped -join ', ')" } else { Write-Ok 'Teams was not running' }
    }
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        if ($PSCmdlet.ShouldProcess($p, 'Clear contents')) {
            Write-Step "Clearing $p"
            $n = Clear-FolderContent $p
            Write-Ok "Removed $n item(s)"
        }
    }
    Write-Ok 'Done. Ask the user to reopen Teams and sign in.'
} catch { Write-Fail $_.Exception.Message; exit 1 } finally { Stop-ToolLog }
