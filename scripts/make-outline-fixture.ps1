# Regenerates tests/fixtures/outline.pdf: 5 pages of plain text with a
# 3-entry outline (one entry nested). Hand-built with computed xref offsets,
# deterministic output. Usage: powershell -File scripts/make-outline-fixture.ps1

$ErrorActionPreference = 'Stop'

$PageCount = 5
# Object layout:
#   1 catalog, 2 pages tree, 3 font,
#   per page i (1-based): 2+2i page obj, 3+2i content obj  (4..13)
#   outline: 14 root, 15 "Introduction" (->p1), 16 "Chapter One" (->p2),
#            17 "Section 1.1" (->p3, child of 16), 18 "Appendix" (->p5)
$objs = New-Object System.Collections.Generic.List[string]
$kids = (1..$PageCount | ForEach-Object { "$(2 + 2*$_) 0 R" }) -join ' '
$objs.Add("1 0 obj`n<< /Type /Catalog /Pages 2 0 R /Outlines 14 0 R >>`nendobj`n")
$objs.Add("2 0 obj`n<< /Type /Pages /Kids [$kids] /Count $PageCount >>`nendobj`n")
$objs.Add("3 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj`n")

$words = @('alpha bravo', 'charlie delta', 'echo foxtrot', 'golf hotel', 'india juliet')
for ($i = 1; $i -le $PageCount; $i++) {
    $pageObj = 2 + 2*$i
    $contentObj = 3 + 2*$i
    $stream = "BT`n/F1 24 Tf`n72 700 Td`n(Outline fixture page $i) Tj`n0 -36 Td`n($($words[$i-1])) Tj`nET"
    $objs.Add("$pageObj 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents $contentObj 0 R >>`nendobj`n")
    $objs.Add("$contentObj 0 obj`n<< /Length $($stream.Length) >>`nstream`n$stream`nendstream`nendobj`n")
}

$objs.Add("14 0 obj`n<< /Type /Outlines /First 15 0 R /Last 18 0 R /Count 4 >>`nendobj`n")
$objs.Add("15 0 obj`n<< /Title (Introduction) /Parent 14 0 R /Next 16 0 R /Dest [4 0 R /XYZ null null null] >>`nendobj`n")
$objs.Add("16 0 obj`n<< /Title (Chapter One) /Parent 14 0 R /Prev 15 0 R /Next 18 0 R /First 17 0 R /Last 17 0 R /Count 1 /Dest [6 0 R /XYZ null null null] >>`nendobj`n")
$objs.Add("17 0 obj`n<< /Title (Section 1.1) /Parent 16 0 R /Dest [8 0 R /XYZ null null null] >>`nendobj`n")
$objs.Add("18 0 obj`n<< /Title (Appendix) /Parent 14 0 R /Prev 16 0 R /Dest [12 0 R /XYZ null null null] >>`nendobj`n")

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

$dest = Join-Path $PSScriptRoot '..\src-tauri\tests\fixtures\outline.pdf'
[IO.File]::WriteAllBytes($dest, [Text.Encoding]::ASCII.GetBytes($header + $sb.ToString() + $xref + $trailer))
Write-Host "wrote $dest ($((Get-Item $dest).Length) bytes)"
