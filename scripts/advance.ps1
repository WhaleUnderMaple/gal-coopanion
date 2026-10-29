# advance.ps1 -- send background clicks to a game window (PostMessage, no focus steal).
#
# Most visual-novel engines accept WM_LBUTTONDOWN/UP posted to the window even while it
# sits behind other windows, which lets a companion click "next" without taking focus.
#
# Usage:
#   powershell -File advance.ps1 -Process YourGame -Clicks 3 -Delay 900
#   (env fallbacks: GAL_PROC / GAL_CLICKS / GAL_DELAY)
#
# Output: proc=... / target=... / click N sent ... / DONE | NOPROC
param(
  [string]$Process = $env:GAL_PROC,
  [int]$Clicks = 1,
  [int]$Delay = 900
)
if ($env:GAL_CLICKS) { $Clicks = [int]$env:GAL_CLICKS }
if ($env:GAL_DELAY) { $Delay = [int]$env:GAL_DELAY }
if (-not $Process) { Write-Output 'NOPROC'; exit 0 }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GameClick {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

$WM_MOUSEMOVE = 0x0200
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202

function Get-LParam([int]$x, [int]$y) {
  return [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
}

$p = Get-Process -Name $Process -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NOPROC'; exit 0 }
$hwnd = $p.MainWindowHandle

# Many engines render in a big child window; posting there is more reliable.
$script:bestChild = [IntPtr]::Zero
$script:bestArea = 0
$cb = [GameClick+EnumProc]{
  param($h, $l)
  if (-not [GameClick]::IsWindowVisible($h)) { return $true }
  $r = New-Object GameClick+RECT
  if (-not [GameClick]::GetWindowRect($h, [ref]$r)) { return $true }
  $a = ($r.R - $r.L) * ($r.B - $r.T)
  if ($a -gt $script:bestArea) { $script:bestArea = $a; $script:bestChild = $h }
  return $true
}
[void][GameClick]::EnumChildWindows($hwnd, $cb, [IntPtr]::Zero)

$target = $hwnd
if ($script:bestChild -ne [IntPtr]::Zero -and $script:bestArea -gt 10000) { $target = $script:bestChild }

$cr = New-Object GameClick+RECT
[void][GameClick]::GetClientRect($target, [ref]$cr)
$cx = [int](($cr.R - $cr.L) / 2)
$cy = [int](($cr.B - $cr.T) / 2)

$fg = [GameClick]::GetForegroundWindow()
Write-Output ("proc=" + $Process + " target=" + $target.ToInt64() + " foreground_same=" + ($fg -eq $hwnd) +
              " client=" + ($cr.R - $cr.L) + "x" + ($cr.B - $cr.T))

for ($i = 1; $i -le $Clicks; $i++) {
  $lp = Get-LParam $cx $cy
  [void][GameClick]::PostMessage($target, $WM_MOUSEMOVE, [IntPtr]::Zero, $lp)
  [void][GameClick]::PostMessage($target, $WM_LBUTTONDOWN, [IntPtr]1, $lp)
  Start-Sleep -Milliseconds 40
  [void][GameClick]::PostMessage($target, $WM_LBUTTONUP, [IntPtr]::Zero, $lp)
  Write-Output ("click " + $i + " sent")
  Start-Sleep -Milliseconds $Delay
}

Write-Output 'DONE'
