#!/usr/bin/env pwsh
# BugDesk - local bug tracker UI + bridge over a directory of markdown bug files
#
#   .\run.ps1                          # serve on http://127.0.0.1:8766, bugs in .\bugs
#   .\run.ps1 --seed                   # + pre-seed an empty bug store with 10 example bugs
#   $env:ASPNETCORE_URLS='http://127.0.0.1:9000'; .\run.ps1
#   $env:BUGDESK_BUGS='C:\path\to\bugs'; .\run.ps1
#   $env:BUGDESK_HUMAN='alice'; $env:BUGDESK_AGENT='claude'; .\run.ps1
#
# Windows counterpart of run.sh. The bridge serves the FlexDesk UI (ui/) AND the
# JSON API, and reads/writes the markdown bug files. Open the printed URL in a
# browser.
#
# If PowerShell refuses to run this ("running scripts is disabled on this
# system"), either unblock it for the session:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# or invoke it directly:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Same resolution order as the server's own ResolveBugsDir (Program.cs):
# BUGDESK_BUGS if set, else <repo root>\bugs.
$bugsDir = if ($env:BUGDESK_BUGS) { $env:BUGDESK_BUGS } else { Join-Path $root 'bugs' }

$seed = $false
$dotnetArgs = @()
foreach ($a in $args) {
    if ($a -eq '--seed') { $seed = $true } else { $dotnetArgs += $a }
}

if ($seed) {
    $existing = @(Get-ChildItem -Path $bugsDir -Filter 'BUG-*.md' -File -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        Write-Host "BugDesk: $bugsDir already has $($existing.Count) bug(s) - skipping --seed (won't overwrite)."
    } else {
        New-Item -ItemType Directory -Path $bugsDir -Force | Out-Null
        Copy-Item -Path (Join-Path $root 'examples\bugs\BUG-*.md') -Destination $bugsDir
        Write-Host "BugDesk: seeded $bugsDir with 10 example bugs."
    }
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Host "BugDesk: 'dotnet' not found on PATH. Install the .NET SDK from https://dotnet.microsoft.com/download"
    exit 1
}

Set-Location (Join-Path $root 'server')
if (-not $env:ASPNETCORE_URLS) { $env:ASPNETCORE_URLS = 'http://127.0.0.1:8766' }
$bugsLabel = if ($env:BUGDESK_BUGS) { $env:BUGDESK_BUGS } else { '.\bugs' }
Write-Host "BugDesk -> $($env:ASPNETCORE_URLS)   (bugs: $bugsLabel)"
& dotnet run @dotnetArgs
exit $LASTEXITCODE
