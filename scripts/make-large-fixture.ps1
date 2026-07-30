# Regenerates tests/fixtures/large-300-pages.pdf: a minimal, valid PDF with
# $PageCount pages of plain Helvetica text, built by hand with computed xref
# offsets. Deterministic — same input, byte-identical output.
#
# Usage:  powershell -File scripts/make-large-fixture.ps1

param([int]$PageCount = 300)

$ErrorActionPreference = 'Stop'

# Object layout: 1=catalog, 2=pages, 3=font, then per page i (1-based):
# obj 2+2i = page, obj 3+2i = content stream.
$objs = New-Object System.Collections.Generic.List[string]
$kids = (1..$PageCount | ForEach-Object { "$(2 + 2*$_) 0 R" }) -join ' '
$objs.Add("1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n")
$objs.Add("2 0 obj`n<< /Type /Pages /Kids [$kids] /Count $PageCount >>`nendobj`n")
$objs.Add("3 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj`n")

for ($i = 1; $i -le $PageCount; $i++) {
    $pageObj = 2 + 2*$i
    $contentObj = 3 + 2*$i
    $stream = "BT`n/F1 24 Tf`n72 700 Td`n(Page $i of $PageCount) Tj`n0 -36 Td`n(The quick brown fox jumps over the lazy dog.) Tj`nET"
    $objs.Add("$pageObj 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents $contentObj 0 R >>`nendobj`n")
    $objs.Add("$contentObj 0 obj`n<< /Length $($stream.Length) >>`nstream`n$stream`nendstream`nendobj`n")
}

$header = "%PDF-1.4`n"
$sb = New-Object System.Text.StringBuilder
$offsets = New-Object System.Collections.Generic.List[int]
foreach ($o in $objs) {
    $offsets.Add($header.Length + $sb.Length) | Out-Null
    [void]$sb.Append($o)
}
$count = $objs.Count + 1
$xrefPos = $header.Length + $sb.Length
$xref = "xref`n0 $count`n0000000000 65535 f `n"
foreach ($off in $offsets) { $xref += ("{0:D10} 00000 n `n" -f $off) }
$trailer = "trailer`n<< /Size $count /Root 1 0 R >>`nstartxref`n$xrefPos`n%%EOF`n"

$dest = Join-Path $PSScriptRoot '..\src-tauri\tests\fixtures\large-300-pages.pdf'
[IO.File]::WriteAllBytes($dest, [Text.Encoding]::ASCII.GetBytes($header + $sb.ToString() + $xref + $trailer))
Write-Host "wrote $dest ($((Get-Item $dest).Length) bytes, $PageCount pages)"
