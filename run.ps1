#!/usr/bin/env pwsh
# BugDesk - local bug tracker UI + bridge over a directory of markdown bug files
#
# Run `.\run.ps1 --help` for the full usage; it is printed from one place below
# rather than kept in step with a copy in this header.
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
# In tracker mode the directory you started from is what NAMES the tracker
# (ResolveTrackerProject in Program.cs), so it is captured explicitly rather
# than left for the server to infer from its own working directory.
if (-not $env:BUGDESK_INVOKED_FROM) { $env:BUGDESK_INVOKED_FROM = (Get-Location).Path }
$root = $PSScriptRoot

function Show-Usage {
    @'
BugDesk - a local UI and JSON bridge over a directory of markdown records.

USAGE
  .\run.ps1 [options]

OPTIONS
  --help, -h        Show this and exit.
  --seed            Copy the bundled examples into any store that is still
                    empty. Never overwrites: a store that already holds records
                    is skipped, and the two stores are considered separately.
  --tracker         Tracker mode - follow up work you handed to other people.
                    Its records live under %APPDATA%\BugDesk\<project>\, NOT in
                    this repo, and the port is chosen automatically.
  --project=NAME    Tracker mode only: which tracker to open. Defaults to the
                    name of the directory you ran this from.

WHERE THE RECORDS LIVE
  By default: .\bugs and .\backlog beside this script. Point them somewhere
  else with environment variables - the same ones the server itself reads, so
  the UI and an agent editing the files always agree:

    $env:BUGDESK_BUGS='C:\path\to\bugs'; .\run.ps1
        The bug store. The backlog defaults to a SIBLING of whatever you set
        here, so this one variable moves both stores together - which is what
        you want when BugDesk is tracking a different repo than it lives in.

    $env:BUGDESK_BACKLOG='C:\path\to\backlog'; .\run.ps1
        The backlog store, when it is not beside the bug store.

  Set both to place them independently. Remember that `$env:` assignments last
  for the rest of the PowerShell session, so clear one with `$env:BUGDESK_BUGS
  = $null` when you want the default back.

  The directories are created on demand. Every path is printed at startup, so
  check that line if you are not seeing the records you expected.

OTHER ENVIRONMENT VARIABLES
  ASPNETCORE_URLS   Where to listen. Default http://127.0.0.1:8766.
  BUGDESK_CONFIG    Where profiles and filters live. Default .bugdesk\ beside
                    the stores; it is git-ignored and per-person.
  BUGDESK_USER      Pick a profile by name and skip the first-run prompt.
  BUGDESK_HUMAN     Seed the two names on a store that has no profile yet.
  BUGDESK_AGENT     Ignored once a profile exists - the profile wins.
  BUGDESK_MODE      bugs (default) or tracker; --tracker is the same thing.

YOUR WORKING DIRECTORY
  This script does not change it. It used to Set-Location into server\ before
  starting the bridge, and because a PowerShell location change outlives the
  script, you were left sitting in server\ after stopping the server with
  Ctrl+C. It now passes that path to `dotnet run --project` instead, so the
  directory you started from is the directory you come back to. That also
  matters in tracker mode, where that directory is what names the tracker.

EXAMPLES
  .\run.ps1                                  # this repo's own stores
  .\run.ps1 --seed                           # and fill them if they are empty
  $env:BUGDESK_BUGS='C:\work\acme\bugs'; .\run.ps1
  $env:ASPNETCORE_URLS='http://127.0.0.1:9000'; .\run.ps1
  cd C:\work\acme; C:\bugdesk\run.ps1 --tracker
'@ | Write-Host
}

# -h and -? are matched too: PowerShell users reach for them before --help, and
# a help flag that silently starts a server is a bad way to find that out.
foreach ($a in $args) {
    if ($a -in '--help', '-h', '-help', '-?', '/?') { Show-Usage; exit 0 }
}

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
#
# Everything in $dotnetArgs goes after a literal `--` at the bottom, which is
# what makes forwarding safe: `--project=NAME` is BugDesk's tracker name, but it
# is also `dotnet run`'s own option for a project file. Without the separator
# the CLI swallowed it and answered "The provided file path does not exist", and
# the tracker quietly fell back to naming itself after the current directory.
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
    Write-Host "BugDesk -> tracker mode (the URL is printed below; the port is picked automatically)"
    & dotnet run --project (Join-Path $root 'server') -- @dotnetArgs
    exit $LASTEXITCODE
}

# Seed each store INDEPENDENTLY - see Seed-Store above.
if ($seed) {
    Seed-Store $bugsDir    'BUG-*.md' (Join-Path $root 'examples\bugs')    'bug(s)'
    Seed-Store $backlogDir '*-*.md'   (Join-Path $root 'examples\backlog') 'backlog item(s)'
}

if (-not $env:ASPNETCORE_URLS) { $env:ASPNETCORE_URLS = 'http://127.0.0.1:8766' }
Write-Host "BugDesk -> $($env:ASPNETCORE_URLS)   (mode: $($env:BUGDESK_MODE), bugs: $bugsDir, backlog: $backlogDir)"
& dotnet run --project (Join-Path $root 'server') -- @dotnetArgs
exit $LASTEXITCODE
