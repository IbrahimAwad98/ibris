# Downloads the PDFium binary used by Ibris on Windows.
# Reproducible: pinned to an exact release of bblanchon/pdfium-binaries.
# See docs/PDFIUM.md for where the binary lives and how it is loaded.
#
# Usage:  powershell -File scripts/get-pdfium.ps1

$ErrorActionPreference = 'Stop'

# Pinned release. Bump deliberately; rendering output can change between versions.
$Release = 'chromium/7961'
$Asset = 'pdfium-win-x64.tgz'   # non-V8 build: no JavaScript engine

$Url = "https://github.com/bblanchon/pdfium-binaries/releases/download/$($Release -replace '/', '%2F')/$Asset"
$DestDir = Join-Path $PSScriptRoot '..\src-tauri\pdfium'
$Archive = Join-Path $env:TEMP $Asset

Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $Archive

$Extract = Join-Path $env:TEMP 'pdfium-extract'
if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
New-Item -ItemType Directory -Force $Extract | Out-Null
tar -xzf $Archive -C $Extract

New-Item -ItemType Directory -Force $DestDir | Out-Null
Copy-Item (Join-Path $Extract 'bin\pdfium.dll') $DestDir -Force
Copy-Item (Join-Path $Extract 'LICENSE') (Join-Path $DestDir 'PDFIUM-LICENSE') -Force

Remove-Item $Archive
Remove-Item -Recurse -Force $Extract

Write-Host "pdfium.dll ($Release) installed to $((Resolve-Path $DestDir).Path)"
