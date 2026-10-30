param([string]$Out = "C:\Users\Alpha\WorkBuddy\click2get\docs\verify-shot.png", [switch]$Hide)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W5 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# 必须先声明 DPI 感知，否则 GetWindowRect 返回的是被虚拟化的逻辑坐标，
# 截出来的图会比实际渲染小一圈，右侧和底部被裁掉。
[W5]::SetProcessDPIAware() | Out-Null

$p = Get-Process click2get -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
     Select-Object -First 1
if (-not $p) { Write-Output "no main window"; exit 1 }
$h = $p.MainWindowHandle

if ($Hide) { [W5]::ShowWindow($h, 0) | Out-Null; Write-Output "hidden"; exit 0 }

if ([W5]::IsIconic($h)) { [W5]::ShowWindow($h, 9) | Out-Null }
[W5]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
Start-Sleep -Milliseconds 900

$r = New-Object W5+RECT
[W5]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [W5]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $Out ${w}x${hh} printwindow=$ok"

[W5]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null