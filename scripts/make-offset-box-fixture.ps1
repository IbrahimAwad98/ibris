# Regenerates tests/fixtures/offset-mediabox.pdf: one page whose MediaBox
# origin is (50, 100) instead of (0, 0). Text coordinates are absolute page
# space, so any code that assumes a zero origin misplaces geometry by
# exactly (50, 100) points — the class of bug this fixture exists to catch.
# Usage: powershell -File scripts/make-offset-box-fixture.ps1

$ErrorActionPreference = 'Stop'

# MediaBox [50 100 662 892]: visible area is still 612x792pt.
# Text at absolute (122, 800) = (72, 92) relative to the box origin,
# i.e. the same place on paper as the plain-text fixture's first line.
$stream = "BT`n/F1 24 Tf`n122 800 Td`n(Offset box fixture line one) Tj`n0 -36 Td`n(a person appears on this page) Tj`nET"

$objs = @(
  "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n",
  "2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj`n",
  "3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [50 100 662 892] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`nendobj`n",
  "4 0 obj`n<< /Length $($stream.Length) >>`nstream`n$stream`nendstream`nendobj`n",
  "5 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj`n"
)

$header = "%PDF-1.4`n"
$body = ""
$offsets = @()
foreach ($o in $objs) { $offsets += ($header.Length + $body.Length); $body += $o }
$xrefPos = $header.Length + $body.Length
$xref = "xref`n0 6`n0000000000 65535 f `n"
foreach ($off in $offsets) { $xref += ("{0:D10} 00000 n `n" -f $off) }
$trailer = "trailer`n<< /Size 6 /Root 1 0 R >>`nstartxref`n$xrefPos`n%%EOF`n"

$dest = Join-Path $PSScriptRoot '..\src-tauri\tests\fixtures\offset-mediabox.pdf'
[IO.File]::WriteAllBytes($dest, [Text.Encoding]::ASCII.GetBytes($header + $body + $xref + $trailer))
Write-Host "wrote $dest ($((Get-Item $dest).Length) bytes)"
