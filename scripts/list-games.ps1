# list-games.ps1 -- list visible, game-like windows: "process<TAB>title<TAB>WxH"
#
# Skips system shells, the desktop-pet itself and tiny/utility windows, so the result is
# usually just the game(s) you have open. ASCII-only on purpose: Windows PowerShell 5.1
# mis-parses scripts that contain non-ASCII text when saved without a BOM.

$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$skip = @(
  'Cortico', 'Coopanion', 'explorer', 'ApplicationFrameHost',
  'SearchHost', 'ShellExperienceHost', 'TextInputHost', 'StartMenuExperienceHost',
  'SystemSettings', 'steamwebhelper', 'msedge', 'chrome', 'firefox'
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ListWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
"@

$script:rows = @()
$cb = [ListWin+EnumProc]{
    param($h, $l)
    if (-not ([ListWin]::IsWindowVisible($h) -and -not [ListWin]::IsIconic($h))) { return $true }
    $len = [ListWin]::GetWindowTextLength($h)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][ListWin]::GetWindowText($h, $sb, $sb.Capacity)
    $title = $sb.ToString()
    $r = New-Object ListWin+RECT
    if (-not [ListWin]::GetWindowRect($h, [ref]$r)) { return $true }
    $w = $r.R - $r.L
    $hgt = $r.B - $r.T
    if ($w -lt 400 -or $hgt -lt 300) { return $true }
    $procId = 0
    [void][ListWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    if (-not $proc) { return $true }
    if ($skip -contains $proc) { return $true }
    if ($title -like '*Cortico*' -or $title -like '*Coopanion*' -or $title -like '*DeepSeek Harness*') { return $true }
    $script:rows += [pscustomobject]@{ Proc = $proc; Title = $title; W = $w; H = $hgt; Area = ($w * $hgt) }
    return $true
}
[void][ListWin]::EnumWindows($cb, [IntPtr]::Zero)

$seen = @{}
foreach ($row in ($script:rows | Sort-Object Area -Descending)) {
    $key = $row.Proc + '|' + $row.Title
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    Write-Output ($row.Proc + "`t" + $row.Title + "`t" + $row.W + "x" + $row.H)
}
