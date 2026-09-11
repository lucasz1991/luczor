[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$fixturePath = Join-Path ([System.IO.Path]::GetTempPath()) ('luczor-ocr-' + [guid]::NewGuid() + '.png')
$bitmap = New-Object System.Drawing.Bitmap 600, 100
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font 'Arial', 32
$previousFixture = $env:LUCZOR_OCR_TEST_FIXTURE
try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.DrawString('LUCZOR TEST 123', $font, [System.Drawing.Brushes]::Black, 12, 20)
    $bitmap.Save($fixturePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $env:LUCZOR_OCR_TEST_FIXTURE = $fixturePath
    & cargo test --manifest-path (Join-Path $PSScriptRoot '../src-tauri/Cargo.toml') --lib native_synthetic_ocr_smoke -- --ignored --nocapture
    if ($LASTEXITCODE -ne 0) { throw 'Native OCR probe failed.' }
} finally {
    $font.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    $env:LUCZOR_OCR_TEST_FIXTURE = $previousFixture
    if (Test-Path -LiteralPath $fixturePath) { Remove-Item -LiteralPath $fixturePath }
}
