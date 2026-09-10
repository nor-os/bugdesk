#!/usr/bin/env pwsh
# BugDesk - local bug tracker UI + bridge over a directory of markdown bug files
#
#   .\run.ps1                          # serve on http://127.0.0.1:8766, stores in .\bugs + .\backlog
#   .\run.ps1 --seed                   # + pre-seed empty stores with the examples
#   .\run.ps1 --tracker                # TRACKER mode: follow-up tracker for work
#                                      #   you have handed to other people
#   $env:BUGDESK_MODE='tracker'; .\run.ps1
#   $env:ASPNETCORE_URLS='http://127.0.0.1:9000'; .\run.ps1
#   $env:BUGDESK_BUGS='C:\path\to\bugs'; .\run.ps1
#   $env:BUGDESK_BACKLOG='C:\path\to\backlog'; .\run.ps1
#   $env:BUGDESK_USER='alice'; .\run.ps1     # pick a per-user profile without the prompt
#   $env:BUGDESK_HUMAN='alice'; $env:BUGDESK_AGENT='claude'; .\run.ps1
#
# Windows counterpart of run.sh. The bridge serves the FlexDesk UI (ui/) AND the
# JSON API, and reads/writes the markdown files in both stores. Open the printed
# URL in a browser; the first run asks who you are and remembers it in a
# git-ignored .bugdesk\ beside the stores.
#
# If PowerShell refuses to run this ("running scripts is disabled on this
# system"), either unblock it for the session:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# or invoke it directly:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1
$ErrorActionPreference = 'Stop'
# Captured BEFORE the Set-Location into server\ below: in tracker mode the
# directory you started from names the tracker (ResolveTrackerProject in
# Program.cs), and by then the process is somewhere else.
if (-not $env:BUGDESK_INVOKED_FROM) { $env:BUGDESK_INVOKED_FROM = (Get-Location).Path }
$root = $PSScriptRoot

# Same resolution order as the server's own ResolveBugsDir / ResolveBacklogDir
# (Program.cs): the env var if set, else <repo root>\bugs and its sibling
# backlog\ - derived from the bug dir, not from $root, so BUGDESK_BUGS alone
# moves both stores together.
$bugsDir = if ($env:BUGDESK_BUGS) { $env:BUGDESK_BUGS } else { Join-Path $root 'bugs' }
$backlogDir = if ($env:BUGDESK_BACKLOG) { $env:BUGDESK_BACKLOG }
              else { Join-Path (Split-Path -Parent $bugsDir) 'backlog' }

# --tracker is consumed HERE and re-exported as BUGDESK_MODE rather than being
# forwarded: `dotnet run` treats an unrecognised leading flag as its own and
# would reject it before the app ever saw it.
$seed = $false
$dotnetArgs = @()
foreach ($a in $args) {
    if ($a -eq '--seed') { $seed = $true }
    elseif ($a -eq '--tracker') { $env:BUGDESK_MODE = 'tracker' }
    elseif ($a -like '--mode=*') { $env:BUGDESK_MODE = $a.Substring(7) }
    # Forwarded, not consumed: the server reads it (ResolveTrackerProject).
    else { $dotnetArgs += $a }
}
if (-not $env:BUGDESK_MODE) { $env:BUGDESK_MODE = 'bugs' }

# Seed each store INDEPENDENTLY - a repo that already tracks bugs but has no
# backlog yet is the normal way into this feature, and refusing to seed the
# backlog because bugs already exist would be the wrong answer for that case.
function Seed-Store {
    param($Dir, $Glob, $Source, $What)
    $existing = @(Get-ChildItem -Path $Dir -Filter $Glob -File -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        Write-Host "BugDesk: $Dir already has $($existing.Count) $What - skipping --seed (won't overwrite)."
        return
    }
    $incoming = @(Get-ChildItem -Path (Join-Path $Source '*.md') -File -ErrorAction SilentlyContinue)
    if ($incoming.Count -eq 0) {
        Write-Host "BugDesk: no examples in $Source - nothing to seed into $Dir."
        return
    }
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    Copy-Item -Path $incoming.FullName -Destination $Dir
    Write-Host "BugDesk: seeded $Dir with $($incoming.Count) example $What."
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Host "BugDesk: 'dotnet' not found on PATH. Install the .NET SDK from https://dotnet.microsoft.com/download"
    exit 1
}

# A TRACKER does not live in the repo at all - its records go under
# %APPDATA%\BugDesk, one folder per project (ResolveTrackerBase in Program.cs).
# So the paths computed above are not its business, and neither is a fixed port:
# the server takes the next free one, because a tracker is usually opened
# alongside a BugDesk already running on a repo.
if ($env:BUGDESK_MODE -eq 'tracker') {
    if ($seed) {
        # The server owns the tracker's paths, so ask it to seed rather than
        # recomputing them here and getting to disagree.
        Write-Host "BugDesk: --seed is applied by the server in tracker mode; see the URL it prints."
        $env:BUGDESK_SEED_TRACKER = '1'
    }
    Set-Location (Join-Path $root 'server')
    Write-Host "BugDesk -> tracker mode (the URL is printed below; the port is picked automatically)"
    & dotnet run @dotnetArgs
    exit $LASTEXITCODE
}

# Seed each store INDEPENDENTLY - see Seed-Store above.
if ($seed) {
    Seed-Store $bugsDir    'BUG-*.md' (Join-Path $root 'examples\bugs')    'bug(s)'
    Seed-Store $backlogDir '*-*.md'   (Join-Path $root 'examples\backlog') 'backlog item(s)'
}

Set-Location (Join-Path $root 'server')
if (-not $env:ASPNETCORE_URLS) { $env:ASPNETCORE_URLS = 'http://127.0.0.1:8766' }
Write-Host "BugDesk -> $($env:ASPNETCORE_URLS)   (mode: $($env:BUGDESK_MODE), bugs: $bugsDir, backlog: $backlogDir)"
& dotnet run @dotnetArgs
exit $LASTEXITCODE
