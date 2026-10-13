# EUS Support Toolkit

PowerShell 5.1+ (Windows). No install, no modules.

| Menu | Script | Needs admin | What it does |
|---|---|---|---|
| 1 | `Get-MachineHealth.ps1` | No (BitLocker detail needs it) | Disk, BitLocker, pending reboot, last update, uptime, user. Paste into ticket. |
| 2 | `Scripts\Clear-TeamsCache.ps1` | No | Closes Teams, clears new + classic cache |
| 3 | `Scripts\Clear-OutlookCache.ps1` | No | Closes Outlook, clears autocomplete/Office/new-Outlook cache (OST untouched) |
| 4 | `Scripts\Reset-PrintSpooler.ps1` | Yes | Stop spooler, purge stuck jobs, start |
| 5 | `Scripts\Clear-DnsCache.ps1` | Partly | Flush resolver cache, re-register DNS |
| 6 | `Scripts\Register-CompanyPortal.ps1` | Yes | Re-register Company Portal AppX |
| 7 | `Scripts\Sync-PolicyAndIntune.ps1` | Yes | `gpupdate /force` + Intune sync |

## Use
```powershell
powershell -ExecutionPolicy Bypass -File .\Start-SupportToolkit.ps1
.\Get-MachineHealth.ps1 -Copy              # copies report to clipboard
.\Get-MachineHealth.ps1 -ComputerName PC01 # remote via WinRM
```
Safety: destructive options ask for confirmation, show a warning, and refuse if admin is needed but missing.
Press `W` in the menu for preview mode, or pass `-WhatIf` to any script. Every fix writes a transcript to
`C:\ProgramData\EUSToolkit\Logs`.

Run the user-context scripts (Teams, Outlook) as the affected user: they clear that user's profile.
