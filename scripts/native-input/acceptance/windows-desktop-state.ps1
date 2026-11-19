$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ShellSpanP3Desktop {
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int length,out int needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  public static string InputName() {
    var desktop=OpenInputDesktop(0,false,1);
    if(desktop==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {var value=new StringBuilder(256);int needed;
      if(!GetUserObjectInformation(desktop,2,value,value.Capacity*2,out needed))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return value.ToString();
    }finally {CloseDesktop(desktop);}
  }
}
'@
$session=[Diagnostics.Process]::GetCurrentProcess().SessionId
if($session-eq 0){throw 'Actual interactive desktop acceptance cannot run in Session 0'}
$desktop=[ShellSpanP3Desktop]::InputName()
@{at=(Get-Date).ToUniversalTime().ToString('o');sessionId=$session;inputDesktop=$desktop;pid=$PID}|ConvertTo-Json -Compress
if($desktop-cne 'Default'){throw 'The actual input desktop is locked or unavailable; manual user unlock is required'}
