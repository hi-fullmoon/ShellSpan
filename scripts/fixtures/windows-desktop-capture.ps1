param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShellSpanCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
}
'@
$own = @(Get-Process -Name ShellSpan -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable -and $_.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId -and $_.MainWindowHandle -ne 0 })
if ($own.Count -ne 1) { throw 'Expected one owned interactive ShellSpan window' }
$window = $own[0]
if ([ShellSpanCapture]::GetForegroundWindow() -ne $window.MainWindowHandle) { throw 'Owned window is not foreground; no other desktop content captured' }
$previousDpi=[ShellSpanCapture]::SetThreadDpiAwarenessContext([IntPtr](-4))
if($previousDpi-eq [IntPtr]::Zero){throw 'Physical window DPI context unavailable'}
$rect = New-Object ShellSpanCapture+Rect
if (-not [ShellSpanCapture]::GetWindowRect($window.MainWindowHandle,[ref]$rect)) { throw 'Owned window bounds unavailable' }
$width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
if ($width -lt 100 -or $height -lt 100) { throw 'Invalid owned window size' }
$bitmap = New-Object Drawing.Bitmap($width,$height)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
    $bitmap.Save($Output,[Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
$stream=[IO.File]::OpenRead($Output)
$algorithm=[Security.Cryptography.SHA256]::Create()
try { $digest=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
finally { $algorithm.Dispose(); $stream.Dispose(); $null=[ShellSpanCapture]::SetThreadDpiAwarenessContext($previousDpi) }
@{ pid=$window.Id; sessionId=$window.SessionId; window=$window.MainWindowHandle.ToInt64(); width=$width; height=$height; image=$Output; sha256=$digest } | ConvertTo-Json -Compress
