// Output-only adapter: output uses the current native host; background jobs
// cannot prompt, consume console keys or request that the parent shell exit.
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Language;
using System.Security;

public sealed class ShellSpanJobHost : PSHost {
    public static ScriptBlock InstrumentSource(string source) {
        Token[] tokens;
        ParseError[] errors;
        ScriptBlockAst ast = Parser.ParseInput(source, out tokens, out errors);
        if (errors.Length != 0 || ast.ScriptRequirements != null ||
            (typeof(ScriptBlockAst).GetProperty("CleanBlock") != null &&
             typeof(ScriptBlockAst).GetProperty("CleanBlock").GetValue(ast, null) != null)) {
            throw new NotSupportedException("Native jobs do not support script requirements or clean blocks");
        }
        var usingStatements = new List<UsingStatementAst>();
        foreach (var item in ast.UsingStatements) usingStatements.Add((UsingStatementAst)item.Copy());
        var attributes = new List<AttributeAst>();
        foreach (var item in ast.Attributes) attributes.Add((AttributeAst)item.Copy());
        return new ScriptBlockAst(ast.Extent, usingStatements, attributes,
            ast.ParamBlock == null ? null : (ParamBlockAst)ast.ParamBlock.Copy(),
            InstrumentBlock(ast.BeginBlock), InstrumentBlock(ast.ProcessBlock),
            InstrumentBlock(ast.EndBlock), InstrumentBlock(ast.DynamicParamBlock)).GetScriptBlock();
    }
    private static NamedBlockAst InstrumentBlock(NamedBlockAst block) {
        if (block == null) return null;
        var statements = new List<StatementAst>();
        foreach (var item in block.Statements) statements.Add((StatementAst)item.Copy());
        var traps = new List<TrapStatementAst>();
        if (block.Traps != null) foreach (var item in block.Traps) traps.Add((TrapStatementAst)item.Copy());
        Token[] tokens;
        ParseError[] errors;
        var capture = (TryStatementAst)Parser.ParseInput(
            "try {} finally { $__shellspanJobState.SourceSucceeded = $?; $__shellspanJobState.SourceNativeExitCode = $global:LASTEXITCODE; $__shellspanJobState.SourceNativeInvocations = $__shellspanJobState.NativeInvocations; $__shellspanJobState.SourceLastCmdletErrorNativeCount = $__shellspanJobState.LastCmdletErrorNativeCount; $__shellspanJobState.SourceNativeTrackingTrusted = $__shellspanJobState.NativeTrackingTrusted; $__shellspanJobState.SourceReturned = $true }",
            out tokens, out errors).EndBlock.Statements[0];
        var guarded = new TryStatementAst(block.Extent,
            new StatementBlockAst(block.Extent, statements, traps),
            new CatchClauseAst[0], (StatementBlockAst)capture.Finally.Copy());
        return new NamedBlockAst(block.Extent, block.BlockKind,
            new StatementBlockAst(block.Extent, new StatementAst[] { guarded }, null), block.Unnamed);
    }
    private readonly PSHost original;
    private readonly PSHostUserInterface ui;
    private readonly Guid id = Guid.NewGuid();
    public int? ExitCode { get; private set; }
    public ShellSpanJobHost(PSHost host) { original = host; ui = new ShellSpanJobUI(host.UI); }
    public override Guid InstanceId { get { return id; } }
    public override string Name { get { return "ShellSpanNativeJob"; } }
    public override Version Version { get { return original.Version; } }
    public override PSHostUserInterface UI { get { return ui; } }
    public override CultureInfo CurrentCulture { get { return original.CurrentCulture; } }
    public override CultureInfo CurrentUICulture { get { return original.CurrentUICulture; } }
    public override void SetShouldExit(int code) { ExitCode = code; }
    public override void EnterNestedPrompt() { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override void ExitNestedPrompt() { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override void NotifyBeginApplication() { }
    public override void NotifyEndApplication() { }
}

public sealed class ShellSpanJobUI : PSHostUserInterface {
    private readonly PSHostUserInterface ui;
    private readonly PSHostRawUserInterface raw;
    public ShellSpanJobUI(PSHostUserInterface original) { ui = original; raw = new ShellSpanJobRawUI(original.RawUI); }
    public override PSHostRawUserInterface RawUI { get { return raw; } }
    public override string ReadLine() { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override SecureString ReadLineAsSecureString() { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override Dictionary<string, PSObject> Prompt(string caption, string message, Collection<FieldDescription> fields) { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override int PromptForChoice(string caption, string message, Collection<ChoiceDescription> choices, int choice) { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override PSCredential PromptForCredential(string caption, string message, string user, string target) { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override PSCredential PromptForCredential(string caption, string message, string user, string target, PSCredentialTypes types, PSCredentialUIOptions options) { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override void Write(string text) { ui.Write(text); }
    public override void Write(ConsoleColor foreground, ConsoleColor background, string text) { ui.Write(foreground, background, text); }
    public override void WriteLine(string text) { ui.WriteLine(text); }
    public override void WriteErrorLine(string text) { ui.WriteErrorLine(text); }
    public override void WriteDebugLine(string text) { ui.WriteDebugLine(text); }
    public override void WriteVerboseLine(string text) { ui.WriteVerboseLine(text); }
    public override void WriteWarningLine(string text) { ui.WriteWarningLine(text); }
    public override void WriteProgress(long source, ProgressRecord record) { ui.WriteProgress(source, record); }
}

public sealed class ShellSpanJobRawUI : PSHostRawUserInterface {
    private readonly PSHostRawUserInterface ui;
    public ShellSpanJobRawUI(PSHostRawUserInterface original) { ui = original; }
    public override ConsoleColor BackgroundColor { get { return ui.BackgroundColor; } set { ui.BackgroundColor = value; } }
    public override ConsoleColor ForegroundColor { get { return ui.ForegroundColor; } set { ui.ForegroundColor = value; } }
    public override Size BufferSize { get { return ui.BufferSize; } set { ui.BufferSize = value; } }
    public override Coordinates CursorPosition { get { return ui.CursorPosition; } set { ui.CursorPosition = value; } }
    public override int CursorSize { get { return ui.CursorSize; } set { ui.CursorSize = value; } }
    public override bool KeyAvailable { get { return false; } }
    public override Size MaxPhysicalWindowSize { get { return ui.MaxPhysicalWindowSize; } }
    public override Size MaxWindowSize { get { return ui.MaxWindowSize; } }
    public override Coordinates WindowPosition { get { return ui.WindowPosition; } set { ui.WindowPosition = value; } }
    public override Size WindowSize { get { return ui.WindowSize; } set { ui.WindowSize = value; } }
    public override string WindowTitle { get { return ui.WindowTitle; } set { ui.WindowTitle = value; } }
    public override void FlushInputBuffer() { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override KeyInfo ReadKey(ReadKeyOptions options) { throw new NotSupportedException("Background job stdin is unavailable"); }
    public override BufferCell[,] GetBufferContents(Rectangle rectangle) { return ui.GetBufferContents(rectangle); }
    public override void SetBufferContents(Coordinates origin, BufferCell[,] contents) { ui.SetBufferContents(origin, contents); }
    public override void SetBufferContents(Rectangle rectangle, BufferCell fill) { ui.SetBufferContents(rectangle, fill); }
    public override void ScrollBufferContents(Rectangle source, Coordinates destination, Rectangle clip, BufferCell fill) { ui.ScrollBufferContents(source, destination, clip, fill); }
}

// One console-attached worker per background job. Only this owned process is
// assigned, before source/state is sent. Ordinary CreateProcess descendants
// inherit its Windows Job Object; no process enumeration grants kill authority.
public sealed class ShellSpanReferenceComparer : IEqualityComparer<object> {
    public new bool Equals(object left, object right) { return object.ReferenceEquals(left, right); }
    public int GetHashCode(object value) { return System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(value); }
}

// Public debugger invocation metadata identifies resolved native applications,
// including aliases and dynamic invocation. It never reevaluates source text.
public sealed class ShellSpanNativeStatusTracker : IDisposable {
    private readonly System.Management.Automation.Runspaces.Runspace runspace;
    private readonly System.Collections.Hashtable state;
    public ShellSpanNativeStatusTracker(System.Management.Automation.Runspaces.Runspace value, System.Collections.Hashtable snapshot) {
        runspace = value; state = snapshot;
        runspace.Debugger.SetDebugMode(DebugModes.LocalScript);
        runspace.Debugger.DebuggerStop += OnStop;
        runspace.Debugger.BreakpointUpdated += OnBreakpointUpdated;
    }
    private void OnStop(object sender, DebuggerStopEventArgs args) {
        bool owned = args.Breakpoints.Count != 0;
        foreach (Breakpoint breakpoint in args.Breakpoints)
            if (state["NativeBreakpointId"] == null || breakpoint.Id != (int)state["NativeBreakpointId"]) owned = false;
        if (!owned) {
            state["NativeTrackingTrusted"] = false;
            args.ResumeAction = DebuggerResumeAction.Stop;
            return;
        }
        if ((bool)state["TrackingActive"] && args.InvocationInfo.MyCommand is ApplicationInfo)
            state["NativeInvocations"] = (int)state["NativeInvocations"] + 1;
        args.ResumeAction = DebuggerResumeAction.Continue;
    }
    private void OnBreakpointUpdated(object sender, BreakpointUpdatedEventArgs args) {
        if (state["NativeBreakpointId"] != null && args.Breakpoint.Id == (int)state["NativeBreakpointId"] &&
            (args.UpdateType == BreakpointUpdateType.Removed || args.UpdateType == BreakpointUpdateType.Disabled))
            state["NativeTrackingTrusted"] = false;
    }
    public void Dispose() {
        runspace.Debugger.DebuggerStop -= OnStop;
        runspace.Debugger.BreakpointUpdated -= OnBreakpointUpdated;
    }
}

[Cmdlet(VerbsDiagnostic.Trace, "ShellSpanJobStatus")]
public sealed class ShellSpanJobStatus : PSCmdlet {
    [Parameter(ValueFromPipeline=true)] public PSObject InputObject {get;set;}
    [Parameter(Mandatory=true)] public System.Collections.Hashtable State {get;set;}
    protected override void ProcessRecord() {
        ErrorRecord error = InputObject == null ? null : InputObject.BaseObject as ErrorRecord;
        bool native = error != null && ((error.InvocationInfo != null && error.InvocationInfo.MyCommand is ApplicationInfo) ||
            (error.Exception != null && error.Exception.GetType().Assembly == typeof(PSObject).Assembly &&
             error.Exception.GetType().FullName == "System.Management.Automation.NativeCommandExitException"));
        if (error != null && (bool)State["TrackingActive"] && !native)
            State["LastCmdletErrorNativeCount"] = (int)State["NativeInvocations"];
        WriteObject(InputObject, false);
    }
}
public sealed class ShellSpanProcessJob : IDisposable {
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint length);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool TerminateJobObject(IntPtr job, uint status);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint id);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct BasicLimit {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct ExtendedLimit {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    private IntPtr job;
    private System.Diagnostics.Process process;
    private System.IO.Pipes.NamedPipeServerStream pipe;
    private System.Threading.Tasks.Task<string> result;
    private bool assigned;
    public Guid InstanceId { get; private set; }
    public bool StopRequested { get; private set; }
    public ShellSpanProcessJob(string executable, string directory, string packet) {
        InstanceId = Guid.NewGuid();
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(packet);
        if (bytes.Length > 16777216) throw new NotSupportedException("Native worker state exceeds 16 MiB");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            var limits = new ExtendedLimit();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = System.Runtime.InteropServices.Marshal.SizeOf(typeof(ExtendedLimit));
            IntPtr memory = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
            try {
                System.Runtime.InteropServices.Marshal.StructureToPtr(limits, memory, false);
                if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw new System.ComponentModel.Win32Exception();
            } finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(memory); }
            string name = "shellspan-job-" + System.Diagnostics.Process.GetCurrentProcess().Id + "-" + Guid.NewGuid().ToString("N");
            pipe = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 1,
                System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous);
            // No user source, state or credentials occur in the process args.
            string bootstrap = "$ErrorActionPreference='Stop';$p=[IO.Pipes.NamedPipeClientStream]::new('.', '" + name +
                "',[IO.Pipes.PipeDirection]::InOut);$p.Connect(15000);$r=[IO.BinaryReader]::new($p);" +
                "$n=$r.ReadInt32();if($n-lt 0-or $n-gt 16777216){throw 'Invalid worker packet'};" +
                "$b=$r.ReadBytes($n);if($b.Length-ne $n){throw 'Incomplete worker packet'};" +
                "$packet=[Management.Automation.PSSerializer]::Deserialize([Text.Encoding]::UTF8.GetString($b));" +
                "& ([scriptblock]::Create($packet.Worker)) $packet $p";
            var start = new System.Diagnostics.ProcessStartInfo(executable,
                "-NoLogo -NoProfile -NonInteractive -EncodedCommand " + Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(bootstrap)));
            start.UseShellExecute = false;
            start.CreateNoWindow = false;
            // stdout/stderr retain the current ConPTY handles. Stdin is closed
            // so Console.ReadLine cannot consume the user's terminal draft.
            start.RedirectStandardInput = true;
            start.WorkingDirectory = directory;
            IAsyncResult connected = pipe.BeginWaitForConnection(null, null);
            process = System.Diagnostics.Process.Start(start);
            process.StandardInput.Close();
            if (!AssignProcessToJobObject(job, process.Handle)) throw new System.ComponentModel.Win32Exception();
            assigned = true;
            try {
                if (!connected.AsyncWaitHandle.WaitOne(Math.Max(0, 5000 - (int)clock.ElapsedMilliseconds))) throw new TimeoutException("Native worker connection timed out");
                pipe.EndWaitForConnection(connected);
            } finally { connected.AsyncWaitHandle.Close(); }
            uint client;
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out client) || client != (uint)process.Id)
                throw new InvalidOperationException("Unexpected native worker pipe client");
            var writing = System.Threading.Tasks.Task.Factory.StartNew(() => {
                var writer = new System.IO.BinaryWriter(pipe, System.Text.Encoding.UTF8, true);
                writer.Write(bytes.Length); writer.Write(bytes); writer.Flush();
            }, System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning,
                System.Threading.Tasks.TaskScheduler.Default);
            if (!writing.Wait(Math.Max(0, 5000 - (int)clock.ElapsedMilliseconds))) throw new TimeoutException("Native worker state delivery timed out");
            writing.GetAwaiter().GetResult();
            var ready = System.Threading.Tasks.Task.Factory.StartNew(() => pipe.ReadByte(),
                System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning,
                System.Threading.Tasks.TaskScheduler.Default);
            if (!ready.Wait(Math.Max(0, 5000 - (int)clock.ElapsedMilliseconds)) || ready.GetAwaiter().GetResult() != 0xA1)
                throw new InvalidOperationException("Native worker did not establish console control isolation");
            result = System.Threading.Tasks.Task.Factory.StartNew<string>(() => {
                var reader = new System.IO.BinaryReader(pipe, System.Text.Encoding.UTF8, true);
                int count = reader.ReadInt32();
                if (count < 0 || count > 1048576) throw new InvalidOperationException("Invalid native worker result");
                byte[] value = reader.ReadBytes(count);
                if (value.Length != count) throw new System.IO.EndOfStreamException();
                return System.Text.Encoding.UTF8.GetString(value);
            }, System.Threading.CancellationToken.None, System.Threading.Tasks.TaskCreationOptions.LongRunning,
                System.Threading.Tasks.TaskScheduler.Default);
        } catch (Exception failure) {
            // Preserve real cleanup evidence before closing the only group
            // handle. No source text or variable payload enters diagnostics.
            bool confirmed = process == null;
            try {
                if (process != null) {
                    failure.Data["NativeWorkerProcessId"] = process.Id;
                    if (assigned) {
                        if (!TerminateJobObject(job, 137)) throw new System.ComponentModel.Win32Exception();
                    } else if (!process.HasExited) { process.Kill(); }
                    var cleanup = System.Diagnostics.Stopwatch.StartNew();
                    process.WaitForExit(2000);
                    while (assigned && ActiveProcesses != 0 && cleanup.ElapsedMilliseconds < 2000)
                        System.Threading.Thread.Sleep(10);
                    confirmed = process.HasExited && (!assigned || ActiveProcesses == 0);
                }
            } catch (System.ComponentModel.Win32Exception) { confirmed = false; }
              catch (InvalidOperationException) { confirmed = false; }
            failure.Data["NativeWorkerCleanupConfirmed"] = confirmed;
            Dispose();
            throw;
        }
    }
    public int ActiveProcesses {
        get {
            Accounting value;
            if (!QueryInformationJobObject(job, 1, out value,
                (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                throw new System.ComponentModel.Win32Exception();
            return checked((int)value.ActiveProcesses);
        }
    }
    public bool HasExited { get { return process.HasExited; } }
    public bool ResultReady { get { return result != null && result.IsCompleted; } }
    public string ReadResult() { return result.GetAwaiter().GetResult(); }
    public void Stop() {
        StopRequested = true;
        if (!TerminateJobObject(job, 137)) throw new System.ComponentModel.Win32Exception();
    }
    public void Dispose() {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        // Assignment failure precedes packet delivery. Close the one owned
        // bootstrap process too; it has not received any user source.
        if (!assigned && process != null) {
            try { if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } } catch (System.ComponentModel.Win32Exception) { } catch (InvalidOperationException) { }
        }
        if (pipe != null) { pipe.Dispose(); pipe = null; }
        if (process != null) { process.Dispose(); process = null; }
        GC.SuppressFinalize(this);
    }
    ~ShellSpanProcessJob() { Dispose(); }
}
