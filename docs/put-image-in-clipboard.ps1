# 把一张测试图片放进剪贴板（需要 STA 线程，用 powershell.exe -STA 跑）
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$bmp = New-Object System.Drawing.Bitmap 420, 220
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::FromArgb(22, 22, 26))
$font = New-Object System.Drawing.Font 'Segoe UI', 22, ([System.Drawing.FontStyle]::Bold)
$small = New-Object System.Drawing.Font 'Segoe UI', 11
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(91, 140, 255))
$dim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(160, 160, 168))
$g.DrawString('Click2Get', $font, $brush, 26, 62)
$g.DrawString('clipboard image capture test', $small, $dim, 28, 118)
$g.Dispose()

for ($i = 0; $i -lt 10; $i++) {
    try {
        [System.Windows.Forms.Clipboard]::SetImage($bmp)
        Write-Output "setImage ok on attempt $($i + 1)"
        break
    } catch {
        Start-Sleep -Milliseconds 120
        if ($i -eq 9) { Write-Output "setImage failed: $($_.Exception.Message)" }
    }
}
$bmp.Dispose()