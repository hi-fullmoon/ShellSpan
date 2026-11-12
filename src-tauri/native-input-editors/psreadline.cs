// Data transport and the Rust producer ABI only. PSReadLine APIs are invoked
// synchronously by the PowerShell widgets on their original editor thread.
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Management.Automation.Language;
using Microsoft.Win32.SafeHandles;

public sealed class ShellSpanNativeEditor : IDisposable {
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr LoadLibraryW(string path);
    [DllImport("kernel32", CharSet=CharSet.Ansi, ExactSpelling=true, SetLastError=true)]
    static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool PeekNamedPipe(SafePipeHandle handle, IntPtr buffer, uint size,
        IntPtr read, out uint available, IntPtr remaining);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool GetNamedPipeClientProcessId(SafePipeHandle handle,out uint processId);
    [DllImport("kernel32", SetLastError=true)]
    static extern bool GetHandleInformation(SafePipeHandle handle,out uint flags);
    const string Library = "shellspan_native_input_editors.dll";
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern IntPtr ss_editor_new(byte[] profile, int supported);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_receive(IntPtr context, byte[] bytes, UIntPtr size);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_observe(IntPtr context, byte[] text, UIntPtr cursor);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_action(IntPtr context);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern IntPtr ss_editor_text(IntPtr context);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern UIntPtr ss_editor_string_size(IntPtr context);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern IntPtr ss_editor_plan(IntPtr context, byte[] text);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_host_plan(IntPtr context,byte[] text);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern IntPtr ss_editor_job(IntPtr context,int field);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_job_observation(IntPtr context,byte[] handle,byte[] state,int status,int hasStatus);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern IntPtr ss_editor_marker(IntPtr context, int end);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_event(IntPtr context, int kind, int status, byte[] cwd);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_guarded_handoff(IntPtr context);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_eof_owned_chars(IntPtr context, byte[] text, UIntPtr cursor);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern int ss_editor_eof_cleared(IntPtr context, byte[] text, UIntPtr cursor);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern IntPtr ss_editor_output(IntPtr context, out UIntPtr size);
    [DllImport(Library, CallingConvention=CallingConvention.Cdecl)]
    static extern void ss_editor_drop(IntPtr context);
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false,true);
    readonly NamedPipeServerStream pipe;
    IntPtr context;
    readonly int thread;
    bool controlClosed;
    IDisposable displayOrigin;
    static void VerifyNativeExports(IntPtr module) {
        int count=0;
        foreach(var method in typeof(ShellSpanNativeEditor).GetMethods(System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static)) {
            var import=(DllImportAttribute)Attribute.GetCustomAttribute(method,typeof(DllImportAttribute));
            if(import==null || !String.Equals(import.Value,Library,StringComparison.Ordinal)) continue;
            string entry=String.IsNullOrEmpty(import.EntryPoint)?method.Name:import.EntryPoint;
            if(GetProcAddress(module,entry)==IntPtr.Zero) throw new IOException("TERMINAL_NATIVE_REQUIRED_SYMBOL_UNAVAILABLE:"+entry);
            count++;
        }
        if(count==0) throw new IOException("TERMINAL_NATIVE_REQUIRED_SYMBOL_UNAVAILABLE:ABI");
    }
    public ShellSpanNativeEditor(string library, NamedPipeServerStream privatePipe, uint expectedClient, string profile, bool supported) {
        IntPtr module=LoadLibraryW(library);
        if(module==IntPtr.Zero) throw new IOException("Native editor library unavailable");
        try { VerifyNativeExports(module); }
        catch { FreeLibrary(module); throw; }
        thread=System.Threading.Thread.CurrentThread.ManagedThreadId;
        context=ss_editor_new(Z(profile),supported?1:0);
        if(context==IntPtr.Zero) throw new IOException("Native editor profile invalid");
        pipe=privatePipe;
        var connected=pipe.BeginWaitForConnection(null,null);
        if(!connected.AsyncWaitHandle.WaitOne(5000)) { pipe.Dispose(); throw new TimeoutException("Native control connection expired"); }
        pipe.EndWaitForConnection(connected);
        uint handleFlags;
        if(!GetHandleInformation(pipe.SafePipeHandle,out handleFlags)||(handleFlags&1)!=0){pipe.Dispose();throw new IOException("Native control handle is inheritable");}
        uint client;
        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out client) || client!=expectedClient) {
            pipe.Dispose(); throw new IOException("Native private peer identity mismatch");
        }
    }
    static byte[] Z(string value) { if(value.IndexOf('\0')>=0)throw new IOException("Native string contains NUL");return Utf8.GetBytes(value+"\0"); }
    string S(IntPtr pointer) {
        if(pointer==IntPtr.Zero) return null;
        ulong size=ss_editor_string_size(context).ToUInt64();if(size>131072)throw new IOException("Native data limit");int length=checked((int)size);
        var bytes=new byte[length]; Marshal.Copy(pointer,bytes,0,length); return Utf8.GetString(bytes);
    }
    void Check() { if(context==IntPtr.Zero || thread!=System.Threading.Thread.CurrentThread.ManagedThreadId) throw new IOException("Native editor thread changed"); }
    public void Observe(string buffer,int cursor) {
        Check();
        if(cursor<0 || cursor>buffer.Length || (cursor>0 && cursor<buffer.Length && char.IsHighSurrogate(buffer[cursor-1]) && char.IsLowSurrogate(buffer[cursor])))
            throw new IOException("Native cursor is not a Unicode boundary");
        if(ss_editor_observe(context,Z(buffer),(UIntPtr)Utf8.GetByteCount(buffer.Substring(0,cursor)))!=1)
            throw new IOException("Native editor observation rejected");
    }
    public void Pump(string buffer,int cursor) {
        Check();
        try {
            Observe(buffer,cursor);
            uint available;
            while(true) {
                if(!PeekNamedPipe(pipe.SafePipeHandle,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero))
                    throw new IOException("Native private control closed");
                if(available==0) break;
                var bytes=new byte[Math.Min(available,8192)];
                int count=pipe.Read(bytes,0,bytes.Length);
                if(count==0 || ss_editor_receive(context,bytes,(UIntPtr)count)!=1) throw new IOException("Native private protocol rejected");
            }
            Flush();
        } catch {
            // PSReadLine may catch a custom key-handler exception and continue
            // its editor loop. Close here so the backend observes the failure.
            Fail();
            throw;
        }
    }
    public int Action() { Check(); return ss_editor_action(context); }
    public string Text() { Check(); return S(ss_editor_text(context)); }
    public bool Event(int kind,int status,string cwd) { Check(); bool result=ss_editor_event(context,kind,status,cwd==null?null:Z(cwd))==1; Flush(); return result; }
    public int AcceptFailureReason() { Check(); return ss_editor_event(context,16,0,null); }
    public int PrepareElapsedMilliseconds() { Check(); return ss_editor_event(context,17,0,null); }
    public string Plan(string actual) { Check(); return actual==null?null:S(ss_editor_plan(context,Z(actual))); }
    public bool SetHostPlan(string plan) { Check(); return plan!=null && ss_editor_host_plan(context,Z(plan))==1; }
    public static string BuildHostPlan(string source) {
        Token[] tokens;ParseError[] errors;
        var ast=Parser.ParseInput(source,out tokens,out errors);
        if(errors.Length!=0)return null;
        NamedBlockAst block=ast.DynamicParamBlock??ast.BeginBlock??ast.ProcessBlock??ast.EndBlock;
        if(block==null) {
            var clean=typeof(ScriptBlockAst).GetProperty("CleanBlock");
            if(clean!=null)block=clean.GetValue(ast,null) as NamedBlockAst;
        }
        int position=source.Length;
        if(block!=null && block.Statements.Count>0)position=block.Statements[0].Extent.StartOffset;
        else if(block!=null && !block.Unnamed) {
            bool found=false;
            foreach(var token in tokens)if(token.Kind==TokenKind.RCurly && token.Extent.EndOffset==block.Extent.EndOffset){position=token.Extent.StartOffset;found=true;break;}
            if(!found)return null;
        }
        // Insertion offsets come from PowerShell's public AST/token extents.
        // using/attributes/param/named blocks stay in the original host scope.
        string plan=source.Insert(position,"\n__shellspan_nip_begin -PreviousSuccess $? -ErrorAction Ignore;\n");
        Parser.ParseInput(plan,out tokens,out errors);
        return errors.Length==0?plan:null;
    }
    public bool RequiresHandoff() {
        Check(); int state=ss_editor_event(context,15,0,null);
        if(state<0)throw new IOException("Native editor thread changed");
        return state==1 || ss_editor_guarded_handoff(context)==1;
    }
    public bool CanClearFailedDraft(string buffer,int cursor) {
        Check();
        if(!controlClosed || cursor!=buffer.Length) return false;
        byte[] bytes=Z(buffer); // Strict UTF-8 conversion rejects lone surrogates.
        int scalars=0;
        for(int index=0;index<cursor;index++,scalars++)
            if(char.IsHighSurrogate(buffer[index])) index++;
        return ss_editor_eof_owned_chars(context,bytes,(UIntPtr)scalars)==1;
    }
    public bool ConfirmFailedDraftCleared(string buffer,int cursor) {
        Check();
        return controlClosed && buffer.Length==0 && cursor==0 &&
            ss_editor_eof_cleared(context,Z(buffer),UIntPtr.Zero)==1;
    }
    public bool ControlClosed { get { Check(); return controlClosed; } }
    public bool BindReadLineInitialized(System.Reflection.Assembly editor) {
        Check();
        var lifecycle=editor.GetType("Microsoft.PowerShell.ShellSpanEditorLifecycle",false);
        var configure=lifecycle==null?null:lifecycle.GetMethod("Configure",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic);
        var reader=editor.GetType("Microsoft.PowerShell.PSConsoleReadLine",false);
        var read=reader==null?null:reader.GetMethod("GetBufferState",new Type[]{typeof(string).MakeByRefType(),typeof(int).MakeByRefType()});
        if(configure==null||read==null)return false;
        configure.Invoke(null,new object[]{new Action(()=>{
            if(context==IntPtr.Zero)return;
            Check();
            if(!controlClosed)return;
            var arguments=new object[]{null,0};read.Invoke(null,arguments);
            if(!(arguments[0] is string)||!(arguments[1] is int))throw new IOException("Native editor observation unavailable");
            ConfirmFailedDraftCleared((string)arguments[0],(int)arguments[1]);
        })});
        return true;
    }
    public void AttachDisplayOrigin(IDisposable ownedOrigin) {
        Check();
        if(ownedOrigin==null) throw new ArgumentNullException("ownedOrigin");
        if(controlClosed || displayOrigin!=null) { ownedOrigin.Dispose(); throw new InvalidOperationException("Display endpoint unavailable"); }
        displayOrigin=ownedOrigin;
    }
    public void Fail() {
        Check();
        if(controlClosed) return;
        controlClosed=true;
        // NIP failure revokes control, not the still-live PTY's display service.
        // PSReadLine needs that independent read-only provider to clear a failed
        // draft and continue ordinary editing. Dispose closes both lifetimes.
        ss_editor_event(context,6,0,null);
        pipe.Dispose();
    }
    public string Job(int field) { Check(); return S(ss_editor_job(context,field)); }
    public void ObserveJob(string handle,string state,int? status) { Check(); if(ss_editor_job_observation(context,Z(handle),Z(state),status.GetValueOrDefault(),status.HasValue?1:0)!=1)throw new IOException("Native job observation rejected"); Flush(); }
    public string Marker(bool end) { Check(); return S(ss_editor_marker(context,end?1:0)); }
    public void Flush() {
        Check();
        if(controlClosed) return;
        try {
            UIntPtr size; IntPtr pointer;
            while((pointer=ss_editor_output(context,out size))!=IntPtr.Zero && size.ToUInt64()!=0) {
                int length=checked((int)size.ToUInt64()); var bytes=new byte[length]; Marshal.Copy(pointer,bytes,0,length);
                // The pipe owns its asynchronous I/O handles. Wait for the
                // task so fast completions cannot race a borrowed wait handle.
                if(!pipe.WriteAsync(bytes,0,length).Wait(1000)) throw new TimeoutException("Native control backpressure");
            }
            pipe.Flush();
        } catch {
            Fail();
            throw;
        }
    }
    public void Dispose() { if(context!=IntPtr.Zero) { Check(); if(displayOrigin!=null) { displayOrigin.Dispose(); displayOrigin=null; } ss_editor_drop(context); context=IntPtr.Zero; } pipe.Dispose(); }
}
