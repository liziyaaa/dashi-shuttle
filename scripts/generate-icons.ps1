Add-Type -AssemblyName System.Drawing
$taskIconDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'icons'
function New-ShuttleIcon([int]$size, [string]$name) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#007aff'))
  $scale = $size / 64.0
  $graphics.ScaleTransform($scale, $scale)
  $light = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#ffffff'))
  $dark = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#007aff'))
  $graphics.FillRectangle($light, 18, 18, 28, 28)
  $graphics.FillEllipse($light, 18, 13, 10, 10)
  $graphics.FillEllipse($light, 36, 13, 10, 10)
  $graphics.FillRectangle($light, 23, 13, 18, 9)
  $graphics.FillRectangle($dark, 23, 21, 18, 13)
  $graphics.FillEllipse($dark, 23, 38, 4, 4)
  $graphics.FillEllipse($dark, 37, 38, 4, 4)
  $graphics.FillRectangle($light, 21, 44, 5, 7)
  $graphics.FillRectangle($light, 38, 44, 5, 7)
  $bitmap.Save((Join-Path $taskIconDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose(); $light.Dispose(); $dark.Dispose()
}
New-ShuttleIcon 192 'icon-192.png'
New-ShuttleIcon 512 'icon-512.png'
New-ShuttleIcon 512 'maskable-512.png'
New-ShuttleIcon 180 'apple-touch-icon.png'
