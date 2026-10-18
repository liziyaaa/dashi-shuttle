param([string]$Source)
Add-Type -AssemblyName System.Drawing
$taskIconDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'icons'
if (-not $Source) { $Source = Join-Path $taskIconDir 'icon-512.png' }
# Read into memory first, so the source icon can also be overwritten safely.
$taskImageBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Source))
$taskImageStream = New-Object System.IO.MemoryStream(,$taskImageBytes)
$taskImage = [System.Drawing.Image]::FromStream($taskImageStream)
function Export-ShuttleIcon([int]$size, [string]$name) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($taskImage, 0, 0, $size, $size)
  $bitmap.Save((Join-Path $taskIconDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}
Export-ShuttleIcon 192 'icon-192.png'
Export-ShuttleIcon 512 'icon-512.png'
Export-ShuttleIcon 512 'maskable-512.png'
Export-ShuttleIcon 180 'apple-touch-icon.png'
$taskImage.Dispose(); $taskImageStream.Dispose()
