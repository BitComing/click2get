param(
  [ValidateSet('hover-pencil', 'hover-delete', 'rename-full', 'rename-type', 'delete-full', 'dblclick')]
  [string]$Action = 'rename-full',
  [string]$Title = 'Renamed-Title-Test'
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class T2 {
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
  public static void Click() {
    mouse_event(0x0002,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004,0,0,0,IntPtr.Zero);
  }
}
"@

[T2]::SetProcessDPIAware() | Out-Null
$p = Get-Process click2get | Select-Object -First 1
$h = [T2]::Largest([uint32]$p.Id)
if ($h -eq [IntPtr]::Zero) { Write-Output "no visible window"; exit 1 }
[T2]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
# 先按一下 ALT 再 SetForegroundWindow，绕过"后台进程不许抢前台"的限制
[T2]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[T2]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
[T2]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900
$fgp = 0
[void][T2]::GetWindowThreadProcessId([T2]::GetForegroundWindow(), [ref]$fgp)
Write-Output ("foreground pid=" + $fgp + "  app pid=" + $p.Id)

$r = New-Object T2+RECT
[T2]::GetWindowRect($h, [ref]$r) | Out-Null

# 侧栏第一行（列表顶部）中心；两个图标贴右边界
$rowY = $r.Top + 196
$pencilX = $r.Left + 295
$trashX = $r.Left + 323

# 弹层按钮：窗口尺寸固定，按窗口内坐标算
$okX = $r.Left + 963
$okY = $r.Top + 631

switch ($Action) {
    'hover-pencil' {
        [T2]::SetCursorPos($pencilX, $rowY) | Out-Null
        Start-Sleep -Milliseconds 350
        [T2]::Click()
        Write-Output "clicked pencil"
    }
    'hover-delete' {
        [T2]::SetCursorPos($trashX, $rowY) | Out-Null
        Start-Sleep -Milliseconds 350
        [T2]::Click()
        Write-Output "clicked trash"
    }
    'dblclick' {
        [T2]::SetCursorPos(($r.Left + 120), $rowY) | Out-Null
        Start-Sleep -Milliseconds 300
        [T2]::Click()
        Start-Sleep -Milliseconds 80
        [T2]::Click()
        Write-Output "double clicked"
    }
    'rename-type' {
        [T2]::SetCursorPos($pencilX, $rowY) | Out-Null
        Start-Sleep -Milliseconds 350
        [T2]::Click()
        Start-Sleep -Milliseconds 800
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait($Title)
        Start-Sleep -Milliseconds 400
        Write-Output 'typed only'
    }
    'rename-full' {
        [T2]::SetCursorPos($pencilX, $rowY) | Out-Null
        Start-Sleep -Milliseconds 350
        [T2]::Click()
        Start-Sleep -Milliseconds 800
        [System.Windows.Forms.SendKeys]::SendWait('^a')
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait($Title)
        Start-Sleep -Milliseconds 300
        [T2]::SetCursorPos($okX, $okY) | Out-Null
        Start-Sleep -Milliseconds 250
        [T2]::Click()
        Write-Output "rename-full done"
    }
    'delete-full' {
        [T2]::SetCursorPos($trashX, $rowY) | Out-Null
        Start-Sleep -Milliseconds 350
        [T2]::Click()
        Start-Sleep -Milliseconds 800
        [T2]::SetCursorPos($okX, $okY) | Out-Null
        Start-Sleep -Milliseconds 250
        [T2]::Click()
        Write-Output "delete-full done"
    }
}