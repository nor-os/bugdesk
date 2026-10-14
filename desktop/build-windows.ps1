<#
.SYNOPSIS
  Build BugDesk's Windows desktop app two ways: a per-user MSI and a portable zip.

.DESCRIPTION
  Both are self-contained (they carry the .NET runtime, so nothing has to be
  installed first) and carry ui/ beside the executable:

    desktop\out\BugDesk-<version>-win-x64.msi            installs to %LocalAppData%\Programs\BugDesk
    desktop\out\BugDesk-<version>-win-x64-portable.zip   one BugDesk.exe and ui\, unzip and run

  It also publishes the framework-dependent app once, to report its size.

.PARAMETER Version
  Defaults to package.json's version. An MSI upgrade needs a higher one.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File desktop\build-windows.ps1
#>
param(
    [string]$Version,
    [string]$Runtime = "win-x64"
)
$ErrorActionPreference = "Stop"
$Repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$Project = Join-Path $Repo "desktop\BugDesk.Desktop\BugDesk.Desktop.csproj"
$Out = Join-Path $Repo "desktop\out"
if (-not $Version) { $Version = (Get-Content (Join-Path $Repo "package.json") -Raw | ConvertFrom-Json).version }
Write-Host "BugDesk $Version ($Runtime)"

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory $Out | Out-Null

# ui/ is served off disk, so it ships as files beside the executable. Source
# maps are for a developer's devtools, not for a packaged app.
function Copy-Ui([string]$dest) {
    $src = Join-Path $Repo "ui"
    robocopy $src (Join-Path $dest "ui") /E /XF *.map /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying ui/ failed ($LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}

function Publish([string]$dir, [string[]]$extra) {
    & dotnet publish $Project -c Release -r $Runtime -o $dir -p:Version=$Version -p:DebugType=none --nologo -v q @extra
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
}

# The MSI's contents: self-contained, as a folder.
$appDir = Join-Path $Out "publish\app"
Publish $appDir @("--self-contained")
Copy-Ui $appDir

# The portable build: one self-extracting executable (Photino's native
# libraries inside it) and ui\ beside it.
$portableDir = Join-Path $Out "publish\portable"
Publish $portableDir @("--self-contained", "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true",
                      "-p:EnableCompressionInSingleFile=true")
# The referenced server project leaves its own runtimeconfig behind; the
# single file does not read it.
Remove-Item (Join-Path $portableDir "BugDesk.Server.runtimeconfig.json") -ErrorAction SilentlyContinue
Copy-Ui $portableDir
$zip = Join-Path $Out "BugDesk-$Version-$Runtime-portable.zip"
# tar.exe (Windows 10 and later), not Compress-Archive: Windows PowerShell's
# writes backslashes into the entry names, which other unzippers keep literally.
& tar.exe -a -c -f $zip -C $portableDir *
if ($LASTEXITCODE -ne 0) { throw "zipping the portable build failed" }

# The MSI.
$wixproj = Join-Path $Repo "desktop\installer\BugDesk.Msi.wixproj"
& dotnet build $wixproj -c Release -p:Version=$Version -p:PublishDir=$appDir -o (Join-Path $Out "msi") --nologo -v q
if ($LASTEXITCODE -ne 0) { throw "the MSI build failed" }
$msi = Join-Path $Out "BugDesk-$Version-$Runtime.msi"
Move-Item (Join-Path $Out "msi\BugDesk.msi") $msi

# The framework-dependent app, for its size only (it needs .NET installed).
$fddDir = Join-Path $Out "publish\framework-dependent"
Publish $fddDir @("--no-self-contained")
$fddBytes = (Get-ChildItem $fddDir -Recurse -File | Measure-Object Length -Sum).Sum

function Mb($bytes) { "{0:N1} MB" -f ($bytes / 1MB) }
Write-Host ""
Write-Host "  $(Split-Path $msi -Leaf)  $(Mb (Get-Item $msi).Length)"
Write-Host "  $(Split-Path $zip -Leaf)  $(Mb (Get-Item $zip).Length)"
Write-Host "  framework-dependent app, without ui\: $(Mb $fddBytes)"
