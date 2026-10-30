param([switch]$Quiet)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class T1 {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static IntPtr Largest(uint targetPid) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      long a = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (a > bestArea) { bestArea = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@

[T1]::SetProcessDPIAware() | Out-Null
$p = Get-Process click2get | Select-Object -First 1
$h = [T1]::Largest([uint32]$p.Id)
if ($h -eq [IntPtr]::Zero) { Write-Output "no visible window"; exit 1 }

[T1]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
[T1]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800

$r = New-Object T1+RECT
[T1]::GetWindowRect($h, [ref]$r) | Out-Null

# 点进编辑区（右侧正文区中点）
$cx = $r.Left + [int](($r.Right - $r.Left) * 0.6)
$cy = $r.Top + [int](($r.Bottom - $r.Top) * 0.45)
[T1]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 200
[T1]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[T1]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400

# Ctrl+A
[T1]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[T1]::keybd_event(0x41, 0, 0, [UIntPtr]::Zero)
[T1]::keybd_event(0x41, 0, 2, [UIntPtr]::Zero)
[T1]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250

# Ctrl+C
[T1]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[T1]::keybd_event(0x43, 0, 0, [UIntPtr]::Zero)
[T1]::keybd_event(0x43, 0, 2, [UIntPtr]::Zero)
[T1]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 600

# 取消选择，避免留下全选状态
[T1]::keybd_event(0x27, 0, 0, [UIntPtr]::Zero)
[T1]::keybd_event(0x27, 0, 2, [UIntPtr]::Zero)
Write-Output "ran click + ctrl+a + ctrl+c inside editor"