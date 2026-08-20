<#
.SYNOPSIS
    Run tools/convert_seabed.py without having to know where Blender is.

.DESCRIPTION
    Blender does not put itself on PATH on Windows, so `blender.exe ...` fails with
    "The term 'blender.exe' is not recognized". And convert_seabed.py takes paths
    relative to the project root, so it has to be run from there rather than from
    wherever the sculpt happens to live. This wrapper handles both: it finds Blender,
    switches to the project root, and forwards everything you pass it to the script.

.EXAMPLE
    .\tools\convert-seabed.ps1 --in "..\..\Models\TectonicSeabed.blend" --object Mesher_LOD1.002 --shape-from modifiers --vgroup VentSwell

.EXAMPLE
    # override the Blender it picks
    $env:BLENDER = "D:\Blender\blender.exe"; .\tools\convert-seabed.ps1
#>

$ErrorActionPreference = 'Stop'

function Find-Blender {
    if ($env:BLENDER -and (Test-Path $env:BLENDER)) { return $env:BLENDER }

    $onPath = Get-Command blender.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    # Newest first, so a machine with several versions uses the current one.
    $roots = @(
        "$env:ProgramFiles\Blender Foundation",
        "${env:ProgramFiles(x86)}\Blender Foundation",
        "$env:LOCALAPPDATA\Programs\Blender Foundation"
    ) | Where-Object { Test-Path $_ }

    $found = foreach ($root in $roots) {
        Get-ChildItem -Path $root -Filter blender.exe -Recurse -ErrorAction SilentlyContinue
    }
    $best = $found | Sort-Object { $_.VersionInfo.ProductVersion } -Descending | Select-Object -First 1
    if ($best) { return $best.FullName }

    throw "Could not find blender.exe. Install Blender, or set `$env:BLENDER to its full path."
}

$blender = Find-Blender
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'convert_seabed.py'

Write-Host "blender : $blender"
Write-Host "project : $root"
Write-Host ""

Push-Location $root
try {
    # `--` separates Blender's own arguments from the script's. Everything after it
    # goes to convert_seabed.py untouched.
    & $blender -b --factory-startup -noaudio -P $script -- @args
    if ($LASTEXITCODE -ne 0) { throw "Blender exited with code $LASTEXITCODE" }
} finally {
    Pop-Location
}
