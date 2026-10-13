# Shared helpers, dot-sourced by every toolkit script:  . "$PSScriptRoot\Common.ps1"
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:LogDir = Join-Path $env:ProgramData 'EUSToolkit\Logs'

function Write-Step { param([string]$Message) Write-Host "  [..] $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "  [OK] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "  [!!] $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  [XX] $Message" -ForegroundColor Red }

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
    if (-not (Test-IsAdmin)) { throw 'This action needs an elevated session. Re-run PowerShell as Administrator.' }
}

function Start-ToolLog {
    param([Parameter(Mandatory)][string]$Name)
    try {
        New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
        $file = Join-Path $script:LogDir ("{0}_{1:yyyyMMdd-HHmmss}.log" -f $Name, (Get-Date))
        Start-Transcript -Path $file | Out-Null
        $script:TranscriptOn = $true
    } catch { $script:TranscriptOn = $false }   # logging must never block a fix
}

function Stop-ToolLog {
    if ($script:TranscriptOn) { try { Stop-Transcript | Out-Null } catch {} }
}

# Stop processes by name and wait for them to exit. Returns the names that were running.
function Stop-AppProcess {
    param([Parameter(Mandatory)][string[]]$Name)
    $running = Get-Process -Name $Name -ErrorAction SilentlyContinue
    if ($running) {
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        $running | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
    }
    $running | Select-Object -ExpandProperty ProcessName -Unique
}

# Delete the *contents* of a folder (never the folder itself). Returns count of items removed.
function Clear-FolderContent {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $items = Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    $n = 0
    foreach ($i in $items) {
        try { Remove-Item -LiteralPath $i.FullName -Recurse -Force -ErrorAction Stop; $n++ }
        catch { Write-Warn "Could not remove $($i.FullName): $($_.Exception.Message)" }
    }
    $n
}
