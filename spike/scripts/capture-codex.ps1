# Purpose: P3 — capture only the Codex Desktop window to a PNG for UI checks, even when other windows cover it
# (PrintWindow with PW_RENDERFULLCONTENT). The desktop app's process is ChatGPT.exe inside the OpenAI.Codex package.
# Input: -Out <path.png>. Output: the PNG file and one line with its size.
param([Parameter(Mandatory = $true)] [string] $Out)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CamWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
# Physical pixels, so the window is not cropped on scaled displays.
[void][CamWindow]::SetProcessDPIAware()

$process = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*\OpenAI.Codex_*' } | Select-Object -First 1
if (-not $process) { throw 'Codex Desktop window not found' }
$handle = $process.MainWindowHandle
if ([CamWindow]::IsIconic($handle)) { throw 'the Codex window is minimized' }

$rect = New-Object CamWindow+RECT
[void][CamWindow]::GetWindowRect($handle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
# 2 = PW_RENDERFULLCONTENT: needed for Chromium/Electron content.
$rendered = [CamWindow]::PrintWindow($handle, $hdc, 2)
$graphics.ReleaseHdc($hdc)
$graphics.Dispose()
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
"{0}x{1} rendered={2}" -f $width, $height, $rendered
