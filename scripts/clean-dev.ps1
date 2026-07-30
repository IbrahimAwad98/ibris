# Reclaims disk space from build artifacts and caches created by Ibris
# development.
#
#   powershell -File scripts/clean-dev.ps1              # dry run (default)
#   powershell -File scripts/clean-dev.ps1 -Force       # delete safe targets
#   powershell -File scripts/clean-dev.ps1 -All         # dry run incl. high-risk
#   powershell -File scripts/clean-dev.ps1 -Force -All  # delete everything listed
#
# Never touches: git-tracked files, .git, source files, src-tauri/pdfium
# (re-fetching needs network), the Rust toolchain, VS Build Tools, or
# anything under Program Files. Every target is validated to look like what
# it claims to be before removal; anything surprising is skipped with a
# warning rather than guessed at.

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$All
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent

function Get-DirSizeMB([string]$Path) {
    if (-not (Test-Path $Path)) { return 0 }
    $bytes = (Get-ChildItem $Path -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
    if ($null -eq $bytes) { $bytes = 0 }
    [math]::Round($bytes / 1MB, 1)
}

function Get-FreeGB([string]$Drive) {
    $d = Get-PSDrive $Drive -ErrorAction SilentlyContinue
    if ($d) { [math]::Round($d.Free / 1GB, 1) } else { 0 }
}

function Test-GitIgnored([string]$Path) {
    # True when git confirms the path is ignored (never tracked content).
    Push-Location $RepoRoot
    try {
        git check-ignore -q -- $Path 2>$null
        return ($LASTEXITCODE -eq 0)
    } finally { Pop-Location }
}

# --- Target definitions -----------------------------------------------------
# Validate blocks return $true only when the path looks like what the target
# claims to be. A failed validation skips the target with a warning.

$targets = @(
    [pscustomobject]@{
        Name     = 'Rust build directory (D:\cargo-target)'
        Path     = 'D:\cargo-target'
        Risk     = 'safe'
        Rebuild  = 'next cargo build recompiles everything (~5-10 min)'
        Validate = {
            # Cargo marks its output dir with CACHEDIR.TAG.
            (Test-Path 'D:\cargo-target\CACHEDIR.TAG') -or
            (Test-Path 'D:\cargo-target\debug') -or
            (Test-Path 'D:\cargo-target\release')
        }
    }
    [pscustomobject]@{
        Name     = 'Vite cache (node_modules\.vite)'
        Path     = (Join-Path $RepoRoot 'node_modules\.vite')
        Risk     = 'safe'
        Rebuild  = 'vite re-optimises dependencies on next dev start (seconds)'
        Validate = { Test-Path (Join-Path $RepoRoot 'node_modules\.vite') }
    }
    [pscustomobject]@{
        Name     = 'Frontend build output (dist)'
        Path     = (Join-Path $RepoRoot 'dist')
        Risk     = 'safe'
        Rebuild  = 'npm run build recreates it (~1 min)'
        Validate = { Test-GitIgnored 'dist' }
    }
    [pscustomobject]@{
        Name     = 'Leftover repo target dir (src-tauri\target)'
        Path     = (Join-Path $RepoRoot 'src-tauri\target')
        Risk     = 'safe'
        Rebuild  = 'nothing - builds go to CARGO_TARGET_DIR now'
        Validate = {
            (Test-GitIgnored 'src-tauri/target') -and (
                (Test-Path (Join-Path $RepoRoot 'src-tauri\target\CACHEDIR.TAG')) -or
                (Test-Path (Join-Path $RepoRoot 'src-tauri\target\debug'))
            )
        }
    }
    [pscustomobject]@{
        Name     = 'Stale clone-verification folder (D:\temp\clone-test)'
        Path     = 'D:\temp\clone-test'
        Risk     = 'safe'
        Rebuild  = 'nothing - throwaway verification clone'
        Validate = {
            # Must actually be an ibris clone, not something else that
            # happens to sit at that path.
            (Test-Path 'D:\temp\clone-test\.git') -and
            (Test-Path 'D:\temp\clone-test\CLAUDE.md')
        }
    }
    [pscustomobject]@{
        Name     = 'Cargo registry cache (~\.cargo\registry)'
        Path     = (Join-Path $env:USERPROFILE '.cargo\registry')
        Risk     = 'high'
        Rebuild  = 'every Rust project on this machine re-downloads its crates'
        Validate = {
            $reg = Join-Path $env:USERPROFILE '.cargo\registry'
            (Test-Path (Join-Path $reg 'cache')) -or (Test-Path (Join-Path $reg 'index'))
        }
    }
    [pscustomobject]@{
        Name     = 'npm cache'
        Path     = (npm config get cache 2>$null)
        Risk     = 'high'
        Rebuild  = 'npm re-downloads packages on next install, all projects'
        Validate = {
            $c = npm config get cache 2>$null
            $c -and (Test-Path (Join-Path $c '_cacache'))
        }
    }
    [pscustomobject]@{
        Name     = 'node_modules'
        Path     = (Join-Path $RepoRoot 'node_modules')
        Risk     = 'high'
        Rebuild  = 'npm install restores it (~2-3 min)'
        Validate = {
            (Test-Path (Join-Path $RepoRoot 'package.json')) -and
            (Test-GitIgnored 'node_modules')
        }
    }
)

# --- Run --------------------------------------------------------------------

$freeCBefore = Get-FreeGB 'C'
$freeDBefore = Get-FreeGB 'D'
$mode = if ($Force) { 'DELETING' } else { 'DRY RUN - nothing will be deleted' }
Write-Host "clean-dev: $mode"
Write-Host ("Free space before:  C: {0} GB   D: {1} GB" -f $freeCBefore, $freeDBefore)
Write-Host ""

$rows = @()
$totalFreedMB = 0.0

foreach ($t in $targets) {
    $inScope = ($t.Risk -eq 'safe') -or $All
    $exists = $t.Path -and (Test-Path $t.Path)

    if (-not $inScope) {
        if ($exists) {
            $rows += [pscustomobject]@{
                Target = $t.Name; SizeMB = '?'; Action = 'skipped (needs -All)'
            }
        }
        continue
    }
    if (-not $exists) {
        $rows += [pscustomobject]@{ Target = $t.Name; SizeMB = 0; Action = 'not present' }
        continue
    }

    $valid = & $t.Validate
    if (-not $valid) {
        Write-Warning "$($t.Name): path exists but does not look like what it claims to be - refusing to touch it."
        $rows += [pscustomobject]@{ Target = $t.Name; SizeMB = '?'; Action = 'REFUSED (validation failed)' }
        continue
    }

    $size = Get-DirSizeMB $t.Path
    if ($Force) {
        Remove-Item $t.Path -Recurse -Force -Confirm:$false
        $totalFreedMB += $size
        $action = "deleted ($($t.Rebuild))"
    } else {
        $action = "would delete ($($t.Rebuild))"
    }
    $rows += [pscustomobject]@{ Target = $t.Name; SizeMB = $size; Action = $action }
}

# Informational: other entries in D:\temp are reported, never touched.
if (Test-Path 'D:\temp') {
    $other = Get-ChildItem 'D:\temp' -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ne 'D:\temp\clone-test' }
    foreach ($o in $other) {
        $rows += [pscustomobject]@{
            Target = "D:\temp\$($o.Name) (not a known target)"
            SizeMB = Get-DirSizeMB $o.FullName
            Action = 'report only - review by hand'
        }
    }
}

$rows | Format-Table -AutoSize | Out-String | Write-Host

if ($Force) {
    $freeCAfter = Get-FreeGB 'C'
    $freeDAfter = Get-FreeGB 'D'
    Write-Host ("Free space after:   C: {0} GB   D: {1} GB" -f $freeCAfter, $freeDAfter)
    Write-Host ("Freed: {0} GB (C: +{1} GB, D: +{2} GB)" -f `
        [math]::Round($totalFreedMB / 1024, 2),
        [math]::Round($freeCAfter - $freeCBefore, 1),
        [math]::Round($freeDAfter - $freeDBefore, 1))
} else {
    $wouldGB = [math]::Round((($rows | Where-Object { $_.SizeMB -is [double] -and $_.Action -like 'would delete*' } |
        Measure-Object SizeMB -Sum).Sum) / 1024, 2)
    Write-Host "Would free approximately $wouldGB GB. Re-run with -Force to delete."
    if (-not $All) {
        Write-Host "High-risk targets (cargo registry, npm cache, node_modules) need -All."
    }
}

