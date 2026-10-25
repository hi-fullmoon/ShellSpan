param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference='Stop'
if(-not $InputFile){throw 'Native input requires an owned packet'}
$packet=Get-Content -LiteralPath $InputFile -Raw -Encoding utf8|ConvertFrom-Json
if($packet.text-isnot [string]-or $packet.text.Length-gt 8192-or $packet.text-match '[\x00-\x09\x0b-\x1f\x7f]'){throw 'Unsupported native keyboard input'}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ShellSpanDesktopTyping {
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Payload { [FieldOffset(0)] public Keyboard Keyboard; [FieldOffset(0)] public Mouse Mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public Payload Payload; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll",SetLastError=true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
  private static Input Key(ushort key,ushort scan,uint flags) { return new Input { Type=1, Payload=new Payload { Keyboard=new Keyboard { Key=key,Scan=scan,Flags=flags } } }; }
  private static bool OwnsForeground(IntPtr window,uint process) {
    uint owner;
    return GetForegroundWindow()==window && GetWindowThreadProcessId(window,out owner)!=0 && owner==process;
  }
  public static int Type(IntPtr window,uint process,string text) {
    if(!OwnsForeground(window,process)) throw new InvalidOperationException("Owned window is not foreground");
    var keys=new List<Input>();
    foreach(char c in text) {
      if(c=='\n') {
        keys.Add(Key(0x10,0,0)); keys.Add(Key(0x0d,0,0)); keys.Add(Key(0x0d,0,2)); keys.Add(Key(0x10,0,2));
      } else { keys.Add(Key(0,c,4)); keys.Add(Key(0,c,6)); }
    }
    uint delivered=SendInput((uint)keys.Count,keys.ToArray(),Marshal.SizeOf(typeof(Input)));
    if(delivered!=keys.Count) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Native keyboard input was not fully delivered");
    if(!OwnsForeground(window,process)) throw new InvalidOperationException("Owned window lost foreground during keyboard input");
    return keys.Count;
  }
}
'@
$own=@(Get-Process -Name ShellSpan -ErrorAction SilentlyContinue|Where-Object {$_.Path-eq $Executable-and $_.SessionId-eq [Diagnostics.Process]::GetCurrentProcess().SessionId-and $_.MainWindowHandle-ne 0})
if($own.Count-ne 1){throw 'Expected one owned interactive ShellSpan window'}
$count=[ShellSpanDesktopTyping]::Type($own[0].MainWindowHandle,[uint32]$own[0].Id,$packet.text)
@{kind='native-user-keyboard-input';pid=$own[0].Id;sessionId=$own[0].SessionId;inputEvents=$count}|ConvertTo-Json -Compress
