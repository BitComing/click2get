param([string]$Out = "C:\Users\Alpha\WorkBuddy\click2get\docs\screen.png")

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Scr {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[Scr]::SetProcessDPIAware() | Out-Null

$p = Get-Process click2get | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
$h = $p.MainWindowHandle
$r = New-Object Scr+RECT
[Scr]::GetWindowRect($h, [ref]$r) | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output "window rect = $($r.Left),$($r.Top) - $($r.Right),$($r.Bottom)"
Write-Output "screen = $($b.Width)x$($b.Height)"

$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $Out"