# Captures the Ibris window to a PNG. ASCII only (repo rule).
# Usage: powershell -File scripts/capture-window.ps1 -Out shots/foo.png
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$ProcessName = "ibris"
)

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ShotNative {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

[void][ShotNative]::SetProcessDPIAware()

# Match by PROCESS NAME only. A title-prefix match once captured an
# unrelated application whose window title happened to start the same
# way; never do that again.
$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
    Write-Error "No running process named '$ProcessName' with a window."
    exit 1
}

$hwnd = $proc.MainWindowHandle
$rect = New-Object ShotNative+RECT
[void][ShotNative]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Error "Degenerate window rect."; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
# 2 = PW_RENDERFULLCONTENT, required for WebView2 surfaces.
$ok = [ShotNative]::PrintWindow($hwnd, $hdc, 2)
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()
if (-not $ok) { Write-Error "PrintWindow failed."; exit 1 }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force $dir | Out-Null
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured $Out ($w x $h)"
