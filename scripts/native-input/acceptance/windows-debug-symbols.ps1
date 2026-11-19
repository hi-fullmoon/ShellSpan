param([Parameter(Mandatory=$true)][string]$Image,[Parameter(Mandatory=$true)][string]$Symbols,[Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][uint32]$Line,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedImageSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPdbSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceSha256)
$ErrorActionPreference='Stop'
foreach($module in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security','Microsoft.PowerShell.Management')){
  Import-Module (Join-Path $PSHOME ('Modules/'+$module+'/'+$module+'.psd1')) -ErrorAction Stop
}
$pdb=Join-Path $Symbols ([IO.Path]::GetFileNameWithoutExtension($Image)+'.pdb')
foreach($item in @(@($Image,$ExpectedImageSha256),@($pdb,$ExpectedPdbSha256),@($Source,$ExpectedSourceSha256))){
  if(-not [IO.Path]::IsPathRooted($item[0]) -or (Get-FileHash -LiteralPath $item[0] -Algorithm SHA256).Hash.ToLowerInvariant()-ne $item[1]){throw 'Frozen symbol input identity changed'}
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class FrozenLineSymbols {
  [StructLayout(LayoutKind.Sequential)] public struct ImageLine {
    public uint SizeOfStruct; public IntPtr Key; public uint LineNumber; public IntPtr FileName; public ulong Address;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Ansi)] public struct SourceLine {
    public uint SizeOfStruct; public IntPtr Key; public ulong ModBase;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=261)] public string Obj;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=261)] public string FileName;
    public uint LineNumber; public ulong Address;
  }
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate bool LineCallback(IntPtr line,IntPtr context);
  [DllImport("dbghelp.dll",SetLastError=true,CharSet=CharSet.Ansi)] static extern bool SymInitialize(IntPtr process,string search,bool invade);
  [DllImport("dbghelp.dll",SetLastError=true)] static extern bool SymCleanup(IntPtr process);
  [DllImport("dbghelp.dll")] static extern uint SymSetOptions(uint options);
  [DllImport("dbghelp.dll",SetLastError=true,CharSet=CharSet.Ansi)] static extern ulong SymLoadModuleEx(IntPtr process,IntPtr file,string image,string module,ulong address,uint size,IntPtr data,uint flags);
  [DllImport("dbghelp.dll",SetLastError=true,CharSet=CharSet.Ansi)] static extern bool SymGetLineFromName64(IntPtr process,string module,string file,uint line,out int displacement,ref ImageLine result);
  [DllImport("dbghelp.dll",SetLastError=true,CharSet=CharSet.Ansi)] static extern bool SymEnumLines(IntPtr process,ulong basis,string obj,string file,LineCallback callback,IntPtr context);
  public static object Resolve(string image,string symbols,string source,uint number) {
    using(var process=Process.GetCurrentProcess()) {
      IntPtr handle=process.Handle;
      // Exact local PDB only; no load-anything flag, symbol server or UI prompt.
      SymSetOptions(0x00000400|0x00000200|0x00001000|0x00080000|0x00000010|0x00000080);
      if(!SymInitialize(handle,symbols,false))throw new Win32Exception(Marshal.GetLastWin32Error(),"SymInitialize failed");
      try {
        ulong basis=0x180000000;
        ulong loaded=SymLoadModuleEx(handle,IntPtr.Zero,image,"frozen",basis,0,IntPtr.Zero,0);
        if(loaded==0)throw new Win32Exception(Marshal.GetLastWin32Error(),"Exact PDB load failed");
        var line=new ImageLine();line.SizeOfStruct=(uint)Marshal.SizeOf(typeof(ImageLine));int displacement;
        if(!SymGetLineFromName64(handle,"frozen",source,number,out displacement,ref line))throw new Win32Exception(Marshal.GetLastWin32Error(),"Source line resolution failed");
        if(line.LineNumber!=number||line.Address<loaded||displacement!=0||
          !String.Equals(System.IO.Path.GetFullPath(Marshal.PtrToStringAnsi(line.FileName)),System.IO.Path.GetFullPath(source),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Exact source line did not resolve");
        var addresses=new SortedSet<ulong>();
        LineCallback callback=delegate(IntPtr pointer,IntPtr context) {
          var item=(SourceLine)Marshal.PtrToStructure(pointer,typeof(SourceLine));
          if(item.LineNumber==number&&item.Address>=loaded&&String.Equals(item.FileName,source,StringComparison.OrdinalIgnoreCase))addresses.Add(item.Address-loaded);
          return true;
        };
        if(!SymEnumLines(handle,loaded,null,source,callback,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error(),"Exact line enumeration failed");
        GC.KeepAlive(callback);
        if(!addresses.Contains(line.Address-loaded))throw new InvalidOperationException("Resolved line not present in exact PDB enumeration");
        var rvas=new List<string>();foreach(ulong address in addresses)rvas.Add(address.ToString("x"));
        return new {line=(uint)line.LineNumber,file=Marshal.PtrToStringAnsi(line.FileName),rva=(line.Address-loaded).ToString("x"),rvas=rvas.ToArray(),displacement=displacement};
      } finally {SymCleanup(handle);}
    }
  }
}
'@
[FrozenLineSymbols]::Resolve([IO.Path]::GetFullPath($Image),[IO.Path]::GetFullPath($Symbols),[IO.Path]::GetFullPath($Source),$Line) | ConvertTo-Json -Compress
