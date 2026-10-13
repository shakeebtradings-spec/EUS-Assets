<#
.SYNOPSIS  One-command health report to paste into a ticket.
.PARAMETER ComputerName  Optional remote machine (needs WinRM). Default: this machine.
.PARAMETER Copy          Copy the report to the clipboard.
.PARAMETER OutFile       Also save the report to this path.
.EXAMPLE   .\Get-MachineHealth.ps1 -Copy
#>
[CmdletBinding()]
param(
    [string]$ComputerName,
    [switch]$Copy,
    [string]$OutFile
)

$collector = {
    $ErrorActionPreference = 'SilentlyContinue'
    $r = [ordered]@{}

    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $bios = Get-CimInstance Win32_BIOS
    $r.Computer = $env:COMPUTERNAME
    $r.Model    = "$($cs.Manufacturer) $($cs.Model)"
    $r.Serial   = $bios.SerialNumber
    $r.OS       = "$($os.Caption) $($os.Version)"

    # Logged-in user(s)
    $users = @($cs.UserName)
    $users += (Get-Process -Name explorer -IncludeUserName | Select-Object -ExpandProperty UserName)
    $users = $users | Where-Object { $_ } | Sort-Object -Unique
    $r.LoggedInUser = if ($users) { $users -join ', ' } else { 'None (no interactive session)' }

    # Uptime
    $up = (Get-Date) - $os.LastBootUpTime
    $r.Uptime = '{0}d {1}h {2}m (booted {3:yyyy-MM-dd HH:mm})' -f $up.Days, $up.Hours, $up.Minutes, $os.LastBootUpTime

    # Disk space (fixed disks)
    $r.Disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
        $pct = if ($_.Size) { [math]::Round(100 * $_.FreeSpace / $_.Size) } else { 0 }
        $flag = if ($pct -lt 10) { '  <-- LOW' } else { '' }
        '{0} {1:N1} GB free of {2:N1} GB ({3}% free){4}' -f $_.DeviceID, ($_.FreeSpace/1GB), ($_.Size/1GB), $pct, $flag
    })

    # BitLocker
    $bl = Get-BitLockerVolume
    if ($bl) {
        $r.BitLocker = @($bl | ForEach-Object { '{0} {1}, protection {2}, {3}%' -f $_.MountPoint, $_.VolumeStatus, $_.ProtectionStatus, $_.EncryptionPercentage })
    } else {
        $line = (manage-bde -status $env:SystemDrive 2>&1 | Select-String 'Protection Status|Conversion Status' | ForEach-Object { $_.Line.Trim() }) -join '; '
        $r.BitLocker = @($(if ($line) { $line } else { 'Unavailable (run as Administrator)' }))
    }

    # Pending reboot
    $why = @()
    if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $why += 'Component Servicing' }
    if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $why += 'Windows Update' }
    if ((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager').PendingFileRenameOperations) { $why += 'Pending file rename' }
    $r.PendingReboot = if ($why) { 'YES (' + ($why -join ', ') + ')' } else { 'No' }

    # Last Windows Update
    $last = $null
    try {
        $s = New-Object -ComObject Microsoft.Update.Session
        $h = $s.CreateUpdateSearcher().QueryHistory(0, 50) | Where-Object { $_.ResultCode -eq 2 -and $_.Title } | Sort-Object Date -Descending | Select-Object -First 1
        if ($h) { $last = '{0:yyyy-MM-dd} - {1}' -f $h.Date, $h.Title }
    } catch {}
    if (-not $last) {
        $hf = Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1
        if ($hf) { $last = '{0:yyyy-MM-dd} - {1}' -f $hf.InstalledOn, $hf.HotFixID }
    }
    $r.LastWindowsUpdate = if ($last) { $last } else { 'Unknown' }
    $r
}

if ($ComputerName) { $data = Invoke-Command -ComputerName $ComputerName -ScriptBlock $collector }
else               { $data = & $collector }

$lines = @()
$lines += "=== Machine Health: $($data.Computer) | $(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
foreach ($k in 'Model','Serial','OS','LoggedInUser','Uptime','PendingReboot','LastWindowsUpdate') {
    $lines += ('{0,-18}: {1}' -f $k, $data[$k])
}
$lines += ('{0,-18}:' -f 'Disks');     $lines += $data.Disks     | ForEach-Object { "    $_" }
$lines += ('{0,-18}:' -f 'BitLocker'); $lines += $data.BitLocker | ForEach-Object { "    $_" }
$report = $lines -join [Environment]::NewLine

Write-Output $report
if ($OutFile) { $report | Set-Content -Path $OutFile -Encoding UTF8 }
if ($Copy)    { $report | Set-Clipboard; Write-Host '(copied to clipboard)' -ForegroundColor Green }
