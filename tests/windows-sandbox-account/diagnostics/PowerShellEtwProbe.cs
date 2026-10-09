// Fixed diagnostic child for Windows PowerShell 5.1 initialization only.
// No script execution, logging bypass, arbitrary assembly or caller arguments.
using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Runtime.InteropServices;

internal static class PowerShellEtwProbe
{
    private const string AssemblyPath = @"C:\Windows\Microsoft.Net\assembly\GAC_MSIL\System.Management.Automation\v4.0_3.0.0.0__31bf3856ad364e35\System.Management.Automation.dll";
    private const string TypeName = "System.Management.Automation.Tracing.PSEtwLog";
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint EventRegister(ref Guid provider, IntPtr callback, IntPtr context, out ulong handle);
    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint EventUnregister(ulong handle);
    private static string NativeRegistration(string providerText)
    {
        Guid provider = new Guid(providerText);
        ulong handle;
        uint registered = EventRegister(ref provider, IntPtr.Zero, IntPtr.Zero, out handle);
        string unregistered = "null";
        if (handle != 0) unregistered = EventUnregister(handle).ToString();
        return "{\"provider\":" + Quote(providerText, 36) + ",\"register_code\":" + registered
            + ",\"handle_nonzero\":" + (handle != 0 ? "true" : "false") + ",\"unregister_code\":" + unregistered + "}";
    }
    private static string Quote(string text, int limit)
    {
        StringBuilder value = new StringBuilder("\"");
        if (text != null)
        {
            foreach (char character in text.Substring(0, Math.Min(text.Length, limit)))
            {
                if (character == '\\' || character == '"') value.Append('\\').Append(character);
                else if (char.IsControl(character)) value.Append("\\u").Append(((int)character).ToString("x4"));
                else value.Append(character);
            }
        }
        return value.Append('"').ToString();
    }
    private static int Main(string[] args)
    {
        if (args.Length != 0) return 2;
        Console.OutputEncoding = new UTF8Encoding(false);
        // Process-scope registration only: no manifest, session, write or ACL changes.
        string native = "[" + NativeRegistration("a0c1853b-5c40-4b15-8766-3cf1c58f985a")
            + "," + NativeRegistration("3229ad87-338e-4e53-85b4-f77f5f2c2a07") + "]";
        string stage = "load";
        string version = "";
        string mvid = "";
        Exception failure = null;
        try
        {
            Assembly assembly = Assembly.LoadFrom(AssemblyPath);
            version = assembly.FullName;
            mvid = assembly.ManifestModule.ModuleVersionId.ToString();
            stage = "type";
            Type type = assembly.GetType(TypeName, true);
            stage = "initializer";
            RuntimeHelpers.RunClassConstructor(type.TypeHandle);
            stage = "complete";
        }
        catch (Exception error) { failure = error; }
        StringBuilder chain = new StringBuilder("[");
        for (int index = 0; failure != null && index < 4; index++, failure = failure.InnerException)
        {
            if (index != 0) chain.Append(',');
            chain.Append("{\"type\":").Append(Quote(failure.GetType().FullName, 128))
                .Append(",\"hresult\":").Append(failure.HResult)
                .Append(",\"native_error\":").Append(failure is System.ComponentModel.Win32Exception
                    ? ((System.ComponentModel.Win32Exception)failure).NativeErrorCode.ToString() : "null")
                .Append(",\"message\":").Append(Quote(failure.Message, 256))
                .Append(",\"stack\":").Append(Quote(failure.StackTrace, 512)).Append('}');
        }
        chain.Append(']');
        string report = "{\"version\":1,\"scope\":\"fixed-powershell-etw-initializer\",\"assembly\":" + Quote(AssemblyPath, 512)
            + ",\"type\":" + Quote(TypeName, 128) + ",\"assembly_version\":" + Quote(version, 256)
            + ",\"mvid\":" + Quote(mvid, 64) + ",\"stage\":" + Quote(stage, 32)
            + ",\"initializer_succeeded\":" + (stage == "complete" ? "true" : "false")
            + ",\"chain_complete\":" + (failure == null ? "true" : "false") + ",\"exceptions\":" + chain
            + ",\"native_registrations\":" + native + "}";
        if (Encoding.UTF8.GetByteCount(report) > 16384) return 2;
        Console.WriteLine(report);
        // 73 means bounded diagnostic delivery, including initializer failure.
        return 73;
    }
}
