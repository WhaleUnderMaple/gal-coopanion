# capture-window.ps1 -- grab a window's pixels without stealing focus.
#
# Handles the three annoying cases:
#   * window minimized / hidden  -> SW_SHOWNOACTIVATE, capture, then minimize back
#   * only partly painted after restore -> force repaint + retry (blank frames rejected)
#   * DirectX content -> PrintWindow(..., 2) (PW_RENDERFULLCONTENT)
#
# Usage:
#   powershell -File capture-window.ps1 -Process YourGame -Out D:\shots\a.png
#   (env fallbacks: GAL_PROC / GAL_OUT)
#
# Output (last line): OK <w>x<h> restored=<bool> tries=<n> | NOPROC | BADSIZE <w>x<h> | PRINTFAIL <w>x<h>
param(
  [string]$Process = $env:GAL_PROC,
  [string]$Out = $env:GAL_OUT
)
if (-not $Process) { Write-Output 'BADSIZE 0x0'; exit 0 }
if (-not $Out) { $Out = Join-Path $env:TEMP 'capture-window.png' }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
  [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool erase);
  [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr rgn, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
}
"@

$SW_SHOWNOACTIVATE = 4
$SW_MINIMIZE = 6
$RDW_INVALIDATE = 0x0001
$RDW_ALLCHILDREN = 0x0080
$RDW_UPDATENOW = 0x0100

$p = Get-Process -Name $Process -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NOPROC'; exit 0 }
$h = $p.MainWindowHandle

$wasIconic = [WCap]::IsIconic($h)
if ($wasIconic) {
    [void][WCap]::ShowWindow($h, $SW_SHOWNOACTIVATE)
    Start-Sleep -Milliseconds 500
}

$r = New-Object WCap+RECT
[void][WCap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$hh = $r.B - $r.T

if ($w -lt 200 -or $hh -lt 150) {
    $wp = New-Object WCap+WINDOWPLACEMENT
    $wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)
    if ([WCap]::GetWindowPlacement($h, [ref]$wp)) {
        $w = $wp.rcNormalPosition.R - $wp.rcNormalPosition.L
        $hh = $wp.rcNormalPosition.B - $wp.rcNormalPosition.T
    }
}

if ($w -lt 200 -or $hh -lt 150) {
    if ($wasIconic) { [void][WCap]::ShowWindow($h, $SW_MINIMIZE) }
    Write-Output ('BADSIZE ' + $w + 'x' + $hh)
    exit 0
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

# 纯色/半成品 PNG 体积很小；用面积估算一个下限
$minBytes = [int]($w * $hh * 0.06)
$ok = $false
$tries = 0

for ($i = 1; $i -le 3; $i++) {
    $tries = $i
    [void][WCap]::RedrawWindow($h, [IntPtr]::Zero, [IntPtr]::Zero,
        ($RDW_INVALIDATE -bor $RDW_ALLCHILDREN -bor $RDW_UPDATENOW))
    [void][WCap]::InvalidateRect($h, [IntPtr]::Zero, $false)
    [void][WCap]::UpdateWindow($h)
    Start-Sleep -Milliseconds 350

    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $dc = $g.GetHdc()
    $printed = [WCap]::PrintWindow($h, $dc, 2)
    $g.ReleaseHdc($dc); $g.Dispose()

    if ($printed) {
        $tmp = $Out + '.try' + $i + '.png'
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        if ((Get-Item $tmp).Length -ge $minBytes) {
            Move-Item -Force $tmp $Out
            $ok = $true
            $bmp.Dispose()
            break
        }
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
    $bmp.Dispose()
    Start-Sleep -Milliseconds 300
}

if ($wasIconic) { [void][WCap]::ShowWindow($h, $SW_MINIMIZE) }

if ($ok) { Write-Output ('OK ' + $w + 'x' + $hh + ' restored=' + $wasIconic + ' tries=' + $tries) }
else { Write-Output ('PRINTFAIL ' + $w + 'x' + $hh) }
